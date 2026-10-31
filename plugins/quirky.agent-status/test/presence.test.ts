import { afterEach, describe, expect, test } from 'bun:test'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { Rig, startOf, waitForAsync } from './support'

let rig: Rig
const children: Bun.Subprocess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await rig?.cleanup()
  removeTempDirs()
})

const PRESENCE = 'job:quirky.agent-status/presence'
const runPresence = () => rig.client.callAny('job.run', { id: PRESENCE })

/** A short-lived child standing in for the agent process. */
function agentProcess(): { pid: number; pstart: string; process: Bun.Subprocess } {
  const child = Bun.spawn(['sleep', '60'])
  children.push(child)
  return { pid: child.pid, pstart: startOf(child.pid), process: child }
}

async function killed(process: Bun.Subprocess) {
  process.kill('SIGKILL')
  await process.exited
}

const prompt = (agent: { pid: number; pstart: string }, session = 's1') =>
  rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { session, pid: agent.pid, pstart: agent.pstart })
const TRUST_PROMPT = [
  '────────────────────────────────────────────',
  'Accessing workspace:',
  '',
  '/Users/zpyoung/quirky/workspaces/qqa.kNauC',
  'j-proj2/wf-two',
  '',
  'Quick safety check: Is this a project you',
  'created or one you trust? (Like your own',
  'code, a well-known open source project, or',
  'work from your team). If not, take a',
  "moment to review what's in this folder",
  'first.',
  '',
  "Claude Code'll be able to read, edit, and",
  'execute files here.',
  '',
  'Security guide',
  '',
  '  No, exit',
  '› Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel'
]
const TRUST_NEAR_MISS = TRUST_PROMPT.map((line) => line.replace('Yes, I trust this folder', 'Yes, I trust this project'))
async function waitForWaitingRow(sessionId = 's1') {
  return waitForAsync(async () => {
    await runPresence()
    const row = await rig.row(sessionId)
    const session = await rig.session(sessionId)
    return row?.agent === 'claude' && session.status === 'waiting' ? row : null
  }, 5000)
}

async function waitForClearedRow(sessionId = 's1') {
  return waitForAsync(async () => {
    await runPresence()
    const row = await rig.row(sessionId)
    const session = await rig.session(sessionId)
    return row === null && session.status === 'running' && (session.agentStatus ?? null) === null ? true : null
  }, 5000)
}


describe('SC-19: an agent that exits without saying so ends its row', () => {
  test('the presence probe ends the row of a killed agent and the session reads running', async () => {
    rig = await Rig.start()
    const agent = agentProcess()
    await prompt(agent)
    expect(await rig.row()).toMatchObject({ state: 'working', lead: { agentPid: agent.pid, agentStart: agent.pstart } })
    expect((await rig.session()).status).toBe('working')

    await runPresence()
    expect(await rig.state()).toBe('working')

    await killed(agent.process)
    await runPresence()

    expect(await rig.row()).toBeNull()
    expect(await rig.session()).toMatchObject({ status: 'running', agentStatus: null })
    const changed = rig.events.filter((event) => event.type === 'quirky.agent-status/changed')
    expect(changed.at(-1)).toMatchObject({ data: { sessionId: 's1', row: null } })
  })

  test('ends a dead-agent row even when session listing fails', async () => {
    rig = await Rig.start()
    const agent = agentProcess()
    await prompt(agent)
    await killed(agent.process)
    await rig.client.callAny('quirky.session/failNextList', {})

    await runPresence()
    await waitForAsync(async () => (await rig.row()) === null ? true : null)
    expect(await rig.session()).toMatchObject({ status: 'running', agentStatus: null })
  })

  test('a done row ends too, and rows of live agents stay', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2' }] })
    const gone = agentProcess()
    const alive = agentProcess()
    await prompt(gone, 's1')
    await rig.hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'ok' }, { session: 's1', pid: gone.pid, pstart: gone.pstart })
    await prompt(alive, 's2')
    expect(await rig.state('s1')).toBe('done')

    await killed(gone.process)
    await runPresence()
    expect(await rig.row('s1')).toBeNull()
    expect(await rig.state('s2')).toBe('working')
  })

  test('a reused pid is not the agent: a different start time ends the row', async () => {
    rig = await Rig.start()
    const agent = agentProcess()
    await prompt({ pid: agent.pid, pstart: 'Thu Jan  1 00:00:00 1970' })
    await runPresence()
    expect(await rig.row()).toBeNull()
  })

  test('a successor of the same kind replaces the dead agent and keeps its own process id', async () => {
    rig = await Rig.start()
    const predecessor = agentProcess()
    const successor = agentProcess()
    await prompt(predecessor)
    await killed(predecessor.process)

    await prompt(successor)
    expect(await rig.row()).toMatchObject({ state: 'working', lead: { agentPid: successor.pid, agentStart: successor.pstart } })

    await runPresence()
    expect(await rig.state()).toBe('working')
  })

  test('rows without a process id are left alone', async () => {
    rig = await Rig.start()
    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await runPresence()
    expect(await rig.state()).toBe('working')
  })

  test('a session that exits takes its row with it', async () => {
    rig = await Rig.start()
    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await rig.client.callAny('quirky.session/setStatus', { session: 's1', status: 'exited' })
    await rig.settle()
    expect(await rig.row()).toBeNull()
  })

  test('the job is scheduled every 10 seconds after a 10 second delay', async () => {
    rig = await Rig.start()
    const jobs = (await rig.client.callAny('job.list', {})) as { id: string; intervalMs: number }[]
    expect(jobs.find((job) => job.id === PRESENCE)).toMatchObject({ intervalMs: 10_000 })
  })

  test('a visible Claude trust prompt creates a waiting row and disappearance clears it', async () => {
    rig = await Rig.start()

    rig.show([])
    await runPresence()
    expect(await rig.row()).toBeNull()
    expect((await rig.session()).status).toBe('running')
    expect((await rig.session()).agentStatus ?? null).toBeNull()

    rig.show(TRUST_NEAR_MISS)
    await runPresence()
    expect(await rig.row()).toBeNull()
    expect((await rig.session()).status).toBe('running')
    expect((await rig.session()).agentStatus ?? null).toBeNull()

    rig.show(TRUST_PROMPT)
    await waitForWaitingRow()
    expect(await rig.row()).toMatchObject({ agent: 'claude' })
    expect(await rig.session()).toMatchObject({
      status: 'waiting',
      agentStatus: { evidenceAt: expect.any(Number) }
    })

    rig.show([])
    await waitForClearedRow()
    expect(await rig.row()).toBeNull()
    expect((await rig.session()).status).toBe('running')
    expect((await rig.session()).agentStatus ?? null).toBeNull()
  })

  test('presence recognizes the trust prompt when its question wraps across terminal rows', async () => {
    rig = await Rig.start()
    rig.terminal([
      ...TRUST_PROMPT.slice(0, 4),
      { text: TRUST_PROMPT[4]!, wrapped: true },
      ...TRUST_PROMPT.slice(5, 7),
      { text: ` ${TRUST_PROMPT[7]!}`, wrapped: true },
      { text: ` ${TRUST_PROMPT[8]!}`, wrapped: true },
      { text: ` ${TRUST_PROMPT[9]!}`, wrapped: true },
      { text: ` ${TRUST_PROMPT[10]!}`, wrapped: true },
      { text: ` ${TRUST_PROMPT[11]!}`, wrapped: true },
      ...TRUST_PROMPT.slice(12)
    ])

    await waitForWaitingRow()

    expect(await rig.row()).toMatchObject({ agent: 'claude' })
    expect(await rig.session()).toMatchObject({
      status: 'waiting',
      agentStatus: { evidenceAt: expect.any(Number) }
    })
  })

  test('a stalled trust-screen read releases the session queue for hooks and exits', async () => {
    rig = await Rig.start()
    rig.show(TRUST_PROMPT)
    await waitForWaitingRow()
    expect(await rig.row()).toMatchObject({ agent: 'claude' })

    const heldRead = rig.h.pty.holdNextRead()
    let sweepFinished = false
    const sweep = runPresence().then(() => {
      sweepFinished = true
    })
    try {
      await heldRead.requested
      await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'continue' })
      await waitForAsync(async () => {
        const row = await rig.row()
        return sweepFinished && row?.state === 'working' ? row : null
      }, 1000)

      await rig.exit()
      await waitForAsync(async () => {
        const row = await rig.row()
        const session = await rig.session()
        return row === null && session.status === 'exited' ? true : null
      }, 1000)
    } finally {
      heldRead.release()
      await sweep
    }

    expect(await rig.row()).toBeNull()
  })

  test('a hook takes over prompt inference and is not cleared when the screen changes', async () => {
    rig = await Rig.start()
    rig.show(TRUST_PROMPT)
    await waitForWaitingRow()
    expect(await rig.row()).toMatchObject({ agent: 'claude' })

    await prompt(agentProcess())
    expect(await rig.row()).toMatchObject({ agent: 'claude', state: 'working' })

    rig.show(TRUST_PROMPT)
    await runPresence()
    rig.show([])
    await runPresence()

    expect(await rig.row()).toMatchObject({ agent: 'claude', state: 'working' })
    expect(await rig.session()).toMatchObject({ status: 'working', agentStatus: { display: 'working' } })
  })

  test('presence classifies only live Claude sessions, not other agents, shell, or exited sessions', async () => {
    rig = await Rig.start({
      sessions: [
        {},
        { id: 'codex', agent: 'codex' },
        { id: 'shell', agent: 'shell' },
        { id: 'exited', status: 'exited' }
      ]
    })
    for (const session of ['s1', 'codex', 'shell', 'exited']) rig.show(TRUST_PROMPT, session)

    await waitForWaitingRow('s1')

    expect(await rig.row('s1')).toMatchObject({ agent: 'claude' })
    expect(await rig.row('codex')).toBeNull()
    expect(await rig.row('shell')).toBeNull()
    expect((await rig.session('codex')).status).toBe('running')
    expect((await rig.session('shell')).status).toBe('running')
    expect((await rig.session('exited')).status).toBe('exited')
  })
})
