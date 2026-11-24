import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build as buildVite, normalizePath } from 'vite'
import type { Rollup } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import type { QuirkyRuntimeService } from './quirky-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/omp-atomic-submit',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/omp-atomic-submit',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const PTY_ID = 'pty-prompt'

// Bundle the real writer and submit constant; external stubs avoid compiling the main-runtime graph.
const BUNDLED_WRITER_PATH = normalizePath(
  resolve(__dirname, 'terminal/input/terminal-agent-prompt.ts')
)
const BUNDLED_WRITER_EXTERNALS: Record<string, object> = {
  '../wait/terminal-wait-permission': {
    QuirkyRuntimeWithResolveAuthoritativeTerminalWaitPermission: class {}
  },
  '../../quirky-runtime-core': {
    assertAgentPromptRequestActive: () => {},
    waitForAgentPromptDelay: async () => {},
    waitForAgentPromptPromise: async (promise: Promise<unknown>) => await promise
  },
  '../../agent-prompt-submission-verification': {
    isTerminalSendSettlementAgent: () => false,
    resolveAgentPromptEffectTimeoutMs: () => 0,
    verifyAgentPromptSubmission: async () => {}
  }
}

type BundledWriter = {
  assertAgentPromptGeneration: () => void
  getAgentPromptActivity: () => {
    workingSequence: number
    explicitWorkingStartedAt: null
    permissionSequence: number
  }
  assertAgentPromptPermissionSafe: () => void
  getPtyAgent: () => 'omp'
  getPtyWriteHostPlatform: () => 'linux'
  createAgentPromptRenderGate: () => null
  ptysById: Map<string, { launchedAgent: 'omp'; launchAgent: null; foregroundAgent: null }>
  ptyController: { write: (ptyId: string, data: string) => boolean }
  writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: { inputKind: 'driving' }
  ): Promise<unknown>
}

type BundledWriterConstructor = new () => BundledWriter

async function buildBundledWriter(): Promise<BundledWriterConstructor> {
  const result = await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      ssr: true,
      minify: 'oxc',
      rollupOptions: {
        input: BUNDLED_WRITER_PATH,
        external: (id, importer) =>
          importer === BUNDLED_WRITER_PATH && Object.hasOwn(BUNDLED_WRITER_EXTERNALS, id),
        output: { format: 'cjs' }
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: write:false build() resolves to RollupOutput (or an array of them); the watch-mode union member never occurs here.
  const output = (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput
  const chunk = output.output.find(
    (item): item is Rollup.OutputChunk => item.type === 'chunk' && item.isEntry
  )
  if (!chunk) {
    throw new Error('OMP writer bundle emitted no entry chunk')
  }
  const exports: Record<string, unknown> = {}
  const module = { exports }
  runInNewContext(chunk.code, {
    Buffer,
    TextEncoder,
    exports: module.exports,
    module,
    require: (id: string) => {
      const external = BUNDLED_WRITER_EXTERNALS[id]
      if (!external) {
        throw new Error(`Unexpected OMP writer bundle import: ${id}`)
      }
      return external
    }
  })
  const constructor = module.exports.QuirkyRuntimeWithWriteTerminalAgentPrompt
  if (typeof constructor !== 'function') {
    throw new Error('OMP writer bundle emitted no runtime constructor')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bundle evaluated from the real writer module exports this class; only its constructor signature is used.
  return constructor as unknown as BundledWriterConstructor
}

/** Models the observable OMP large-paste decision without importing an installed CLI package.
 * OMP accepts a trailing submit from the same input burst as the completed paste; otherwise it
 * opens the large-paste menu, whose first keypress consumes a later bare CR. */
function createOmpLargePasteHarness(onSubmit: (prompt: string) => void): {
  ingest: (data: string) => void
  submissions: string[]
  menuOpens: () => number
} {
  const submissions: string[] = []
  let menuOpen = false
  let menuOpens = 0
  return {
    ingest: (data) => {
      const start = data.indexOf(AGENT_PROMPT_BRACKETED_PASTE_START)
      if (start === -1) {
        if (menuOpen && data === AGENT_PROMPT_SUBMIT) {
          menuOpen = false
        }
        return
      }
      const contentStart = start + AGENT_PROMPT_BRACKETED_PASTE_START.length
      const end = data.indexOf(AGENT_PROMPT_BRACKETED_PASTE_END, contentStart)
      if (end === -1) {
        return
      }
      const prompt = data.slice(contentStart, end)
      const trailing = data.slice(end + AGENT_PROMPT_BRACKETED_PASTE_END.length)
      if (trailing === AGENT_PROMPT_SUBMIT) {
        submissions.push(prompt)
        onSubmit(prompt)
        return
      }
      menuOpen = true
      menuOpens += 1
    },
    submissions,
    menuOpens: () => menuOpens
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OMP agent prompt submission', () => {
  it('preserves the CR submit byte through the OXC-minified writer bundle', async () => {
    const Writer = await buildBundledWriter()
    const runtime = new Writer()
    const writes: string[] = []
    runtime.assertAgentPromptGeneration = () => {}
    runtime.getAgentPromptActivity = () => ({
      workingSequence: 0,
      explicitWorkingStartedAt: null,
      permissionSequence: 0
    })
    runtime.assertAgentPromptPermissionSafe = () => {}
    runtime.getPtyAgent = () => 'omp'
    runtime.getPtyWriteHostPlatform = () => 'linux'
    runtime.createAgentPromptRenderGate = () => null
    // launch authority already retired and Bun is the foreground process, so only launchedAgent names OMP
    runtime.ptysById = new Map([
      [PTY_ID, { launchedAgent: 'omp', launchAgent: null, foregroundAgent: null }]
    ])
    runtime.ptyController = {
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      }
    }
    const pastePayload = `${AGENT_PROMPT_BRACKETED_PASTE_START}bundled${AGENT_PROMPT_BRACKETED_PASTE_END}`

    await runtime.writeTerminalAgentPrompt('handle', PTY_ID, 1, pastePayload, {
      inputKind: 'driving'
    })

    expect(writes).toEqual([pastePayload + AGENT_PROMPT_SUBMIT])
    expect(Buffer.from(writes[0]!).at(-1)).toBe(0x0d)
  })

  it('atomically accepts a large paste and observes a turn started during that write', async () => {
    const prompt = Array.from(
      { length: 120 },
      (_, index) => `line ${index}: ${'x'.repeat(48)}`
    ).join('\n')
    let runtime: QuirkyRuntimeService
    const omp = createOmpLargePasteHarness(() => {
      // The provider can report its turn synchronously from the write callback. The verification
      // baseline must predate the atomic write or this real transition is missed as stale state.
      runtime.onPtyData(PTY_ID, '\x1b]9999;{"state":"working","agentType":"omp"}\x07', Date.now())
    })
    const created = await createAgentPromptSubmissionRuntime(
      (_runtime, data) => omp.ingest(data),
      'omp'
    )
    runtime = created.runtime

    await expect(
      runtime.sendTerminalAgentPrompt(created.handle, prompt, { inputKind: 'driving' })
    ).resolves.toMatchObject({
      accepted: true
    })

    expect(omp.submissions).toEqual([prompt])
    expect(omp.menuOpens()).toBe(0)
    expect(created.writes).toEqual([`${buildAgentPromptPasteBytes(prompt)}${AGENT_PROMPT_SUBMIT}`])
  })

  it('records the queued receipt baseline before a same-write OMP lifecycle transition', async () => {
    const created = await createAgentPromptSubmissionRuntime((runtime) => {
      runtime.onPtyData(PTY_ID, '\x1b]9999;{"state":"working","agentType":"omp"}\x07', Date.now())
    }, 'omp')

    await expect(
      created.runtime.sendTerminalAgentPrompt(created.handle, 'inspect the receipt', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'omp-atomic-receipt'
      })
    ).resolves.toMatchObject({
      prompt: {
        stages: ['input_accepted'],
        baselineWorkingSequence: 0
      }
    })
    expect(created.writes).toEqual([
      `${buildAgentPromptPasteBytes('inspect the receipt')}${AGENT_PROMPT_SUBMIT}`
    ])
  })

  it('rechecks cancellation and permission safety before the atomic write', async () => {
    const cancelled = new AbortController()
    const cancelledRuntime = await createAgentPromptSubmissionRuntime(() => undefined, 'omp')
    await expect(
      cancelledRuntime.runtime.sendTerminalAgentPrompt(cancelledRuntime.handle, 'cancel me', {
        inputKind: 'driving',
        signal: cancelled.signal,
        beforeWrite: () => cancelled.abort()
      })
    ).rejects.toThrow('request_aborted')
    expect(cancelledRuntime.writes).toEqual([])

    const permissionRuntime = await createAgentPromptSubmissionRuntime(() => undefined, 'omp')
    await expect(
      permissionRuntime.runtime.sendTerminalAgentPrompt(permissionRuntime.handle, 'do not paste', {
        inputKind: 'driving',
        beforeWrite: () => {
          permissionRuntime.runtime.onPtyData(
            PTY_ID,
            '\x1b]9999;{"state":"waiting","agentType":"omp"}\x07',
            Date.now()
          )
        }
      })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(permissionRuntime.writes).toEqual([])
  })

  it('rechecks the PTY generation before the atomic write', async () => {
    const created = await createAgentPromptSubmissionRuntime(() => undefined, 'omp')

    await expect(
      created.runtime.sendTerminalAgentPrompt(created.handle, 'stay on this process', {
        inputKind: 'driving',
        beforeWrite: () => {
          created.runtime.synchronizePtyOutputSequenceFromProvider(
            PTY_ID,
            { value: 0, generation: 'reset' },
            created.runtime.getPtyOutputSequence(PTY_ID)
          )
        }
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(created.writes).toEqual([])
  })

  it('stays atomic after the shell command-finished marker retires launch authority', async () => {
    const prompt = Array.from(
      { length: 120 },
      (_, index) => `line ${index}: ${'x'.repeat(48)}`
    ).join('\n')
    let runtime: QuirkyRuntimeService
    const omp = createOmpLargePasteHarness(() => {
      runtime.onPtyData(PTY_ID, '\x1b]9999;{"state":"working","agentType":"omp"}\x07', Date.now())
    })
    const created = await createAgentPromptSubmissionRuntime(
      (_runtime, data) => omp.ingest(data),
      'omp'
    )
    runtime = created.runtime
    // The startup shell emits this before the agent settles, so it races every dispatch preamble.
    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

    await expect(
      runtime.sendTerminalAgentPrompt(created.handle, prompt, { inputKind: 'driving' })
    ).resolves.toMatchObject({
      accepted: true
    })

    expect(omp.submissions).toEqual([prompt])
    expect(omp.menuOpens()).toBe(0)
    expect(created.writes).toEqual([`${buildAgentPromptPasteBytes(prompt)}${AGENT_PROMPT_SUBMIT}`])
  })

  it('keeps non-OMP submission delayed and emits exactly one separate CR', async () => {
    vi.useFakeTimers()
    const prompt = 'review this change'
    const created = await createAgentPromptSubmissionRuntime((runtime, data) => {
      if (data === AGENT_PROMPT_SUBMIT) {
        runtime.onPtyData(
          PTY_ID,
          '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
          Date.now()
        )
      }
    }, 'aider')
    const delayMs = getAgentPromptSubmitDelayMs(
      process.platform,
      Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
    )

    const submission = created.runtime.sendTerminalAgentPrompt(created.handle, prompt, {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(created.writes).toEqual([buildAgentPromptPasteBytes(prompt)])

    await vi.advanceTimersByTimeAsync(1)
    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(created.writes).toEqual([buildAgentPromptPasteBytes(prompt), AGENT_PROMPT_SUBMIT])
  })
})
