import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PtyFact } from '@quirky/protocol'
import { Rig, waitForAsync, type StoredView } from './support'

let rig: Rig | undefined
let transcriptHome: string | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
  if (transcriptHome) rmSync(transcriptHome, { recursive: true, force: true })
  transcriptHome = undefined
})

const line = (record: unknown) => `${JSON.stringify(record)}\n`

const codexSession = {
  id: 'codex-session',
  agent: 'codex',
  providerSession: { id: 'provider-codex-1', transcriptPath: '' }
} as const

describe('captured provider status producers', () => {
  test('Codex transcript questions and delayed final text update the live status without silence completing a turn', async () => {
    transcriptHome = mkdtempSync('/tmp/qas-codex-transcript-')
    const transcriptPath = join(transcriptHome, 'session.jsonl')
    const question = {
      questions: [{
        id: 'deploy-target',
        question: 'Which environment?',
        options: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }]
      }]
    }
    writeFileSync(transcriptPath, [
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'Deploy this change' } }),
      line({ type: 'response_item', payload: { type: 'function_call', call_id: 'question-1', name: 'request_user_input', arguments: JSON.stringify(question) } })
    ].join(''))
    rig = await Rig.start({ sessions: [{ ...codexSession, providerSession: { id: 'provider-codex-1', transcriptPath } }] })

    await rig.hook('codex', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'provider-codex-1',
      transcript_path: transcriptPath,
      prompt: 'Deploy this change'
    }, { session: codexSession.id })
    const waiting = await waitForAsync(async () => {
      const row = await rig!.row(codexSession.id)
      return row?.state === 'waiting' ? row : undefined
    }, 5_000)
    expect(waiting.detail).toContain('Which environment?')
    expect(waiting.question).toContain('deploy-target')

    appendFileSync(transcriptPath, line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'question-1', output: 'environment: production' } }))
    await waitForAsync(async () => {
      const row = await rig!.row(codexSession.id)
      return row?.state === 'working' && row.question === undefined ? row : undefined
    }, 5_000)
    await rig.hook('codex', {
      hook_event_name: 'Stop',
      session_id: 'provider-codex-1',
      transcript_path: transcriptPath
    }, { session: codexSession.id })
    expect(await rig.state(codexSession.id)).toBe('done')

    appendFileSync(transcriptPath, line({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Deployment verified.' }] }
    }))
    const completed = await waitForAsync(async () => {
      const row = await rig!.row(codexSession.id)
      return row?.detail.includes('Deployment verified.') ? row : undefined
    }, 5_000)
    expect(completed.state).toBe('done')
  }, 20_000)

  test('Muse transcript questions and final text are reconciled within the captured turn', async () => {
    transcriptHome = mkdtempSync('/tmp/qas-muse-transcript-')
    const transcriptPath = join(transcriptHome, 'session.jsonl')
    const question = { questions: [{ id: 'deploy-target', question: 'Which environment?', options: [{ id: 'production', label: 'Production' }] }] }
    writeFileSync(transcriptPath, [
      line({ type: 'user', message: { role: 'user', content: 'Deploy this change' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'question-1', name: 'AskUserQuestion', input: question }] } })
    ].join(''))
    const session = { ...codexSession, id: 'muse-session', agent: 'muse' as const, providerSession: { id: 'provider-muse-1', transcriptPath } }
    rig = await Rig.start({ sessions: [session] })

    await rig.hook('muse', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'provider-muse-1',
      transcript_path: transcriptPath,
      prompt: 'Deploy this change'
    }, { session: session.id })
    const waiting = await waitForAsync(async () => {
      const row = await rig!.row(session.id)
      return row?.state === 'waiting' ? row : undefined
    }, 5_000)
    expect(waiting.detail).toContain('Which environment?')
    expect(waiting.question).toContain('deploy-target')

    appendFileSync(transcriptPath, line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'question-1', content: 'environment: production' }] }
    }))
    await waitForAsync(async () => {
      const row = await rig!.row(session.id)
      return row?.state === 'working' && row.question === undefined ? row : undefined
    }, 5_000)
    await rig.hook('muse', { hook_event_name: 'Stop', session_id: 'provider-muse-1', transcript_path: transcriptPath }, { session: session.id })
    appendFileSync(transcriptPath, line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Deployment verified.' }] }
    }))
    const completed = await waitForAsync(async () => {
      const row = await rig!.row(session.id)
      return row?.detail.includes('Deployment verified.') ? row : undefined
    }, 5_000)
    expect(completed.state).toBe('done')
  }, 20_000)

  test('private OSC status facts use the captured session owner and ignore provider identity changes', async () => {
    transcriptHome = mkdtempSync('/tmp/qas-osc-transcript-')
    const transcriptPath = join(transcriptHome, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    rig = await Rig.start({ sessions: [{ ...codexSession, providerSession: { id: 'provider-codex-1', transcriptPath } }] })
    const question = { questions: [{ id: 'deploy-target', question: 'Which environment?', options: [{ id: 'prod', label: 'Production' }] }] }
    const fact = (payload: Record<string, unknown>) => rig!.h.pty.fact(codexSession.id, {
      kind: 'agent-status',
      payload
    } as unknown as PtyFact)

    fact({ hook_event_name: 'UserPromptSubmit', session_id: 'provider-codex-1', turn_id: 'turn-1', prompt: 'Deploy this change' })
    await waitForAsync(async () => (await rig!.row(codexSession.id))?.prompt === 'Deploy this change', 5_000)
    fact({ hook_event_name: 'PreToolUse', session_id: 'provider-codex-1', turn_id: 'turn-1', tool_name: 'request_user_input', tool_input: question })
    const waiting = await waitForAsync(async () => {
      const row = await rig!.row(codexSession.id)
      return row?.state === 'waiting' ? row : undefined
    }, 5_000)
    expect(waiting.detail).toContain('Which environment?')

    await rig.client.callAny('quirky.session/setProviderSession', {
      session: codexSession.id,
      id: 'provider-codex-replaced',
      transcriptPath
    })
    fact({
      hook_event_name: 'PreToolUse',
      session_id: 'provider-codex-1',
      turn_id: 'turn-1',
      tool_name: 'request_user_input',
      tool_input: { questions: [{ id: 'stale', question: 'Stale question?' }] }
    })
    fact({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'provider-codex-replaced',
      turn_id: 'turn-2',
      prompt: 'Next turn'
    })
    await waitForAsync(async () => {
      const row = await rig!.row(codexSession.id)
      return row?.prompt === 'Next turn' ? row : undefined
    }, 5_000)
    expect(rig.events.some((event) => JSON.stringify(event).includes('Stale question?'))).toBe(false)
    const afterReplacement = await rig.row(codexSession.id) as StoredView
    expect(afterReplacement.prompt).toBe('Next turn')
    expect(afterReplacement.question).toBeUndefined()
    expect(afterReplacement.detail).not.toContain('Stale question?')
  }, 20_000)
  test('private OSC status facts are fenced to the provider turn as well as the session', async () => {
    transcriptHome = mkdtempSync('/tmp/qas-osc-turn-')
    const transcriptPath = join(transcriptHome, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    rig = await Rig.start({ sessions: [{ ...codexSession, providerSession: { id: 'provider-codex-1', transcriptPath } }] })
    const fact = (payload: Record<string, unknown>) => rig!.h.pty.fact(codexSession.id, {
      kind: 'agent-status',
      payload
    } as unknown as PtyFact)
    const prompt = (sessionId: string, turnId: string, text: string) => fact({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      turn_id: turnId,
      agent_pid: process.pid,
      prompt: text
    })

    prompt('provider-codex-1', 'turn-1', 'First turn')
    await waitForAsync(async () => (await rig!.row(codexSession.id))?.prompt === 'First turn', 5_000)
    fact({
      hook_event_name: 'PreToolUse',
      session_id: 'provider-codex-1',
      turn_id: 'turn-1',
      agent_pid: process.pid + 1,
      tool_name: 'request_user_input',
      tool_input: { questions: [{ id: 'wrong-process', question: 'Wrong process?' }] }
    })
    await rig.settle()
    expect(await rig.state(codexSession.id)).toBe('working')
    fact({
      hook_event_name: 'PreToolUse',
      session_id: 'provider-codex-1',
      turn_id: 'turn-1',
      tool_name: 'request_user_input',
      tool_input: { questions: [{ id: 'current', question: 'Current question?' }] }
    })
    await waitForAsync(async () => (await rig!.row(codexSession.id))?.state === 'waiting', 5_000)
    prompt('provider-codex-1', 'turn-2', 'Second turn')
    await waitForAsync(async () => {
      const row = await rig!.row(codexSession.id)
      return row?.prompt === 'Second turn' && row.question === undefined
    }, 5_000)
    fact({
      hook_event_name: 'PreToolUse',
      session_id: 'provider-codex-1',
      turn_id: 'turn-1',
      tool_name: 'request_user_input',
      tool_input: { questions: [{ id: 'stale-turn', question: 'Stale turn question?' }] }
    })
    await rig.settle()
    const row = await rig.row(codexSession.id) as StoredView
    expect(row.prompt).toBe('Second turn')
    expect(row.question).toBeUndefined()
    expect(row.detail).not.toContain('Stale turn question?')
  }, 20_000)
  test('Codex and Muse child hooks update the lead fold without completing on silence', async () => {
    transcriptHome = mkdtempSync('/tmp/qas-hook-children-')
    const codexPath = join(transcriptHome, 'codex.jsonl')
    const musePath = join(transcriptHome, 'muse.jsonl')
    writeFileSync(codexPath, '')
    writeFileSync(musePath, '')
    const museSession = { ...codexSession, id: 'muse-child-session', agent: 'muse' as const, providerSession: { id: 'provider-muse-child', transcriptPath: musePath } }
    rig = await Rig.start({ sessions: [
      { ...codexSession, providerSession: { id: 'provider-codex-1', transcriptPath: codexPath } },
      museSession
    ] })

    await rig.hook('codex', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'provider-codex-1',
      transcript_path: codexPath,
      prompt: 'Codex child task'
    }, { session: codexSession.id })
    await rig.hook('muse', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'provider-muse-child',
      transcript_path: musePath,
      prompt: 'Muse child task'
    }, { session: museSession.id })

    await rig.hook('codex', { hook_event_name: 'SubagentStart', session_id: 'provider-codex-1', agent_id: 'codex-child-1' }, { session: codexSession.id })
    await rig.hook('muse', { hook_event_name: 'SubagentStart', session_id: 'provider-muse-child', child_session_id: 'muse-child-1' }, { session: museSession.id })
    expect(await rig.row(codexSession.id)).toMatchObject({ state: 'working', children: [{ id: 'codex-child-1', state: 'working' }] })
    expect(await rig.row(museSession.id)).toMatchObject({ state: 'working', children: [{ id: 'muse-child-1', state: 'working' }] })

    await rig.hook('codex', { hook_event_name: 'SubagentStop', session_id: 'provider-codex-1', agent_id: 'codex-child-1' }, { session: codexSession.id })
    await rig.hook('muse', { hook_event_name: 'SubagentStop', session_id: 'provider-muse-child', child_session_id: 'muse-child-1' }, { session: museSession.id })
    expect(await rig.state(codexSession.id)).toBe('working')
    expect(await rig.state(museSession.id)).toBe('working')

    await rig.hook('codex', { hook_event_name: 'Stop', session_id: 'provider-codex-1', transcript_path: codexPath }, { session: codexSession.id })
    await rig.hook('muse', { hook_event_name: 'Stop', session_id: 'provider-muse-child', transcript_path: musePath }, { session: museSession.id })
    expect(await rig.state(codexSession.id)).toBe('done')
    expect(await rig.state(museSession.id)).toBe('done')
  }, 20_000)
})
