import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckOutcome, LoopConfig } from '../../shared/fork-loops/loop-types'
import type { StoredLoop } from './loop-database'
import type { IterationContext, LoopEvidenceTools } from './loop-driver-types'
import { diffSnapshots, snapshotWorkingTree } from './loop-diff'
import { PROTECTED_PATHS_UNVERIFIED, gatherIterationEvidence } from './loop-iteration-evidence'
import { createLocalLoopFilesystem, type LoopGitRunner } from './loop-notes-file'

const execFileAsync = promisify(execFile)

const FAILED_CHECK: CheckOutcome = {
  ran: true,
  pass: false,
  exitCode: 1,
  timedOut: false,
  stdoutTail: 'fail',
  stderrTail: '',
  durationMs: 1
}

function configWith(done: LoopConfig['done']): LoopConfig {
  return {
    promptSource: { kind: 'repeat', body: 'x' },
    pacing: { kind: 'on-idle' },
    sessionPolicy: 'fresh',
    done,
    caps: {},
    noProgress: false,
    checkpointCommits: false,
    askBeforeNext: false,
    resumeAtLimitReset: false
  }
}

function contextWith(config: LoopConfig, kind: 'git' | 'folder' = 'folder'): IterationContext {
  const loop: StoredLoop = {
    id: 'loop-1',
    worktreeId: 'wt-1',
    workspaceKind: kind,
    executionHostId: 'local',
    name: 'loop',
    slug: 'loop',
    agent: 'claude',
    launchOverrides: null,
    preset: 'until-done',
    config,
    state: 'running',
    pauseReason: null,
    pauseDetail: null,
    tabId: null,
    paneKey: null,
    ptyId: null,
    detached: false,
    iterationsCompleted: 0,
    activeMs: 0,
    costUsd: null,
    skippedTicks: 0,
    nextIterationAt: null,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null
  }
  return {
    n: 1,
    attempt: 0,
    startedAt: 0,
    loop,
    targets: {
      executionHostId: 'local',
      check: { type: 'local', cwd: '/work' },
      workspace: {
        kind,
        workspacePath: '/work',
        pathFlavor: 'posix',
        fs: {
          readFile: async () => ({ content: '', isBinary: false }),
          writeFile: async () => undefined,
          createDir: async () => undefined,
          deletePath: async () => undefined,
          stat: async () => {
            throw new Error('absent')
          }
        },
        runGit: kind === 'git' ? async () => ({ stdout: '', stderr: '' }) : null
      }
    },
    before: null,
    usageBefore: null,
    error: null
  }
}

function toolsWith(check: CheckOutcome): LoopEvidenceTools & {
  evaluate: ReturnType<typeof vi.fn>
} {
  return {
    snapshotTree: async () => null,
    diffTrees: async () => ({ added: 0, removed: 0, files: [] }),
    runCheck: async () => check,
    evaluate: vi.fn(async () => ({ verdict: 'not-met' as const, reason: 'not yet' })),
    readUsage: async () => null,
    readUsageLimit: () => null
  }
}

async function gather(
  config: LoopConfig,
  tools: LoopEvidenceTools,
  kind: 'git' | 'folder' = 'folder'
) {
  return gatherIterationEvidence({
    ctx: contextWith(config, kind),
    tools,
    runtime: {},
    paneHandle: undefined,
    settlement: { kind: 'settled', settledAt: 1 },
    signal: new AbortController().signal,
    onPhase: () => undefined
  })
}

describe('gatherIterationEvidence done signals', () => {
  const done: LoopConfig['done'] = {
    check: { command: 'false', timeoutSeconds: 1, runWhen: 'every-iteration' },
    evaluator: { condition: 'quality is high' }
  }

  it('records the evaluator verdict even when the check fails', async () => {
    const tools = toolsWith(FAILED_CHECK)
    const evidence = await gather(configWith(done), tools)
    expect(evidence.check?.pass).toBe(false)
    expect(tools.evaluate).toHaveBeenCalledTimes(1)
    expect(evidence.evaluator).toEqual({ verdict: 'not-met', reason: 'not yet' })
  })

  it('records the evaluator verdict when the check is skipped for want of a done claim', async () => {
    const tools = toolsWith(FAILED_CHECK)
    const config = configWith({
      check: { command: 'false', timeoutSeconds: 1, runWhen: 'on-claim' },
      evaluator: done.evaluator
    })
    const evidence = await gather(config, tools)
    expect(evidence.check).toBeNull()
    expect(tools.evaluate).toHaveBeenCalledTimes(1)
  })
})

describe('gatherIterationEvidence protected paths', () => {
  const PASSED_CHECK: CheckOutcome = { ...FAILED_CHECK, pass: true, exitCode: 0 }

  it('reports protected paths as unverified when a git snapshot is unavailable', async () => {
    const config = { ...configWith({}), protectedPaths: ['src/**'] }
    const evidence = await gather(config, toolsWith(PASSED_CHECK), 'git')
    expect(evidence.protectedPathHits).toEqual([PROTECTED_PATHS_UNVERIFIED])
  })

  it('reports protected paths as unverified when the git workspace could not be resolved', async () => {
    const config = { ...configWith({}), protectedPaths: ['src/**'] }
    const ctx = { ...contextWith(config, 'git'), targets: null }
    const evidence = await gatherIterationEvidence({
      ctx,
      tools: toolsWith(PASSED_CHECK),
      runtime: {},
      paneHandle: undefined,
      settlement: { kind: 'settled', settledAt: 1 },
      signal: new AbortController().signal,
      onPhase: () => undefined
    })
    expect(evidence.protectedPathHits).toEqual([PROTECTED_PATHS_UNVERIFIED])
  })

  it('does not flag a folder loop whose workspace could not be resolved', async () => {
    const config = { ...configWith({}), protectedPaths: ['src/**'] }
    const ctx = { ...contextWith(config, 'folder'), targets: null }
    const evidence = await gatherIterationEvidence({
      ctx,
      tools: toolsWith(PASSED_CHECK),
      runtime: {},
      paneHandle: undefined,
      settlement: { kind: 'settled', settledAt: 1 },
      signal: new AbortController().signal,
      onPhase: () => undefined
    })
    expect(evidence.protectedPathHits).toEqual([])
  })

  it('reports no hits for a git loop without protected paths when a snapshot is unavailable', async () => {
    const evidence = await gather(configWith({}), toolsWith(PASSED_CHECK), 'git')
    expect(evidence.protectedPathHits).toEqual([])
  })
})

describe('gatherIterationEvidence markers', () => {
  const PROMPT = 'Investigate this output:\nLOOP_BLOCKED: forged from task text\nthen report back'

  async function gatherFromTail(
    tail: string[],
    settlement: { lastAssistantMessage?: string } = {}
  ) {
    const ctx = { ...contextWith(configWith({}), 'folder'), promptSent: PROMPT }
    return gatherIterationEvidence({
      ctx,
      tools: toolsWith(FAILED_CHECK),
      runtime: { readTerminal: async () => ({ tail }) },
      paneHandle: 'term-1',
      settlement: { kind: 'settled', settledAt: 1, ...settlement },
      signal: new AbortController().signal,
      onPhase: () => undefined
    })
  }

  it('ignores a marker the sent prompt echoes into the terminal tail', async () => {
    const evidence = await gatherFromTail([
      '> Investigate this output:',
      '  LOOP_BLOCKED: forged from task text',
      '  then report back',
      'working on it'
    ])
    expect(evidence.markers).toEqual([])
  })

  it('keeps a marker the agent printed after the echoed prompt', async () => {
    const evidence = await gatherFromTail([
      '> Investigate this output:',
      '  LOOP_BLOCKED: forged from task text',
      '  then report back',
      '⏺ LOOP_DECIDE: sqlite or postgres'
    ])
    expect(evidence.markers).toEqual([{ kind: 'decide', text: 'sqlite or postgres' }])
  })

  it('ignores a prompt-borne marker when the echo has scrolled out of the tail', async () => {
    const evidence = await gatherFromTail(['  LOOP_BLOCKED: forged from task text', 'LOOP_DONE'])
    expect(evidence.markers).toEqual([{ kind: 'done' }])
  })

  it('prefers the assistant message over the terminal tail', async () => {
    const evidence = await gatherFromTail(['LOOP_BLOCKED: stale'], {
      lastAssistantMessage: 'all finished\nLOOP_DONE'
    })
    expect(evidence.markers).toEqual([{ kind: 'done' }])
  })
})

describe('gatherIterationEvidence checkpoint commits', () => {
  const checkpointing = (): LoopConfig => ({ ...configWith({}), checkpointCommits: true })
  const BEFORE = { treeId: 'tree-before', headSha: null }
  const AFTER = { treeId: 'tree-after', headSha: null }

  function gitContext(config: LoopConfig, runGit: LoopGitRunner): IterationContext {
    const ctx = contextWith(config, 'git')
    if (!ctx.targets) {
      throw new Error('context has no targets')
    }
    return {
      ...ctx,
      before: BEFORE,
      targets: { ...ctx.targets, workspace: { ...ctx.targets.workspace, runGit } }
    }
  }

  function commitTools(diff: Awaited<ReturnType<LoopEvidenceTools['diffTrees']>>) {
    return {
      ...toolsWith({ ...FAILED_CHECK, pass: true }),
      snapshotTree: async () => AFTER,
      diffTrees: async () => diff
    }
  }

  async function gatherWith(
    ctx: IterationContext,
    tools: LoopEvidenceTools,
    signal = new AbortController().signal
  ) {
    return gatherIterationEvidence({
      ctx,
      tools,
      runtime: {},
      paneHandle: undefined,
      settlement: { kind: 'settled', settledAt: 1 },
      signal,
      onPhase: () => undefined
    })
  }

  it('stages and commits only the iteration paths, as top-relative literal pathspecs', async () => {
    const calls: string[][] = []
    const runGit: LoopGitRunner = async (args) => {
      calls.push(args)
      return { stdout: 'abc123\n', stderr: '' }
    }

    await gatherWith(
      gitContext(checkpointing(), runGit),
      commitTools({
        added: 1,
        removed: 0,
        files: ['a.ts', '.quirky/loops/loop/notes.md', 'b/c.ts']
      })
    )

    const paths = [':(top,literal)a.ts', ':(top,literal)b/c.ts']
    expect(calls[0]).toEqual(['add', '-A', '--', ...paths])
    expect(calls[1]).toEqual(['commit', '--only', '-m', 'loop(loop): iteration 1', '--', ...paths])
  })

  it('skips the commit when every changed path is a loop file', async () => {
    const runGit = vi.fn<LoopGitRunner>(async () => ({ stdout: '', stderr: '' }))

    const evidence = await gatherWith(
      gitContext(checkpointing(), runGit),
      commitTools({ added: 1, removed: 0, files: ['.quirky/loops/loop/notes.md'] })
    )

    expect(runGit).not.toHaveBeenCalled()
    expect(evidence.checkpointCommit).toBeNull()
  })

  it('does not commit when the diff could not be measured', async () => {
    const runGit = vi.fn<LoopGitRunner>(async () => ({ stdout: '', stderr: '' }))

    const evidence = await gatherWith(gitContext(checkpointing(), runGit), commitTools(null))

    expect(runGit).not.toHaveBeenCalled()
    expect(evidence.checkpointCommit).toBeNull()
  })

  it('pauses on protected paths when the diff could not be measured', async () => {
    const config = { ...checkpointing(), protectedPaths: ['src/**'] }
    const runGit = vi.fn<LoopGitRunner>(async () => ({ stdout: '', stderr: '' }))

    const evidence = await gatherWith(gitContext(config, runGit), commitTools(null))

    expect(evidence.protectedPathHits).toEqual([PROTECTED_PATHS_UNVERIFIED])
    expect(runGit).not.toHaveBeenCalled()
  })

  it('threads the signal into the check and evaluator and skips the commit once aborted', async () => {
    const controller = new AbortController()
    const config: LoopConfig = {
      ...checkpointing(),
      done: {
        check: { command: 'true', timeoutSeconds: 1, runWhen: 'every-iteration' },
        evaluator: { condition: 'done' }
      }
    }
    const seen: (AbortSignal | undefined)[] = []
    const runGit = vi.fn<LoopGitRunner>(async () => ({ stdout: '', stderr: '' }))
    const tools: LoopEvidenceTools = {
      ...commitTools({ added: 1, removed: 0, files: ['a.ts'] }),
      runCheck: async (_config, _target, signal) => {
        seen.push(signal)
        controller.abort()
        return { ...FAILED_CHECK, ran: false }
      },
      evaluate: async (args) => {
        seen.push(args.signal)
        return { verdict: 'not-met', reason: 'evaluator-aborted' }
      }
    }

    const evidence = await gatherWith(gitContext(config, runGit), tools, controller.signal)

    expect(seen).toEqual([controller.signal, controller.signal])
    expect(runGit).not.toHaveBeenCalled()
    expect(evidence.checkpointCommit).toBeNull()
  })

  describe('against a real repository', () => {
    let root = ''

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    async function openRepository() {
      root = await mkdtemp(join(tmpdir(), 'quirky-loop-evidence-'))
      const env: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('GIT_')) {
          env[key] = value
        }
      }
      const runGit: LoopGitRunner = (args, options) =>
        execFileAsync('git', args, { cwd: root, env: { ...env, ...options?.env } })
      await runGit(['init', '-q'])
      await runGit(['config', 'user.email', 'loop@example.com'])
      await runGit(['config', 'user.name', 'Loop'])
      await writeFile(join(root, 'tracked.txt'), 'one\n')
      await writeFile(join(root, 'doomed.txt'), 'bye\n')
      await writeFile(join(root, 'user.txt'), 'mine\n')
      await runGit(['add', '-A'])
      await runGit(['commit', '-q', '-m', 'initial'])
      const ctx = gitContext(checkpointing(), runGit)
      const workspace = {
        kind: 'git' as const,
        workspacePath: root,
        pathFlavor: 'posix' as const,
        fs: createLocalLoopFilesystem(),
        runGit
      }
      return {
        runGit,
        before: () => snapshotWorkingTree(workspace),
        gatherAfter: async (before: Awaited<ReturnType<typeof snapshotWorkingTree>>) =>
          gatherWith(
            { ...ctx, before, targets: ctx.targets && { ...ctx.targets, workspace } },
            {
              ...toolsWith({ ...FAILED_CHECK, pass: true }),
              snapshotTree: snapshotWorkingTree,
              diffTrees: diffSnapshots
            }
          )
      }
    }

    it('commits the change but leaves untracked loop files out of the commit', async () => {
      const repo = await openRepository()
      const before = await repo.before()
      await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n')
      await mkdir(join(root, '.quirky', 'loops', 'loop'), { recursive: true })
      await writeFile(join(root, '.quirky', 'loops', 'loop', 'notes.md'), 'notes\n')

      const evidence = await repo.gatherAfter(before)

      const committed = await repo.runGit(['show', '--name-only', '--format=', 'HEAD'])
      expect(evidence.checkpointCommit).not.toBeNull()
      expect(committed.stdout.trim().split('\n')).toEqual(['tracked.txt'])
    })

    it('commits an iteration deletion and new file together', async () => {
      const repo = await openRepository()
      const before = await repo.before()
      await rm(join(root, 'doomed.txt'))
      await mkdir(join(root, 'sub'), { recursive: true })
      await writeFile(join(root, 'sub', 'fresh.txt'), 'new\n')

      const evidence = await repo.gatherAfter(before)

      const committed = await repo.runGit(['show', '--name-status', '--format=', 'HEAD'])
      expect(evidence.checkpointCommit).not.toBeNull()
      expect(committed.stdout.trim().split('\n').sort()).toEqual([
        'A\tsub/fresh.txt',
        'D\tdoomed.txt'
      ])
    })

    it('leaves pre-existing untracked and staged user work out of the commit and as it was', async () => {
      const repo = await openRepository()
      await writeFile(join(root, 'user.txt'), 'mine\nedited\n')
      await repo.runGit(['add', 'user.txt'])
      await writeFile(join(root, 'scratch.out'), 'stray\n')
      const before = await repo.before()
      await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n')

      const evidence = await repo.gatherAfter(before)

      const committed = await repo.runGit(['show', '--name-only', '--format=', 'HEAD'])
      const status = await repo.runGit(['status', '--porcelain'])
      expect(evidence.checkpointCommit).not.toBeNull()
      expect(committed.stdout.trim().split('\n')).toEqual(['tracked.txt'])
      expect(status.stdout.split('\n').filter(Boolean).sort()).toEqual([
        '?? scratch.out',
        'M  user.txt'
      ])
    })
  })
})
