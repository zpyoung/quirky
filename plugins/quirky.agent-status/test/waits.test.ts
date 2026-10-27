import { afterEach, describe, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode, type CliArgs, type CliContext } from '@quirky/protocol'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { commands } from '../cli'
import { STALE_AFTER_MS } from '../src/model'
import { Rig } from './support'

const SCALE = 'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE'

let rig: Rig
let savedScale: string | undefined
let realNow: typeof Date.now | undefined

afterEach(async () => {
  if (realNow) Date.now = realNow
  realNow = undefined
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

/** A rule file for `agent` that never matches the screens these tests show. */
const quiet = (agent: string) => ({ agent, rules: [{ id: 'never', state: 'working', region: 'screen', all: [{ contains: 'zzz-never' }] }] })

const clineRules = {
  agent: 'cline',
  rules: [
    { id: 'busy', state: 'working', region: 'screen', all: [{ contains: 'working...' }] },
    { id: 'composer', state: 'idle', region: 'screen', lastLines: 3, all: [{ contains: 'type a message' }], quietMs: 1000 }
  ]
}

/** Starts watching a call that has not finished, so a test can act while it waits and look at how it ended. */
const outcome = <T>(call: Promise<T>) =>
  call.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )

const conflict = (reason: string) => ({ code: RpcErrorCode.Conflict, data: { reason } })
const invalid = { code: RpcErrorCode.InvalidParams }

async function startClaude(hooks: [string, Record<string, unknown>?][], options: Parameters<typeof Rig.start>[0] = {}) {
  rig = await Rig.start({ builtinRules: { claude: quiet('claude') }, ...options })
  for (const [name, payload] of hooks) await rig.hook('claude', claude(name, payload))
  rig.show(['> '])
}

const idle = () => startClaude([['UserPromptSubmit', { prompt: 'earlier' }], ['Stop', { last_assistant_message: 'ok' }]])
const working = () => startClaude([['UserPromptSubmit', { prompt: 'go' }]])

type Call = { method: string; params: Record<string, unknown> }

/** A CLI context over the rig's daemon, or over `call` when a test supplies its own daemon stand-in. */
function cliContext(printed: unknown[], overrides: Partial<CliContext> = {}): CliContext {
  return {
    call: (method: string, params?: Record<string, unknown>) => rig.client.callAny(method, params ?? {}),
    out: { json: false, result: (value: unknown, text: () => string) => printed.push(text(), value) },
    usage: (message: string) => new Error(`usage: ${message}`),
    fail: (message: string) => new Error(`fail: ${message}`),
    sleep: (ms: number) => Bun.sleep(ms),
    now: () => Date.now(),
    reconnect: async () => {},
    env: {},
    cwd: '/',
    ...overrides
  } as unknown as CliContext
}

const run = (positionals: string[], flags: Record<string, unknown>, ctx: CliContext) =>
  commands.wait!({ positionals, flags } as unknown as CliArgs, ctx)

describe('SC-25: wait until the agent finishes', () => {
  test('the default wait ends when Stop arrives mid-wait and prints idle', async () => {
    scaled('0.1')
    await working()
    const printed: unknown[] = []

    const waiting = run(['s1'], {}, cliContext(printed))
    await Bun.sleep(150)
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'done' }))
    await waiting

    expect(printed[0]).toBe('s1: idle')
    expect(printed[1]).toMatchObject({ status: 'matched', state: 'idle', decidedBy: 'row' })
  })

  test('the method returns the moment a commit makes the state wanted', async () => {
    scaled('0.1')
    await working()

    const started = Date.now()
    const waiting = rig.wait('s1', { timeoutMs: 10_000 })
    await Bun.sleep(100)
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'done' }))
    const reached = await waiting

    expect(reached).toMatchObject({ status: 'matched', state: 'idle', decidedBy: 'row' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  test('a blocked agent also ends the default wait, with its kind', async () => {
    await working()
    const waiting = rig.wait('s1', { timeoutMs: 10_000 })
    await Bun.sleep(50)
    await rig.hook('claude', claude('PermissionRequest', bash('npm test', { tool_use_id: 't1' })))

    expect(await waiting).toMatchObject({ status: 'matched', state: 'blocked', kind: 'approval' })
  })
})

describe('SC-26: a state already reached returns at once', () => {
  test('idle for --until idle, and blocked for --until working,blocked', async () => {
    await idle()
    const started = Date.now()
    expect(await rig.wait('s1', { until: ['idle'] })).toMatchObject({ status: 'matched', state: 'idle' })
    expect(Date.now() - started).toBeLessThan(1000)
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'again' }))
    await rig.hook('claude', claude('PermissionRequest', bash('rm -rf build', { tool_use_id: 't1' })))

    const printed: unknown[] = []
    await run(['s1'], { until: 'working,blocked' }, cliContext(printed))

    expect(printed[0]).toBe('s1: blocked (approval)')
  })
})

describe('SC-27: a timeout exits 1 with the last state', () => {
  test('pending at the method timeout, and the CLI prints a timeout result and fails', async () => {
    await working()

    const started = Date.now()
    expect(await rig.wait('s1', { until: ['idle'], timeoutMs: 300 })).toMatchObject({ status: 'pending', state: 'working', decidedBy: 'row' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)

    const printed: unknown[] = []
    await expect(run(['s1'], { until: 'idle', 'timeout-ms': 400 }, cliContext(printed))).rejects.toThrow('fail: timed out after 0.4s; s1 is working')
    expect(printed[0]).toBe('timed out after 0.4s; s1 is working')
    expect(printed[1]).toMatchObject({ status: 'timeout', state: 'working' })
  })

  test('a wait longer than a minute spans several calls of at most a minute and ends when the agent does', async () => {
    const clock = { now: 1_000_000 }
    const calls: Call[] = []
    const ctx = cliContext([], {
      now: () => clock.now,
      call: async (method, params = {}) => {
        calls.push({ method, params })
        clock.now += Number(params.timeoutMs)
        const done = calls.length === 3
        return done ? { status: 'matched', state: 'idle', decidedBy: 'row', at: clock.now } : { status: 'pending', state: 'working', decidedBy: 'row', at: clock.now }
      }
    })

    await run(['s1'], { until: 'idle', 'timeout-ms': 150_000 }, ctx)
    expect(calls.map((call) => call.params.timeoutMs)).toEqual([60_000, 60_000, 30_000])

    calls.length = 0
    clock.now = 0
    const never = cliContext([], {
      now: () => clock.now,
      call: async (method, params = {}) => {
        calls.push({ method, params })
        clock.now += Number(params.timeoutMs)
        return { status: 'pending', state: 'working', decidedBy: 'row', at: clock.now }
      }
    })
    await expect(run(['s1'], { 'timeout-ms': 150_000 }, never)).rejects.toThrow('timed out after 150s; s1 is working')
    expect(calls.map((call) => call.params.timeoutMs)).toEqual([60_000, 60_000, 30_000])
  })

  test('a lost connection is re-established and an answered error is rethrown', async () => {
    let reconnects = 0
    let attempts = 0
    const flaky = cliContext([], {
      reconnect: async () => {
        reconnects += 1
      },
      sleep: async () => {},
      call: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connection lost')
        return { status: 'matched', state: 'idle', decidedBy: 'row', at: 1 }
      }
    })
    await run(['s1'], {}, flaky)
    expect(reconnects).toBe(1)

    const refusing = cliContext([], {
      call: async () => {
        throw new RpcError(RpcErrorCode.NotFound, 'no such session: nosuch')
      }
    })
    await expect(run(['nosuch'], {}, refusing)).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
  })
})

describe('SC-28: an exited session ends a wait', () => {
  test('the default wait fails with session-exited, --until exited matches', async () => {
    scaled('0.1')
    await working()
    const waiting = outcome(rig.wait('s1', { timeoutMs: 10_000 }))
    await Bun.sleep(100)
    await rig.exit()
    expect(await waiting).toMatchObject({ error: conflict('session-exited') })

    await expect(rig.wait('s1')).rejects.toMatchObject(conflict('session-exited'))
    const printed: unknown[] = []
    await run(['s1'], { until: 'exited' }, cliContext(printed))
    expect(printed[0]).toBe('s1: exited')
    expect(printed[1]).toMatchObject({ status: 'matched', state: 'exited', decidedBy: 'session' })
  })

  test('a session that exits while waited on for exited ends the wait at once', async () => {
    scaled('0.1')
    await working()
    const started = Date.now()
    const waiting = rig.wait('s1', { until: ['exited'], timeoutMs: 10_000 })
    await Bun.sleep(100)
    await rig.exit()

    expect(await waiting).toMatchObject({ status: 'matched', state: 'exited' })
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

describe('SC-29: a hookless agent follows its screen rules', () => {
  test('idle is reached once the composer has been quiet for the rule time, naming the rule', async () => {
    scaled('0.1')
    rig = await Rig.start({ sessions: [{ agent: 'cline' }], builtinRules: { cline: clineRules } })
    rig.show(['working...'])
    rig.output('a')

    const started = Date.now()
    const waiting = rig.wait('s1', { until: ['idle'], timeoutMs: 10_000 })
    await Bun.sleep(100)
    expect(await rig.explain()).toMatchObject({ state: 'working', decidedBy: 'rule' })
    rig.show(['', 'type a message'])
    rig.output('b')
    const changedAt = Date.now()
    const reached = await waiting

    expect(reached).toMatchObject({ status: 'matched', state: 'idle', decidedBy: 'rule', rule: 'composer' })
    expect(Date.now() - changedAt).toBeGreaterThanOrEqual(90)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('freshness without a commit', () => {
  test('a row that goes stale while waited on ends a wait for unknown', async () => {
    scaled('0.1')
    realNow = Date.now
    const real = realNow
    let skew = 0
    Date.now = () => real() + skew
    await working()
    skew = STALE_AFTER_MS - 300

    const started = real()
    const reached = await rig.wait('s1', { until: ['unknown'], timeoutMs: 5000 })

    expect(reached).toMatchObject({ status: 'matched', state: 'unknown', decidedBy: 'none' })
    expect(real() - started).toBeLessThan(2000)
  })
})

describe('SC-30: wait for output that matches a pattern', () => {
  test('(a) text already on the screen returns at once with its line', async () => {
    rig = await Rig.start({})
    rig.show(['build: 3 tests'])
    const printed: unknown[] = []

    const started = Date.now()
    await run(['s1'], { output: 'tests' }, cliContext(printed))

    expect(Date.now() - started).toBeLessThan(1500)
    expect(printed[1]).toMatchObject({ status: 'matched', line: 'build: 3 tests', match: 'tests', groups: [] })
    expect(printed[0]).toBe('build: 3 tests')
  })

  test('(b) new text is matched when it appears, with its group', async () => {
    scaled('0.1')
    rig = await Rig.start({})
    rig.show(['build: 3 tests'])
    rig.output('build: 3 tests\r\n')

    const waiting = rig.waitOutput('s1', 'All (\\d+) passed', { timeoutMs: 10_000 })
    await Bun.sleep(100)
    rig.show(['build: 3 tests', 'All 12 passed'])
    rig.output('All 12 passed\r\n')

    expect(await waiting).toMatchObject({ status: 'matched', line: 'All 12 passed', match: 'All 12 passed', groups: ['12'] })
  })

  test('(b) the CLI prints the line and the group', async () => {
    scaled('0.1')
    rig = await Rig.start({})
    rig.show(['All 12 passed'])
    const printed: unknown[] = []

    await run(['s1'], { output: 'All (\\d+) passed' }, cliContext(printed))

    expect(printed[0]).toBe('All 12 passed\ngroup 1: 12')
  })

  test('(c) --ignore-case matches regardless of case, and without it the case counts', async () => {
    rig = await Rig.start({})
    rig.show(['build ok', 'All 12 passed'])

    expect(await rig.waitOutput('s1', 'all 12', { ignoreCase: true })).toMatchObject({ status: 'matched', line: 'All 12 passed' })
    expect(await rig.waitOutput('s1', 'all 12', { timeoutMs: 100 })).toMatchObject({ status: 'pending' })
    const printed: unknown[] = []
    await run(['s1'], { output: 'all 12', 'ignore-case': true }, cliContext(printed))
    expect(printed[0]).toBe('All 12 passed')
  })

  test('(d) a line the terminal wrapped across two rows is matched as one line', async () => {
    rig = await Rig.start({})
    rig.terminal(['$ run', 'all tests pa', { text: 'ssed on ci', wrapped: true }])

    expect(await rig.waitOutput('s1', 'passed on ci')).toMatchObject({ status: 'matched', line: 'all tests passed on ci' })
  })

  test('the newest matching line wins', async () => {
    rig = await Rig.start({})
    rig.show(['step 1 ok', 'step 2 ok', '> '])

    expect(await rig.waitOutput('s1', 'step (\\d)')).toMatchObject({ line: 'step 2 ok', groups: ['2'] })
  })
})

describe('SC-31: output waits read recent scrollback and reject bad patterns', () => {
  const scrollbackWith = (text: string, rowsAbove: number) => {
    const rows = Array.from({ length: 400 }, (_, index) => `filler ${index}`)
    rows[rows.length - rowsAbove] = text
    return rows
  }

  test('(a) a line 150 rows above the screen is read by default', async () => {
    rig = await Rig.start({})
    rig.terminal(['> '], scrollbackWith('needle', 150))

    expect(await rig.waitOutput('s1', 'needle')).toMatchObject({ status: 'matched', line: 'needle' })
  })

  test('(b) a line 250 rows above needs --lines', async () => {
    rig = await Rig.start({})
    rig.terminal(['> '], scrollbackWith('needle', 250))

    expect(await rig.waitOutput('s1', 'needle', { timeoutMs: 100 })).toMatchObject({ status: 'pending' })
    expect(await rig.waitOutput('s1', 'needle', { lines: 300 })).toMatchObject({ status: 'matched', line: 'needle' })
    const printed: unknown[] = []
    await run(['s1'], { output: 'needle', lines: 300 }, cliContext(printed))
    expect(printed[0]).toBe('needle')
    expect(await rig.waitOutput('s1', 'filler 399', { lines: 0, timeoutMs: 100 })).toMatchObject({ status: 'pending', at: expect.any(Number) })
  })

  test('(c) and (d) a pattern that does not compile or is unsafe is a usage error before the daemon is called', async () => {
    rig = await Rig.start({})
    const calls: Call[] = []
    const ctx = cliContext([], {
      call: async (method, params = {}) => {
        calls.push({ method, params })
        return {}
      }
    })

    await expect(run(['s1'], { output: '([a-z' }, ctx)).rejects.toThrow('usage: --output pattern does not compile')
    await expect(run(['s1'], { output: '(a+)+$' }, ctx)).rejects.toThrow('usage: --output pattern repeats a group')
    expect(calls).toEqual([])

    await expect(rig.waitOutput('s1', '([a-z')).rejects.toMatchObject(invalid)
    await expect(rig.waitOutput('s1', '(a+)+$')).rejects.toMatchObject(invalid)
  })

  test('(e) nothing matching before --timeout-ms is a timeout result naming the pattern, exit 1', async () => {
    rig = await Rig.start({})
    rig.show(['nothing here'])
    const printed: unknown[] = []

    await expect(run(['s1'], { output: 'zzz', 'timeout-ms': 300 }, cliContext(printed))).rejects.toThrow('fail: timed out after 0.3s; no line matched zzz')
    expect(printed[1]).toEqual({ status: 'timeout', pattern: 'zzz' })
  })

  test('(f) a session that prints the line and exits is matched before the exit counts', async () => {
    scaled('0.1')
    rig = await Rig.start({})
    rig.show(['working'])
    rig.output('working\r\n')

    const waiting = rig.waitOutput('s1', 'bye (\\w+)', { timeoutMs: 10_000 })
    await Bun.sleep(100)
    rig.show(['working', 'bye now'])
    await rig.exit()

    expect(await waiting).toMatchObject({ status: 'matched', line: 'bye now', groups: ['now'] })
  })

  test('(f) an already exited session is read once for its final text', async () => {
    rig = await Rig.start({ sessions: [{ id: 's2', status: 'exited', exitCode: 0 }] })
    rig.show(['last words: done'], 's2')

    expect(await rig.waitOutput('s2', 'last words: (\\w+)')).toMatchObject({ status: 'matched', groups: ['done'] })
  })

  test('(g) a session that exits without ever printing a match fails with session-exited', async () => {
    scaled('0.1')
    rig = await Rig.start({ sessions: [{}, { id: 's2', status: 'exited', exitCode: 0 }] })
    rig.show(['nothing to see'])

    await expect(rig.waitOutput('s2', 'zzz')).rejects.toMatchObject(conflict('session-exited'))

    const waiting = outcome(rig.waitOutput('s1', 'zzz', { timeoutMs: 10_000 }))
    await Bun.sleep(100)
    await rig.exit()
    expect(await waiting).toMatchObject({ error: conflict('session-exited') })
  })

  test('an unknown session is not-found', async () => {
    rig = await Rig.start({})

    await expect(rig.waitOutput('nosuch', 'a')).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await expect(rig.wait('nosuch')).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
  })
})

describe('SC-41: a pattern that runs too long is cut off', () => {
  test('(b) waiting for it fails with invalid-params naming the pattern as too slow, and the daemon keeps answering', async () => {
    scaled('0.1')
    rig = await Rig.start({})
    rig.show([`${'a'.repeat(2000)}!`])

    await expect(rig.waitOutput('s1', 'a+a+a+a+$')).rejects.toMatchObject({ ...invalid, message: expect.stringContaining('pattern is too slow') })

    rig.show(['build: 3 tests'])
    expect(await rig.waitOutput('s1', 'tests')).toMatchObject({ status: 'matched', line: 'build: 3 tests' })
  }, 15_000)
})

describe('parameters', () => {
  test('a bad until, timeout or line count is invalid-params', async () => {
    rig = await Rig.start({})
    rig.show(['x'])

    await expect(rig.wait('s1', { until: ['sleeping'] })).rejects.toMatchObject(invalid)
    await expect(rig.wait('s1', { until: [] })).rejects.toMatchObject(invalid)
    await expect(rig.wait('s1', { timeoutMs: 60_001 })).rejects.toMatchObject(invalid)
    await expect(rig.wait('s1', { timeoutMs: -1 })).rejects.toMatchObject(invalid)
    await expect(rig.waitOutput('s1', 'x', { lines: 2001 })).rejects.toMatchObject(invalid)
    await expect(rig.waitOutput('s1', '')).rejects.toMatchObject(invalid)
  })

  test('a name works wherever a session ID does', async () => {
    rig = await Rig.start({ sessions: [{ name: 'reviewer' }] })
    rig.show(['build: 3 tests'])

    expect(await rig.waitOutput('reviewer', 'tests')).toMatchObject({ status: 'matched' })
    expect(await rig.wait('reviewer', { until: ['unknown'], timeoutMs: 0 })).toMatchObject({ status: 'matched', state: 'unknown' })
  })
})
