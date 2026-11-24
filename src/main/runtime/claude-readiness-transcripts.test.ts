/**
 * Pins Claude Code terminal readiness to captured transcripts.
 *
 * Claude Code 2.1.28x paints no OSC title at all — not at cold start, not mid-turn, not after a
 * turn — and draws its screen with cursor moves, so the runtime's newline tail stays empty. The
 * only readiness evidence left is the visible screen, which the tui-idle probe reads.
 *
 * Capture protocol: docs/reference/agent-pty-transcript-capture.md
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const FIXTURE_DIR = join(__dirname, '__fixtures__')
const ESC = String.fromCharCode(27)

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8')
}

/** The visible screen as the provider snapshot returns it, at the size the capture recorded. */
async function renderVisibleScreen(transcript: string): Promise<string[]> {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(transcript, resolve))
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  }
  terminal.dispose()
  return lines
}

describe('Claude Code ready prompt, decided by captured transcripts', () => {
  const cases = [
    { name: 'claude-code-ready-cold-start', ready: true },
    { name: 'claude-code-busy-mid-turn', ready: false },
    { name: 'claude-code-idle-after-turn', ready: true }
  ] as const

  for (const transcript of cases) {
    it(`${transcript.name} → ${transcript.ready ? 'ready' : 'not ready'}`, async () => {
      const raw = readFixture(transcript.name)
      expect(raw).toContain(ESC)
      const screen = await renderVisibleScreen(raw)
      expect(isKnownReadyPromptPreview(screen.join('\n'))).toBe(transcript.ready)
    })
  }
})

describe('Claude Code ready prompt on a worker screen', () => {
  it('needs no banner: hook output can push it off the visible screen', () => {
    // The visible screen an Quirky worker pane returned at cold start (paths scrubbed).
    const screen = [
      '  \u23bf  SessionStart:startup says: [memsearch v0.4.21] embedding: onnx | milvus:',
      '     ~/.memsearch/milvus.db | collection: ms_sample_workspace_folder',
      '\u2500'.repeat(120),
      '\u276f\u00a0Try "fix typecheck errors"',
      '\u2500'.repeat(120),
      '  \u{1f916} Opus 5.5 \u2502 \u{1f4ca} 0 \u2502 \u23f1 1s',
      '  \u23f5\u23f5 bypass permissions on (shift+tab to cycle) \u00b7 \u2190 for agents'
    ]
    expect(isKnownReadyPromptPreview(screen.join('\n'))).toBe(true)
  })
})

describe('Claude Code ready prompt after a turn', () => {
  const rule = '\u2500'.repeat(120)
  const screenAfter = (rows: string[], input = '\u276f ') =>
    ['\u276f Reply with the single word done.', '', ...rows, '', rule, input, rule].join('\n')

  it('is ready once the turn summary replaces the spinner row', () => {
    expect(
      isKnownReadyPromptPreview(screenAfter(['\u23fa done', '', '\u273b Brewed for 1s']))
    ).toBe(true)
  })

  it('stays busy while the last spinner row is live or a thinking row', () => {
    expect(
      isKnownReadyPromptPreview(
        screenAfter([
          '\u273b Brewed for 1s',
          '\u2736 Flamb\u00e9ing\u2026 (12s \u00b7 \u2193 115 tokens)'
        ])
      )
    ).toBe(false)
    expect(isKnownReadyPromptPreview(screenAfter(['\u273b Thought for 3s']))).toBe(false)
  })

  it("does not reuse the previous turn's summary for a newly submitted prompt", () => {
    const screen = [
      '\u273b Brewed for 1s',
      '',
      '\u276f Now reply with ok.',
      '',
      rule,
      '\u276f ',
      rule
    ].join('\n')
    expect(isKnownReadyPromptPreview(screen)).toBe(false)
  })

  it('is not ready while text sits in the input box', () => {
    expect(
      isKnownReadyPromptPreview(
        screenAfter(['\u273b Brewed for 1s'], '\u276f half-typed follow-up')
      )
    ).toBe(false)
  })
})

describe('Claude Code tui-idle wait at cold start', () => {
  for (const seed of [
    { label: 'no runtime text yet', data: '' },
    // A worker pane's preview holds only the status rows below the prompt box.
    { label: 'a preview without the prompt', data: `${'\u2500'.repeat(40)}\r\nstatus row\r\n` }
  ]) {
    it(`keeps probing the visible screen until Claude has painted its prompt (${seed.label})`, async () => {
      const readyScreen = await renderVisibleScreen(readFixture('claude-code-ready-cold-start'))
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'claude',
        foregroundProcess: 'claude',
        data: seed.data
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches the runtime's pty map to mark the pane as an Quirky-launched Claude, as worker-start does.
      const internals = runtime as unknown as { ptysById: Map<string, { launchAgent?: string }> }
      internals.ptysById.get(TRANSCRIPT_PANE_PTY_ID)!.launchAgent = 'claude'
      let reads = 0
      // The first reads land before Claude has drawn anything, as a worker start's do: one finds
      // no provider screen yet, the next a blank one.
      vi.spyOn(runtime, 'readTerminal').mockImplementation(async () => {
        reads += 1
        if (reads === 1) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a null read is what a pane with no provider screen yet yields at runtime, which the probe must survive.
          return null as never
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tui-idle probe reads only source and tail from a screen read.
        return { source: 'screen', tail: reads === 2 ? [] : readyScreen } as never
      })

      const result = await runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 5_000
      })

      expect(result.satisfied).toBe(true)
      expect(reads).toBeGreaterThan(2)
    }, 15_000)
  }
})
