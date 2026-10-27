import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DockState, SendResult } from '../src/types'
import { enableDock, inputBytes, paneOf, startDockE2E, type DockHarness } from './support'
import { waitFor } from '../../quirky.terminal/test/e2e-support'
import { openTab } from '../../quirky.terminal/test/e2e/support'

let harness: DockHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

type JsonlRow = {
  type?: string
  timestamp?: string
  payload?: Record<string, unknown>
  message?: Record<string, unknown>
}

function readJsonl(path: string): JsonlRow[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonlRow)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function installFakeCommand(h: DockHarness, fixture: string, name: string): string {
  const fixturePath = join(h.home, 'bin', fixture)
  writeFileSync(fixturePath, readFileSync(join(import.meta.dir, 'fixtures', fixture)))
  const command = join(h.home, 'bin', name)
  h.writeBinScript(name, `exec ${shellQuote(process.execPath)} "$HOME/bin/${fixture}" "$@"`)
  return command
}


const CODEX_PROVIDER_SESSION = 'dock-codex-defect-session'
const CLAUDE_PROVIDER_SESSION = 'dock-claude-defect-session'

test(
  'Codex transcript evidence clears a snapshot send despite a stale composer prompt',
  async () => {
    harness = await startDockE2E()
    const command = installFakeCommand(harness, 'fake-codex.ts', 'dock-fake-codex')
    await harness.call('quirky.agents/configure', { agent: 'codex', command })
    await harness.call('setting.set', { id: 'setting:quirky.agent-status/hooks', value: false })

    const opened = await openTab(harness, ['--agent', 'codex'], { ready: false })
    const session = await harness.sessionRecord(opened.session)
    const pane = await paneOf(harness, session.id)
    await waitFor('the fake Codex stale composer prompt', async () => {
      const lines = await harness!.screen(session.id, 40).catch(() => [])
      return lines.some((line) => line.includes('stale old composer prompt')) ? lines : undefined
    }, 15_000)

    const transcriptPath = join(harness.home, '.codex', 'sessions', `rollout-${CODEX_PROVIDER_SESSION}.jsonl`)
    const providerSession = await harness.call<{ providerSession: { id: string; transcriptPath: string } }>(
      'quirky.session/setProviderSession',
      { session: session.id, id: CODEX_PROVIDER_SESSION, transcriptPath }
    )
    expect(providerSession.providerSession).toEqual({ id: CODEX_PROVIDER_SESSION, transcriptPath })

    await enableDock(harness)
    const initial = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(initial.agent).toBe('codex')
    const prompt = 'Return the exact token PONG for this request.'
    const drafted = await harness.call<DockState>('quirky.terminal-dock/set', {
      pane,
      revision: initial.revision,
      draft: prompt
    })

    const sendStartedAt = Date.now()
    const pendingSend = harness.call<SendResult>('quirky.terminal-dock/send', {
      pane,
      id: 'codex-transcript-positive-evidence',
      revision: drafted.revision
    })
    const terminal = await waitFor('PONG from the fake Codex PTY', async () => {
      const lines = await harness!.screen(session.id, 40).catch(() => [])
      return lines.some((line) => line.includes('PONG')) && lines.some((line) => line.includes('stale old composer prompt'))
        ? lines
        : undefined
    }, 15_000)
    const result = await pendingSend

    expect(terminal.join('\n')).toContain('PONG')
    expect(result).toMatchObject({ outcome: 'observed-cleared', accepted: true })
    const after = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(after.draft).toBe('')
    expect(after.notice ?? '').not.toMatch(/not confirmed|may not have completed|check the terminal before retrying/i)

    const rows = readJsonl(transcriptPath)
    const userRows = rows.filter((row) => row.type === 'event_msg' && row.payload?.type === 'user_message')
    expect(userRows.filter((row) => row.payload?.message === 'stale old composer prompt')).toHaveLength(1)
    const matchingUserRows = userRows.filter((row) => row.payload?.message === prompt)
    expect(matchingUserRows).toHaveLength(1)
    expect(Date.parse(matchingUserRows[0]!.timestamp ?? '')).toBeGreaterThanOrEqual(sendStartedAt)
    const pongRows = rows.filter((row) => {
      const payload = row.payload
      if (row.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'assistant') return false
      const content = payload.content
      return Array.isArray(content) && content.some((block) =>
        typeof block === 'object' && block !== null && 'text' in block && block.text === 'PONG'
      )
    })
    expect(pongRows).toHaveLength(1)
    expect(readJsonl(join(harness.home, 'dock-codex-consumed.jsonl')).map((row) => row.payload?.prompt)).toEqual([prompt])

    const received = inputBytes(harness)
    const submitted = Buffer.from(prompt)
    const bodyAt = received.indexOf(submitted)
    expect(bodyAt).toBeGreaterThan(received.indexOf(Buffer.from([0x15, 0x0b])))
    expect(received.toString('utf8').split(prompt)).toHaveLength(2)
    expect(received.subarray(bodyAt + submitted.length).includes(0x0d)).toBe(true)
  },
  90_000
)

test(
  'Claude effort changes use the live session-only action without persisting a default',
  async () => {
    harness = await startDockE2E()
    const command = installFakeCommand(harness, 'fake-claude.ts', 'dock-fake-native-claude')
    await harness.call('quirky.agents/configure', { agent: 'claude', command })

    const settingsPath = join(harness.home, '.claude', 'settings.json')
    mkdirSync(dirname(settingsPath), { recursive: true })
    const sentinel = Buffer.from('{"effortLevel":"high","sentinel":"defect-regression"}\n')
    writeFileSync(settingsPath, sentinel)

    const opened = await openTab(harness, ['--agent', 'claude'], { ready: false })
    const session = await harness.sessionRecord(opened.session)
    const pane = await paneOf(harness, session.id)
    await waitFor('native Claude Sonnet medium-effort prompt', async () => {
      const lines = await harness!.screen(session.id, 40).catch(() => [])
      return lines.some((line) => line.includes('Current effort: medium')) && lines.some((line) => line.trim() === '❯')
        ? lines
        : undefined
    }, 15_000)

    const transcriptPath = join(harness.home, '.claude', 'projects', 'dock-e2e', `${CLAUDE_PROVIDER_SESSION}.jsonl`)
    const providerSession = await harness.call<{ providerSession: { id: string; transcriptPath: string } }>(
      'quirky.session/setProviderSession',
      { session: session.id, id: CLAUDE_PROVIDER_SESSION, transcriptPath }
    )
    expect(providerSession.providerSession).toEqual({ id: CLAUDE_PROVIDER_SESSION, transcriptPath })
    await enableDock(harness)

    const initial = await harness.call<DockState>('quirky.terminal-dock/options', { pane })
    expect(initial.options.model).toBe('claude-sonnet-4-5')
    expect(initial.options.effort).toBe('medium')
    expect(initial.options.choices.effort).toContain('low')
    const beforeDraft = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    const drafted = await harness.call<DockState>('quirky.terminal-dock/set', {
      pane,
      revision: beforeDraft.revision,
      draft: 'keep this unrelated draft'
    })

    const changed = await harness.call<DockState>('quirky.terminal-dock/options', {
      pane,
      kind: 'effort',
      value: 'low'
    })
    expect(changed.options.effort).toBe('low')
    expect(changed.options.notice ?? '').not.toMatch(/not confirmed|could not|refusing/i)
    await waitFor('Claude session transcript effort low', async () => {
      const rows = readJsonl(transcriptPath)
      const lastAssistant = rows.filter((row) => row.type === 'assistant').at(-1)
      const message = lastAssistant?.message
      return message?.model === 'claude-sonnet-4-5' && message.effort === 'low' ? lastAssistant : undefined
    }, 15_000)
    const lines = await harness.screen(session.id, 40)
    expect(lines.join('\n')).toContain('Current effort: low')
    expect(readFileSync(join(harness.home, 'dock-claude-interactions.log'), 'utf8').split('\n')).toContain('picker:up')
    expect(readFileSync(join(harness.home, 'dock-claude-interactions.log'), 'utf8').split('\n')).toContain('session-only:s')
    expect(readFileSync(settingsPath)).toEqual(sentinel)

    const reported = await harness.call<DockState>('quirky.terminal-dock/options', { pane })
    expect(reported.options.effort).toBe('low')
    const afterDraft = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(afterDraft.draft).toBe(drafted.draft)
  },
  90_000
)
