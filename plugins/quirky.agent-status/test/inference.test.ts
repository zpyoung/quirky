import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { Rig } from './support'

const SCALE = 'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE'
const CTRL_C = '\x03'
const ESC = '\x1b'
let saved: string | undefined
let rig: Rig

// 0.2 turns the 500 ms settle into 100 ms
beforeAll(() => {
  saved = process.env[SCALE]
  process.env[SCALE] = '0.2'
})
afterAll(() => {
  if (saved === undefined) delete process.env[SCALE]
  else process.env[SCALE] = saved
})
afterEach(async () => {
  await rig?.cleanup()
  removeTempDirs()
})

const settled = () => Bun.sleep(220)

/** The hook that starts a turn with prompt "long task", per agent. */
const START: Record<string, [name: string, payload: Record<string, unknown>]> = {
  claude: ['UserPromptSubmit', { prompt: 'long task' }],
  gemini: ['BeforeAgent', { prompt: 'long task' }],
  codex: ['UserPromptSubmit', { prompt: 'long task' }],
  droid: ['UserPromptSubmit', { prompt: 'long task' }],
  opencode: ['SessionBusy', {}]
}

async function working(agent: string) {
  rig = await Rig.start({ sessions: [{ agent }] })
  const [name, payload] = START[agent]!
  await rig.hook(agent, { hook_event_name: name, ...payload })
  expect((await rig.row())!.state).toBe('working')
}

async function expectInterrupted() {
  expect(await rig.row()).toMatchObject({
    state: 'done',
    interrupted: true,
    outcome: 'cancellation',
    display: 'interrupted',
    label: 'Interrupted',
    source: 'inference'
  })
  expect((await rig.session()).status).toBe('done')
}

async function expectStillWorking() {
  expect(await rig.row()).toMatchObject({ state: 'working', display: 'working' })
}

describe('SC-20: Esc and Ctrl+C infer an interrupt, per agent', () => {
  test('claude: Ctrl+C yes', async () => {
    await working('claude')
    await rig.write(CTRL_C)
    await settled()
    await expectInterrupted()
    expect(rig.notifies()).toEqual([])
  })

  test('claude: Esc no', async () => {
    await working('claude')
    await rig.write(ESC)
    await settled()
    await expectStillWorking()
  })

  test('gemini: Esc yes', async () => {
    await working('gemini')
    await rig.write(ESC)
    await settled()
    await expectInterrupted()
  })

  test.each(['codex', 'droid'])('%s: Ctrl+C no', async (agent) => {
    await working(agent)
    await rig.write(CTRL_C)
    await settled()
    await expectStillWorking()
  })

  test('opencode: one Esc no, a second Esc in the same turn yes', async () => {
    await working('opencode')
    await rig.write(ESC)
    await settled()
    await expectStillWorking()
    await rig.write(ESC)
    await settled()
    await expectInterrupted()
  })

  test('opencode: an Esc in an earlier turn does not count toward the second', async () => {
    await working('opencode')
    await rig.write(ESC)
    await rig.hook('opencode', { hook_event_name: 'SessionIdle' })
    await rig.hook('opencode', { hook_event_name: 'SessionBusy' })
    await rig.write(ESC)
    await settled()
    await expectStillWorking()
  })

  test('any agent: Ctrl+C, then a hook that changes the row within the settle time, no', async () => {
    await working('claude')
    await rig.write(CTRL_C)
    await rig.hook('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' })
    await settled()
    await expectStillWorking()
  })

  test('Ctrl+C on a waiting row, a done row or a restored unconfirmed row, no', async () => {
    await working('claude')
    await rig.hook('claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })
    await rig.write(CTRL_C)
    await settled()
    expect(await rig.row()).toMatchObject({ state: 'waiting' })

    await rig.hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await rig.write(CTRL_C)
    await settled()
    expect(await rig.row()).toMatchObject({ state: 'done', display: 'done' })

    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    rig = await rig.restart()
    expect(await rig.row()).toMatchObject({ state: 'working', display: 'unconfirmed' })
    await rig.write(CTRL_C)
    await settled()
    expect(await rig.row()).toMatchObject({ state: 'working', display: 'unconfirmed' })
  })

  test('claude: Ctrl+C while only a child is working, no', async () => {
    await working('claude')
    await rig.hook('claude', { hook_event_name: 'SubagentStart', agent_id: 'a1' })
    await rig.hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'started it' })
    expect(await rig.row()).toMatchObject({ state: 'working', lead: { state: 'done' } })
    await rig.write(CTRL_C)
    await settled()
    expect(await rig.row()).toMatchObject({ state: 'working', display: 'working' })
  })

  test('a title row has no hook evidence for an interrupt to sit on', async () => {
    rig = await Rig.start()
    await rig.title('⠋ Working on it')
    await rig.write(CTRL_C)
    await settled()
    expect(await rig.row()).toMatchObject({ state: 'working', source: 'title' })
  })

  test('typed text is not a key press', async () => {
    await working('claude')
    await rig.write(`${CTRL_C}${CTRL_C}`)
    await rig.write('\x1b[A')
    await settled()
    await expectStillWorking()
  })
})

describe('SC-3: an answer typed in the terminal resumes a Claude question', () => {
  const ask = { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }

  test('the row waits on the question and Enter makes it working again', async () => {
    await working('claude')
    await rig.hook('claude', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: ask, tool_use_id: 'q1' })
    expect(await rig.row()).toMatchObject({ state: 'waiting', detail: 'Which branch?' })

    await rig.write('1')
    await rig.settle()
    expect(await rig.state()).toBe('waiting')

    await rig.write('\r')
    await rig.settle()
    expect(await rig.row()).toMatchObject({ state: 'working', display: 'working', source: 'inference' })
    expect((await rig.row())!.question).toBeUndefined()
    expect((await rig.session()).status).toBe('working')
  })

  test('Enter in the same write as the answer counts', async () => {
    await working('claude')
    await rig.hook('claude', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: ask, tool_use_id: 'q1' })
    await rig.write('1\r')
    await rig.settle()
    expect(await rig.state()).toBe('working')
  })

  test('a subagent question restores the lead state it stashed', async () => {
    await working('claude')
    await rig.hook('claude', { hook_event_name: 'SubagentStart', agent_id: 'a1' })
    await rig.hook('claude', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: ask, agent_id: 'a1' })
    expect(await rig.row()).toMatchObject({ state: 'waiting' })
    await rig.write('\r')
    await rig.settle()
    expect(await rig.row()).toMatchObject({ state: 'working', children: [{ id: 'a1', state: 'working' }] })
  })

  test('Enter does not answer a permission request, a done row or another agent', async () => {
    await working('claude')
    await rig.hook('claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'p1' })
    await rig.write('\r')
    await rig.settle()
    expect(await rig.state()).toBe('waiting')
    await rig.hook('claude', { hook_event_name: 'Stop' })
    await rig.write('\r')
    await rig.settle()
    expect(await rig.state()).toBe('done')
  })
})
