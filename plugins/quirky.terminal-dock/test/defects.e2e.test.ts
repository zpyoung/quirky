import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DockState, SendResult } from '../src/types'
import { enableDock, inputBytes, paneOf, postClaudeHook, startDockE2E, waitForTuiInput, type DockHarness } from './support'
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

type PublicHookStatus = { state?: string; question?: string; children?: { id: string; state: string }[]; lead?: { providerSession?: string } } | null

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

async function quitFakeClaude(h: DockHarness, session: string): Promise<void> {
  const eventStart = h.events.length
  await h.type(session, '/quit')
  await waitFor('private fake Claude command to finish', () =>
    h.events.slice(eventStart).find((event) => {
      if (event.type !== 'quirky.terminal/commandFinished' || !('data' in event)) return false
      const data = event.data
      return typeof data === 'object' && data !== null && !Array.isArray(data) &&
        'sessionId' in data && data.sessionId === session
    }),
    15_000
  )
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

test(
  'SC-16: an answered provider card advances to the next live question without refresh lag',
  async () => {
    harness = await startDockE2E()
    const command = installFakeCommand(harness, 'fake-claude.ts', 'dock-fake-question-claude')
    await harness.call('quirky.agents/configure', { agent: 'claude', command })
    writeFileSync(join(harness.home, 'dock-claude-question-screen'), '')

    const opened = await openTab(harness, ['--agent', 'claude'], { ready: false })
    const session = await harness.sessionRecord(opened.session)
    const pane = await paneOf(harness, session.id)
    await waitFor('real fake-Claude question selector screen', async () => {
      const lines = await harness!.screen(session.id, 40).catch(() => [])
      return lines.some((line) => line.includes('Choose a color')) && lines.some((line) => line.includes('Blue')) ? lines : undefined
    }, 15_000)

    const providerSession = 'dock-claude-question-refresh'
    const transcriptPath = join(harness.home, '.claude', 'projects', 'dock-e2e', `${providerSession}.jsonl`)
    const firstInput = { questions: [{ question: 'Choose a color', options: ['Red', 'Blue'] }] }
    const secondInput = { questions: [{ question: 'Choose the next color', options: ['Green', 'Gold'] }] }
    const firstCall = {
      type: 'assistant',
      uuid: 'question-call-1',
      timestamp: new Date().toISOString(),
      message: {
        id: 'question-message-1',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'question-call-1', name: 'AskUserQuestion', input: firstInput }]
      }
    }
    writeFileSync(transcriptPath, `${JSON.stringify(firstCall)}\n`)
    await harness.call('quirky.session/setProviderSession', {
      session: session.id,
      id: providerSession,
      transcriptPath
    })
    await enableDock(harness)
    await postClaudeHook(harness, session.id, {
      hook_event_name: 'PreToolUse',
      session_id: providerSession,
      transcript_path: transcriptPath,
      tool_name: 'AskUserQuestion',
      tool_use_id: 'question-call-1',
      tool_input: firstInput
    })
    await waitFor('public Claude hook to report the first active question', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status?.state === 'waiting' && String(status.question).includes('Choose a color') ? status : undefined
    }, 15_000)

    const firstState = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    const firstQuestion = firstState.question
    if (!firstQuestion) throw new Error('the live provider question was not published to the dock')
    expect(firstQuestion.questions[0]?.prompt).toBe('Choose a color')
    await harness.call('quirky.terminal-dock/interaction', {
      pane,
      request: firstQuestion.id,
      action: 'answer',
      answers: [[firstQuestion.questions[0]!.choices[1]!.value]]
    })
    await waitForTuiInput(harness, (input) => input.includes(Buffer.from('2')))

    const secondCall = {
      type: 'assistant',
      uuid: 'question-call-2',
      timestamp: new Date().toISOString(),
      message: {
        id: 'question-message-2',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'question-call-2', name: 'AskUserQuestion', input: secondInput }]
      }
    }
    const firstResult = {
      type: 'user',
      uuid: 'question-result-1',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'question-call-1', content: 'Blue' }] }
    }
    writeFileSync(transcriptPath, [firstCall, firstResult, secondCall].map((row) => JSON.stringify(row)).join('\n') + '\n')
    await postClaudeHook(harness, session.id, {
      hook_event_name: 'PreToolUse',
      session_id: providerSession,
      transcript_path: transcriptPath,
      tool_name: 'AskUserQuestion',
      tool_use_id: 'question-call-2',
      tool_input: secondInput
    })
    await waitFor('public Claude hook to report the next active question', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status?.state === 'waiting' && String(status.question).includes('Choose the next color') ? status : undefined
    }, 15_000)

    const nextState = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(nextState.question?.questions[0]?.prompt).toBe('Choose the next color')
    expect(inputBytes(harness).includes(Buffer.from('2'))).toBe(true)
  },
  90_000
)

test(
  'SC-15: a visible persistent-default confirmation refuses an effort change without terminal or settings writes',
  async () => {
    harness = await startDockE2E()
    const command = installFakeCommand(harness, 'fake-claude.ts', 'dock-fake-refusal-claude')
    await harness.call('quirky.agents/configure', { agent: 'claude', command })
    writeFileSync(join(harness.home, 'dock-claude-refusal-screen'), '')

    const settingsPath = join(harness.home, '.claude', 'settings.json')
    mkdirSync(dirname(settingsPath), { recursive: true })
    const sentinel = Buffer.from('{"effortLevel":"high","sentinel":"safe-refusal"}\n')
    writeFileSync(settingsPath, sentinel)

    const opened = await openTab(harness, ['--agent', 'claude'], { ready: false })
    const session = await harness.sessionRecord(opened.session)
    const pane = await paneOf(harness, session.id)
    await waitFor('fake Claude persistent-default confirmation screen', async () => {
      const lines = await harness!.screen(session.id, 40).catch(() => [])
      return lines.some((line) => line.includes('Save model as the new default')) ? lines : undefined
    }, 15_000)

    const transcriptPath = join(harness.home, '.claude', 'projects', 'dock-e2e', `${CLAUDE_PROVIDER_SESSION}.jsonl`)
    await harness.call('quirky.session/setProviderSession', {
      session: session.id,
      id: CLAUDE_PROVIDER_SESSION,
      transcriptPath
    })
    await enableDock(harness)
    const initial = await harness.call<DockState>('quirky.terminal-dock/options', { pane })
    expect(initial.options.effort).toBe('medium')
    expect(initial.options.choices.effort).toContain('low')
    const drafted = await harness.call<DockState>('quirky.terminal-dock/set', {
      pane,
      revision: initial.revision,
      draft: 'keep this draft after refusal'
    })
    const before = inputBytes(harness)

    const refused = await harness.call<DockState>('quirky.terminal-dock/options', {
      pane,
      kind: 'effort',
      value: 'low'
    })
    expect(refused.options.effort).toBe('medium')
    expect(refused.options.notice).toContain('persistent-default confirmation')
    expect(refused.draft).toBe(drafted.draft)
    expect(inputBytes(harness)).toEqual(before)
    expect(readFileSync(settingsPath)).toEqual(sentinel)
    expect(readFileSync(join(harness.home, 'dock-claude-interactions.log'), 'utf8')).toBe('')
  },
  90_000
)

test(
  'SC-03: a public SessionEnd hook undocks without manual-close state, relaunch reopens, and whole-PTY exit stays closed',
  async () => {
    harness = await startDockE2E()
    const command = installFakeCommand(harness, 'fake-claude.ts', 'dock-fake-lifecycle-claude')
    await harness.call('quirky.agents/configure', { agent: 'claude', command })
    const opened = await openTab(harness)
    await harness.type(opened.session, shellQuote(command))
    const session = await harness.sessionRecord(opened.session)
    const pane = await paneOf(harness, session.id)
    await waitFor('manually launched fake Claude prompt before lifecycle hook', async () => {
      const lines = await harness!.screen(session.id, 40).catch(() => [])
      return lines.some((line) => line.includes('Current effort: medium')) ? lines : undefined
    }, 15_000)
    const transcriptPath = join(harness.home, '.claude', 'projects', 'dock-e2e', `${CLAUDE_PROVIDER_SESSION}.jsonl`)
    await harness.call('quirky.session/setProviderSession', {
      session: session.id,
      id: CLAUDE_PROVIDER_SESSION,
      transcriptPath
    })
    await postClaudeHook(harness, session.id, {
      hook_event_name: 'UserPromptSubmit',
      session_id: CLAUDE_PROVIDER_SESSION,
      transcript_path: transcriptPath,
      prompt: 'start a turn'
    })
    await waitFor('public Claude hook to mark the lead working', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status?.state === 'working' ? status : undefined
    }, 15_000)
    await enableDock(harness)
    const initial = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(initial).toMatchObject({ supported: true, docked: true, userUndocked: false, agent: 'claude' })
    const drafted = await harness.call<DockState>('quirky.terminal-dock/set', {
      pane,
      revision: initial.revision,
      draft: 'retain this prompt across agent exit'
    })
    expect((await harness.sessionRecord(session.id)).agent).toBe('shell')

    await postClaudeHook(harness, session.id, {
      hook_event_name: 'SessionEnd',
      session_id: CLAUDE_PROVIDER_SESSION,
      agent_id: 'dock-child-one',
      reason: 'logout'
    })
    await postClaudeHook(harness, session.id, {
      hook_event_name: 'PostToolUse',
      session_id: CLAUDE_PROVIDER_SESSION,
      agent_id: 'dock-child-one',
      tool_name: 'Read'
    })
    await waitFor('child SessionEnd to leave the lead working', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status?.state === 'working' && status.children?.some((child) => child.id === 'dock-child-one')
        ? status
        : undefined
    }, 15_000)
    expect((await harness.call<DockState>('quirky.terminal-dock/get', { pane })).docked).toBe(true)

    await postClaudeHook(harness, session.id, {
      hook_event_name: 'SessionEnd',
      session_id: 'dock-claude-foreign-session',
      reason: 'logout'
    })
    await postClaudeHook(harness, session.id, {
      hook_event_name: 'PostToolUse',
      session_id: CLAUDE_PROVIDER_SESSION,
      agent_id: 'dock-child-two',
      tool_name: 'Read'
    })
    await waitFor('foreign SessionEnd to leave the lead working', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status?.state === 'working' && status.children?.some((child) => child.id === 'dock-child-two')
        ? status
        : undefined
    }, 15_000)
    expect((await harness.call<DockState>('quirky.terminal-dock/get', { pane })).docked).toBe(true)

    await postClaudeHook(harness, session.id, {
      hook_event_name: 'UserPromptSubmit',
      session_id: CLAUDE_PROVIDER_SESSION,
      transcript_path: transcriptPath,
      prompt: 'confirm the lead remains active'
    })
    await waitFor('current Claude lead to remain working before SessionEnd', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status?.state === 'working' ? status : undefined
    }, 15_000)

    await postClaudeHook(harness, session.id, {
      hook_event_name: 'SessionEnd',
      session_id: CLAUDE_PROVIDER_SESSION,
      transcript_path: transcriptPath,
      reason: 'logout'
    })
    await waitFor('public Claude SessionEnd hook to remove the status row', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status === null ? true : undefined
    }, 15_000)
    const afterHook = await waitFor('SessionEnd hook to undock before the PTY exits', async () => {
      const state = await harness!.call<DockState>('quirky.terminal-dock/get', { pane })
      return !state.docked && !state.userUndocked ? state : undefined
    }, 15_000)
    expect(afterHook).toMatchObject({
      docked: false,
      userUndocked: false,
      agent: null,
      draft: drafted.draft
    })
    expect((await harness.sessionRecord(session.id)).status).not.toBe('exited')

    await quitFakeClaude(harness, session.id)
    await harness.type(session.id, 'dock-fake-lifecycle-claude')
    await waitFor('fake Claude relaunch in the same terminal session', async () => {
      const lines = await harness!.screen(session.id, 40).catch(() => [])
      return lines.some((line) => line.includes('Current effort: medium')) ? lines : undefined
    }, 15_000)
    const resumedProviderSession = 'dock-claude-lifecycle-relaunch'
    await harness.call('quirky.session/setProviderSession', {
      session: session.id,
      id: resumedProviderSession,
      transcriptPath
    })
    await postClaudeHook(harness, session.id, {
      hook_event_name: 'UserPromptSubmit',
      session_id: resumedProviderSession,
      transcript_path: transcriptPath,
      prompt: 'start a fresh turn after relaunch'
    })
    await waitFor('public relaunch hook to confirm fresh Claude identity', async () => {
      const status = await harness!.call<PublicHookStatus>('quirky.agent-status/get', { session: session.id })
      return status?.state === 'working' && status.lead?.providerSession === resumedProviderSession ? status : undefined
    }, 15_000)
    const relaunched = await waitFor('fresh agent evidence to auto-open the dock', async () => {
      const state = await harness!.call<DockState>('quirky.terminal-dock/get', { pane })
      return state.docked && state.agent === 'claude' ? state : undefined
    }, 15_000)
    expect(relaunched).toMatchObject({
      docked: true,
      userUndocked: false,
      agent: 'claude',
      draft: drafted.draft
    })
    expect((await harness.sessionRecord(session.id)).agent).toBe('shell')

    await quitFakeClaude(harness, session.id)
    await harness.type(session.id, 'exit')
    await harness.waitForSession(session.id, 'whole PTY exit', (current) => current.status === 'exited', 15_000)
    const afterPtyExit = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(afterPtyExit).toMatchObject({
      docked: false,
      userUndocked: false,
      agent: null,
      disabledReason: 'No terminal session'
    })
  },
  90_000
)
