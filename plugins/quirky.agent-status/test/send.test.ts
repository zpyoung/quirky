import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type CliArgs, type CliContext } from '@quirky/protocol'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { commands } from '../cli'
import { Rig, startOf } from './support'

const SCALE = 'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE'

let rig: Rig
let savedScale: string | undefined

afterEach(async () => {
  await rig?.cleanup()
  removeTempDirs()
  if (savedScale === undefined) delete process.env[SCALE]
  else process.env[SCALE] = savedScale
})

/** Sets the time scale the plugin reads when it starts; afterEach restores it. */
function scaled(value: string) {
  savedScale = process.env[SCALE]
  process.env[SCALE] = value
}

const claude = (name: string, payload: Record<string, unknown> = {}) => ({ hook_event_name: name, ...payload })
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra })
const ask = { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`
const isEnter = (text: string) => text.endsWith('\r')
const isPaste = (text: string) => text.startsWith('\x1b[200~')
const enters = () => rig.writes().filter(isEnter).length

/** A rule file for `agent` that never matches the screens these tests show. */
const quiet = (agent: string) => ({ agent, rules: [{ id: 'never', state: 'working', region: 'screen', all: [{ contains: 'zzz-never' }] }] })

const cursorRules = {
  agent: 'cursor',
  rules: [
    {
      id: 'approval-menu',
      state: 'blocked',
      kind: 'approval',
      region: 'screen',
      lastLines: 8,
      all: [{ contains: 'run this command?' }, { regex: '\\((?:esc|y|n)\\)\\s*$' }]
    },
    { id: 'busy', state: 'working', region: 'screen', all: [{ contains: 'zzz-never' }] }
  ]
}
const approvalMenu = ['agent output', 'Run this command?', '  rm -rf build', '  Run (once) (y)', '  Skip (esc)']

/** Plays hooks into the session after each Enter the PTY receives, each `ms` after the one before. */
function afterEnter(steps: [ms: number, name: string, payload?: Record<string, unknown>][], options: { every?: boolean; agent?: string } = {}) {
  const target = rig
  target.onWrite(
    isEnter,
    () =>
      void (async () => {
        for (const [ms, name, payload] of steps) {
          await Bun.sleep(ms)
          await target.post(options.agent ?? 'claude', claude(name, payload)).catch(() => {})
        }
      })(),
    options.every === undefined ? {} : { every: options.every }
  )
}

/** A claude session whose last turn finished, at an empty prompt. */
async function idleClaude(options: Parameters<typeof Rig.start>[0] = {}) {
  rig = await Rig.start({ builtinRules: { claude: quiet('claude') }, ...options })
  await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'earlier' }))
  await rig.hook('claude', claude('Stop', { last_assistant_message: 'ok' }))
  rig.show(['> '])
}

const conflict = (reason: string) => ({ code: RpcErrorCode.Conflict, data: { reason } })

describe('SC-14: send types a prompt into an idle agent and waits for it to start', () => {
  test('one paste, then Enter after the submit delay, then working', async () => {
    scaled('0.1')
    await idleClaude()
    afterEnter([[100, 'UserPromptSubmit', { prompt: 'fix the tests' }]])

    const sent = await rig.send('s1', 'fix the tests')

    expect(sent).toMatchObject({ session: 's1', state: 'working' })
    expect(sent.startedAt).toBeGreaterThanOrEqual(sent.sentAt)
    expect(rig.writes()).toEqual([paste('fix the tests'), '\r'])
    const [pasted, entered] = rig.writeLog
    expect(entered!.at - pasted!.at).toBeGreaterThanOrEqual(40)
    expect(await rig.delivered()).toMatchObject([{ sessionId: 's1', agent: 'claude', text: 'fix the tests', submit: false, ready: true }])
    expect(await rig.state()).toBe('working')
  })

  test('the CLI prints the session and the state', async () => {
    scaled('0.1')
    await idleClaude()
    afterEnter([[20, 'UserPromptSubmit', { prompt: 'go' }]])
    const printed: string[] = []

    await commands.send!({ positionals: ['s1', 'go'], flags: {} } as unknown as CliArgs, cliContext(printed))

    expect(printed).toEqual(['s1: working'])
  })
})

/** A CLI context over the rig's daemon that collects what `out.result` would print. */
function cliContext(printed: string[]): CliContext {
  return {
    call: (method: string, params?: Record<string, unknown>) => rig.client.callAny(method, params ?? {}),
    out: { json: false, result: (_value: unknown, text: () => string) => printed.push(text()) },
    readFile: async (path: string) => Bun.file(path).text(),
    usage: (message: string) => new Error(`usage: ${message}`),
    fail: (message: string) => new Error(message),
    env: {},
    cwd: '/'
  } as unknown as CliContext
}

describe('SC-15 to SC-17: a blocked agent is refused and nothing is written', () => {
  test('SC-15: a claude row waiting on a permission names the tool call', async () => {
    rig = await Rig.start({ builtinRules: { claude: quiet('claude') } })
    await rig.hook('claude', claude('PermissionRequest', bash('rm -rf build', { tool_use_id: 't1' })))
    rig.show(['> '])

    const refused = rig.send('s1', 'carry on')

    await expect(refused).rejects.toMatchObject(conflict('agent-blocked'))
    await expect(refused).rejects.toThrow('waiting for approval of Bash: rm -rf build')
    expect(rig.writes()).toEqual([])
    expect(await rig.delivered()).toEqual([])
  })

  test('SC-16: an approval menu the hooks did not report names the screen rule', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: cursorRules } })
    await rig.hook('cursor', claude('preToolUse', { tool_name: 'Shell', tool_input: { command: 'rm -rf build' } }))
    rig.show(approvalMenu)

    const refused = rig.send('s1', 'carry on')

    await expect(refused).rejects.toMatchObject(conflict('agent-blocked'))
    await expect(refused).rejects.toThrow('screen rule approval-menu')
    expect(rig.writes()).toEqual([])
  })

  test('SC-17: a question says what it asks', async () => {
    rig = await Rig.start({ builtinRules: { claude: quiet('claude') } })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }))
    await rig.hook('claude', claude('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask, tool_use_id: 'q1' }))
    rig.show(['> '])

    const refused = rig.send('s1', 'carry on')

    await expect(refused).rejects.toMatchObject(conflict('agent-blocked'))
    await expect(refused).rejects.toThrow('waiting for an answer to "Which branch?"')
    expect(rig.writes()).toEqual([])
  })
})

describe('SC-18: a prompt that never starts fails as stalled', () => {
  test('after the default window, then after --start-timeout-ms, the text having been typed', async () => {
    scaled('0.1')
    await idleClaude()

    const started = Date.now()
    const stalled = rig.send('s1', 'fix the tests')
    await expect(stalled).rejects.toMatchObject(conflict('prompt-stalled'))
    await expect(stalled).rejects.toThrow('typed')
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(480)
    expect(elapsed).toBeLessThan(2000)
    expect(rig.writes()).toEqual([paste('fix the tests'), '\r'])

    const again = Date.now()
    await expect(rig.send('s1', 'again', 200)).rejects.toMatchObject(conflict('prompt-stalled'))
    expect(Date.now() - again).toBeLessThan(480)
  })
})

describe('SC-19: a working agent gets the prompt', () => {
  test('the prompt is typed and send returns working without waiting for a start', async () => {
    scaled('0.1')
    rig = await Rig.start({ sessions: [{ agent: 'codex' }], builtinRules: { codex: quiet('codex') } })
    await rig.hook('codex', claude('UserPromptSubmit', { prompt: 'long job' }))
    rig.show(['codex is thinking'])

    const sent = await rig.send('s1', 'and also this')

    expect(sent.state).toBe('working')
    expect(rig.writes()).toEqual([paste('and also this'), '\r'])
  })
})

describe('SC-20: a start that blocks counts as started', () => {
  test('send reports blocked with its kind, and the CLI prints it', async () => {
    scaled('0.1')
    await idleClaude()
    afterEnter([[100, 'PermissionRequest', bash('npm test', { tool_use_id: 't1' })]])
    const printed: string[] = []

    await commands.send!({ positionals: ['s1', 'run it'], flags: {} } as unknown as CliArgs, cliContext(printed))

    expect(printed).toEqual(['s1: blocked (approval)'])
  })
})

describe('SC-21: shells, exited sessions and unknown sessions are refused', () => {
  test('not-an-agent, session-exited and not-found, with nothing written', async () => {
    rig = await Rig.start({
      sessions: [{ agent: 'shell' }, { id: 's2', status: 'exited', exitCode: 0 }]
    })
    rig.show(['$ '], 's1')

    await expect(rig.send('s1', 'ls')).rejects.toMatchObject(conflict('not-an-agent'))
    await expect(rig.send('s2', 'ls')).rejects.toMatchObject(conflict('session-exited'))
    await expect(rig.send('nosuch', 'ls')).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    expect(rig.writeLog).toEqual([])
  })

  test('a shell session an agent runs in is sent to as that agent', async () => {
    scaled('0.1')
    rig = await Rig.start({ sessions: [{ agent: 'shell' }], builtinRules: { claude: quiet('claude') } })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }))
    rig.show(['> '])

    expect((await rig.send('s1', 'more')).state).toBe('working')
    expect((await rig.delivered())[0]).toMatchObject({ agent: 'claude' })
  })

  test('a session that ended while the text was going in is session-exited', async () => {
    scaled('0.1')
    await idleClaude()
    rig.h.pty.exit('s1', 0)

    await expect(rig.send('s1', 'hello')).rejects.toMatchObject(conflict('session-exited'))
    expect(rig.writes()).toEqual([])
  })
})

describe('SC-22: sends to one session take turns', () => {
  test('each paste and its Enter arrive whole before the other send writes anything', async () => {
    scaled('0.1')
    await idleClaude()
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'x' }]], { every: true })

    const [first, second] = await Promise.all([rig.send('s1', 'first'), rig.send('s1', 'second')])

    expect(first.state).toBe('working')
    expect(second.state).toBe('working')
    const writes = rig.writes()
    expect(writes).toHaveLength(4)
    expect(writes[1]).toBe('\r')
    expect(writes[3]).toBe('\r')
    expect([writes[0], writes[2]].sort()).toEqual([paste('first'), paste('second')])
  })

  test('a send that fails does not hold up the next one', async () => {
    scaled('0.1')
    await idleClaude()
    await expect(rig.send('s1', 'lost', 100)).rejects.toMatchObject(conflict('prompt-stalled'))
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'x' }]])

    expect((await rig.send('s1', 'found')).state).toBe('working')
  })
})

describe('SC-23: a multi-line prompt is one prompt', () => {
  test('both lines travel in one bracketed paste, followed by one Enter', async () => {
    scaled('0.1')
    await idleClaude()
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'x' }]])

    await rig.send('s1', 'line one\nline two')

    expect(rig.writes()).toEqual([paste('line one\rline two'), '\r'])
  })
})

describe('SC-24: a nested helper does not count as a start', () => {
  test("the helper's prompt is ignored, the send stalls and the lead's last event still decides", async () => {
    scaled('0.1')
    rig = await Rig.start({ builtinRules: { claude: quiet('claude') } })
    const lead = { pid: process.pid, pstart: startOf(process.pid) }
    await rig.hook('claude', claude('SessionStart', { source: 'startup', session_id: 'abc' }), lead)
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'fix the tests', session_id: 'abc' }), lead)
    await rig.hook('claude', claude('Stop', { session_id: 'abc', last_assistant_message: 'ok' }), lead)
    rig.show(['> '])
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'summarize this', session_id: 'zzz' }]])

    await expect(rig.send('s1', 'go on', 300)).rejects.toMatchObject(conflict('prompt-stalled'))

    const explained = await rig.explain()
    expect(explained.row).toMatchObject({ because: { event: 'Stop' }, lead: { state: 'done' } })
    expect(await rig.row()).toMatchObject({ prompt: 'fix the tests', lead: { providerSession: 'abc' } })
  })
})

describe('SC-38: an approval that appears before Enter stops the Enter', () => {
  test('the text is left pasted, no Enter is written, and the failure says so', async () => {
    scaled('0.1')
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: cursorRules } })
    rig.show(['> '])
    rig.onWrite(isPaste, () => rig.show(approvalMenu))

    const refused = rig.send('s1', 'rm everything')

    await expect(refused).rejects.toMatchObject(conflict('agent-blocked'))
    await expect(refused).rejects.toThrow('pasted but not submitted')
    expect(rig.writes()).toEqual([paste('rm everything')])
  })
})

describe('SC-39: a retried Enter is never written into an approval', () => {
  test('an agent that shows an approval after the first Enter gets that one Enter and send reports blocked', async () => {
    scaled('0.1')
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: cursorRules } })
    await rig.plan('cursor', { retryMs: 1200 })
    rig.show(['> '])
    rig.onWrite(isEnter, () => void Bun.sleep(30).then(() => rig.show(approvalMenu)))

    const sent = await rig.send('s1', 'rm everything')

    expect(sent).toMatchObject({ state: 'blocked', kind: 'approval' })
    await Bun.sleep(250)
    expect(enters()).toBe(1)
  })

  test('the retry look finds the approval and skips the retry', async () => {
    scaled('1')
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: cursorRules } })
    await rig.plan('cursor', { delayMs: 20, retryMs: 120 })
    rig.show(['> '])
    // the observer looks right after Enter, then next at the retry time: the menu lands between the two
    rig.onWrite(isEnter, () => void Bun.sleep(60).then(() => rig.show(approvalMenu)))

    const sent = await rig.send('s1', 'rm everything')

    expect(sent).toMatchObject({ state: 'blocked', kind: 'approval' })
    expect(enters()).toBe(1)
  })

  test('with nothing to stop it, the Enter is retried once and no more', async () => {
    scaled('1')
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: cursorRules } })
    await rig.plan('cursor', { delayMs: 20, retryMs: 80 })
    rig.show(['> '])

    await expect(rig.send('s1', 'hello', 500)).rejects.toMatchObject(conflict('prompt-stalled'))

    expect(rig.writes()).toEqual([paste('hello'), '\r', '\r'])
  })

  test('an agent that starts after the first Enter is not retried', async () => {
    scaled('1')
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: cursorRules } })
    await rig.plan('cursor', { delayMs: 20, retryMs: 150 })
    rig.show(['> '])
    afterEnter([[30, 'beforeSubmitPrompt', { prompt: 'hello' }]], { agent: 'cursor' })

    const sent = await rig.send('s1', 'hello')

    expect(sent.state).toBe('working')
    await Bun.sleep(200)
    expect(enters()).toBe(1)
  })
})

describe('SC-40: a turn that starts and ends inside the submit window still counts', () => {
  test('send reports idle, not a stall', async () => {
    scaled('1')
    await idleClaude()
    await rig.plan('claude', { delayMs: 20 })
    afterEnter([
      [10, 'UserPromptSubmit', { prompt: 'quick' }],
      [20, 'Stop', { last_assistant_message: 'done' }]
    ])

    const sent = await rig.send('s1', 'quick')

    expect(sent.state).toBe('idle')
  })
})

describe('a row that was working only between two looks', () => {
  test('is still a start, because every commit is read as it lands', async () => {
    scaled('1')
    await idleClaude()
    await rig.plan('claude', { delayMs: 20 })
    // a tool call and the end of the turn, with no UserPromptSubmit, so the row never records a turn start
    afterEnter([
      [0, 'PreToolUse', bash('ls', { tool_use_id: 't1' })],
      [0, 'Stop', { last_assistant_message: 'done' }]
    ])

    const sent = await rig.send('s1', 'list files', 1000)

    expect(sent.state).toBe('idle')
  })
})

describe('how the prompt is typed for each kind of agent', () => {
  test('an agent that takes Enter with the paste gets both in one deliver call', async () => {
    scaled('0.1')
    await idleClaude()
    await rig.plan('claude', { enterWithPaste: true })
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'x' }]])

    expect((await rig.send('s1', 'hello')).state).toBe('working')

    expect(rig.writes()).toEqual([paste('hello') + '\r'])
    expect(await rig.delivered()).toMatchObject([{ submit: true, ready: true }])
  })

  test('an Enter-with-paste agent that also retries is written by send, so the retry gets its look', async () => {
    scaled('1')
    await idleClaude()
    await rig.plan('claude', { enterWithPaste: true, retryMs: 80 })

    await expect(rig.send('s1', 'hello', 400)).rejects.toMatchObject(conflict('prompt-stalled'))

    expect(rig.writes()).toEqual([paste('hello') + '\r', '\r'])
    expect(await rig.delivered()).toEqual([])
  })

  test('an agent quirky.agents does not know is pasted directly with the 500 ms default delay', async () => {
    scaled('0.1')
    await idleClaude()
    await rig.plan('claude', null)
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'x' }]])

    expect((await rig.send('s1', 'hello')).state).toBe('working')

    expect(rig.writes()).toEqual([paste('hello'), '\r'])
    expect(await rig.delivered()).toEqual([])
    const [pasted, entered] = rig.writeLog
    expect(entered!.at - pasted!.at).toBeGreaterThanOrEqual(40)
  })

  test('ESC inside the text cannot close the paste early', async () => {
    scaled('0.1')
    await idleClaude()
    await rig.plan('claude', null)
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'x' }]])

    await rig.send('s1', 'a\x1b[201~b')

    expect(rig.writes()[0]).toBe(paste('a␛[201~b'))
  })
})

describe('the send method refuses bad parameters', () => {
  test('text and startTimeoutMs are checked', async () => {
    rig = await Rig.start()
    await expect(rig.client.callAny('quirky.agent-status/send', { session: 's1' })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    await expect(rig.send('s1', '')).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    await expect(rig.send('s1', 'x', -1)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    await expect(rig.client.callAny('quirky.agent-status/send', { session: 's1', text: 'x', startTimeoutMs: 1.5 })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    expect(rig.writeLog).toEqual([])
  })
})

describe('the send command', () => {
  const run = async (args: Partial<CliArgs>, printed: string[] = []) => {
    await commands.send!({ positionals: [], flags: {}, ...args } as unknown as CliArgs, cliContext(printed))
    return printed
  }

  test('needs exactly one of text and --file', async () => {
    rig = await Rig.start()
    await expect(run({ positionals: ['s1'] })).rejects.toThrow('usage:')
    await expect(run({ positionals: ['s1', 'x'], flags: { file: '/nope' } })).rejects.toThrow('usage:')
    await expect(run({ positionals: [] })).rejects.toThrow('usage: missing <session>')
    expect(rig.writeLog).toEqual([])
  })

  test('--file sends the file without its trailing line break', async () => {
    scaled('0.1')
    await idleClaude()
    afterEnter([[10, 'UserPromptSubmit', { prompt: 'x' }]])
    const file = join(makeTempDir('qas-send-'), 'prompt.txt')
    writeFileSync(file, 'one\ntwo\n')

    expect(await run({ positionals: ['s1'], flags: { file, 'start-timeout-ms': 3000 } })).toEqual(['s1: working'])

    expect(rig.writes()).toEqual([paste('one\rtwo'), '\r'])
  })

  test('an unreadable --file is a usage error', async () => {
    rig = await Rig.start()
    await expect(run({ positionals: ['s1'], flags: { file: '/nonexistent/prompt.txt' } })).rejects.toThrow('usage: --file: cannot read')
  })
})
