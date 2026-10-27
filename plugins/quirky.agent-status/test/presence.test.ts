import { afterEach, describe, expect, test } from 'bun:test'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { Rig, startOf } from './support'

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
})
