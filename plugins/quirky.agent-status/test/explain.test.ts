import { afterEach, describe, expect, test } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type CliContext } from '@quirky/protocol'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { explanationLines, listingLines } from '../cli'
import { ScreenSampler } from '../src/screen'
import { Rig } from './support'

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

const ctx = { env: { HOME: '/home/u' } } as unknown as CliContext

/** A rule file for `agent` that never matches the screens these tests show. */
const quiet = (agent: string) => ({ agent, rules: [{ id: 'never', state: 'working', region: 'screen', all: [{ contains: 'zzz-never' }] }] })

const approvalMenu = {
  agent: 'cursor',
  rules: [
    {
      id: 'approval-menu',
      why: 'cursor has no approval hook',
      state: 'blocked',
      kind: 'approval',
      region: 'screen',
      lastLines: 8,
      all: [{ contains: 'run this command?' }, { regex: '\\((?:esc|y|n)\\)\\s*$' }]
    },
    { id: 'busy', state: 'working', region: 'screen', all: [{ contains: 'working' }] }
  ]
}

describe('SC-1: explain names the hook event behind a blocked Claude session', () => {
  test('state, kind, deciding event, detail and the screen verdict', async () => {
    rig = await Rig.start({ builtinRules: { claude: quiet('claude') } })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'fix the tests' }))
    await rig.hook('claude', claude('PermissionRequest', bash('npm test', { tool_use_id: 't1' })))
    const evidenceAt = (await rig.row())!.evidenceAt
    rig.show(['$ claude', 'working on it'])

    const explained = await rig.explain('s1', evidenceAt + 6000)

    expect(explained).toMatchObject({
      session: 's1',
      name: null,
      agent: 'claude',
      state: 'blocked',
      kind: 'approval',
      decidedBy: 'row',
      summary: 'blocked: waiting for approval of Bash: npm test',
      row: {
        state: 'waiting',
        display: 'waiting',
        detail: 'Bash: npm test',
        source: 'hook',
        fresh: true,
        ageMs: 6000,
        because: { source: 'hook', event: 'PermissionRequest', rule: 'claude PermissionRequest → waiting', at: evidenceAt },
        lead: { state: 'waiting' },
        children: { agent: 0, shell: 0, cron: 0 }
      },
      screen: { verdict: null, ignored: [], origin: { kind: 'built-in' } }
    })
    expect(explained.exit).toBeUndefined()
  })

  test('the text names the event, how long ago and the rule file that matched nothing', async () => {
    rig = await Rig.start({ builtinRules: { claude: quiet('claude') } })
    await rig.hook('claude', claude('PermissionRequest', bash('npm test', { tool_use_id: 't1' })))
    const evidenceAt = (await rig.row())!.evidenceAt
    rig.show(['idle'])

    const lines = explanationLines(await rig.explain('s1', evidenceAt + 6000), ctx)

    expect(lines[0]).toBe('blocked: waiting for approval of Bash: npm test')
    expect(lines[1]).toBe('because: claude PermissionRequest → waiting (hook) 6s ago')
    expect(lines[2]).toMatch(/^row: waiting, shown as waiting, source hook, fresh, last evidence 6s ago, detail Bash: npm test$/)
    expect(lines.some((line) => line.startsWith('fold:'))).toBe(false)
    expect(lines.at(-1)).toMatch(/^screen: no rule matched \(built-in .*claude\.json\)$/)
  })
})

describe('SC-2: explain shows the fold that keeps a finished lead working', () => {
  test('the lead is done, one agent child is running, the state is working', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }))
    await rig.hook('claude', claude('SubagentStart', { agent_id: 'a1' }))
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'launched' }))

    const explained = await rig.explain()

    expect(explained).toMatchObject({
      state: 'working',
      decidedBy: 'row',
      row: { state: 'working', lead: { state: 'done' }, children: { agent: 1, shell: 0, cron: 0 } }
    })
    expect(explained.row!.lead.since).toBeGreaterThan(0)
    const lines = explanationLines(explained, ctx)
    expect(lines.find((line) => line.startsWith('fold:'))).toMatch(/the lead is done since .*; 1 agent still running keep the row working/)
  })
})

describe('SC-3: explain says a silent row is no longer trusted', () => {
  test('a codex row 34 minutes old is unknown and shown as no recent update', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'codex' }], builtinRules: { codex: quiet('codex') } })
    await rig.hook('codex', claude('UserPromptSubmit', { prompt: 'go' }))
    const evidenceAt = (await rig.row())!.evidenceAt
    rig.show(['codex is thinking'])

    const explained = await rig.explain('s1', evidenceAt + 34 * 60_000)

    expect(explained).toMatchObject({
      state: 'unknown',
      decidedBy: 'none',
      row: { display: 'unverifiable', label: 'No recent update', fresh: false, because: { event: 'UserPromptSubmit' } },
      summary: 'unknown: last evidence (hook event UserPromptSubmit) is 34 minutes old, past the 30 minutes limit, and no screen rule matched'
    })
  })

  test('exactly 30 minutes is still trusted', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'codex' }] })
    await rig.hook('codex', claude('UserPromptSubmit', { prompt: 'go' }))
    const evidenceAt = (await rig.row())!.evidenceAt
    expect((await rig.explain('s1', evidenceAt + 30 * 60_000)).state).toBe('working')
    expect((await rig.explain('s1', evidenceAt + 30 * 60_000 + 1)).state).toBe('unknown')
  })
})

describe('SC-4: explain names title, OSC 7501 and inferred evidence', () => {
  test('(a) a title that reads as needs-attention', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'gemini' }] })
    await rig.title('✋ gemini')

    expect(await rig.explain()).toMatchObject({
      state: 'blocked',
      kind: 'approval',
      decidedBy: 'rule',
      row: { source: 'title', because: { source: 'title' } }
    })
    expect((await rig.explain()).row!.because!.rule).toContain('✋ gemini')
    expect((await rig.explain()).row!.because!.rule).toContain('permission')
  })

  test('(b) an OSC 7501 report of a blocked permission', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'myapp' }] })
    await rig.osc('state=blocked:kind=permission')

    const explained = await rig.explain()

    expect(explained).toMatchObject({ state: 'blocked', kind: 'approval', row: { source: 'program-status', because: { source: 'program-status' } } })
    expect(explained.row!.because!.rule).toContain('blocked')
    expect(explained.row!.because!.rule).toContain('permission')
  })

  test('(c) an interrupt inferred from Ctrl+C reads as idle', async () => {
    scaled('0.2')
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'long task' }))
    await rig.write('\x03')
    await Bun.sleep(260)

    expect(await rig.explain()).toMatchObject({
      state: 'idle',
      decidedBy: 'row',
      row: { source: 'inference', because: { source: 'inference', rule: 'Ctrl+C settled with no hook → interrupted' } }
    })
  })
})

describe('SC-5: explain with no row, an exited session and an unknown one', () => {
  test('(a) a running cursor session with no row and a screen that matches nothing', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: approvalMenu } })
    rig.show(['cursor agent', '> '])

    const explained = await rig.explain()

    expect(explained).toMatchObject({
      state: 'unknown',
      decidedBy: 'none',
      row: null,
      agent: 'cursor',
      screen: { verdict: null, origin: { kind: 'built-in' } },
      summary: 'unknown: no hook, title or OSC 7501 report has arrived, and no screen rule matched'
    })
    const lines = explanationLines(explained, ctx)
    expect(lines).toContain('row: none')
    expect(lines.at(-1)).toMatch(/^screen: no rule matched \(built-in .*cursor\.json\)$/)
  })

  test('(b) an exited session gives exited with its exit code, and no screen is read', async () => {
    rig = await Rig.start({ sessions: [{ id: 'gone', agent: 'cursor', status: 'exited', exitCode: 3 }], builtinRules: { cursor: approvalMenu } })

    const explained = await rig.explain('gone')

    expect(explained).toMatchObject({ state: 'exited', decidedBy: 'session', exit: { code: 3, signal: null }, summary: 'exited: the process ended with code 3' })
    expect(rig.h.pty.requests.filter((request) => request.type === 'read')).toEqual([])
  })

  test('(c) an unknown session is not-found', async () => {
    rig = await Rig.start()
    await expect(rig.explain('nosuch')).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
  })

  test('a name resolves like an ID', async () => {
    rig = await Rig.start({ sessions: [{ name: 'builder' }] })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }))
    expect(await rig.explain('Builder')).toMatchObject({ session: 's1', name: 'builder', state: 'working' })
  })

  test('a shell session with no row has no rules to read', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'shell' }] })
    rig.show(['$ '])
    expect(await rig.explain()).toMatchObject({ state: 'unknown', screen: { origin: null, verdict: null } })
    expect(rig.h.pty.requests.filter((request) => request.type === 'read')).toEqual([])
  })
})

describe('SC-6: a screen approval menu outranks a working hook row', () => {
  test('the cursor rule approval-menu decides over the working row, which is still shown', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'cursor' }], builtinRules: { cursor: approvalMenu } })
    await rig.hook('cursor', claude('preToolUse', { tool_name: 'Shell', tool_input: { command: 'rm -rf build' } }))
    rig.show(['agent output', 'Run this command?', '  rm -rf build', '  Run (once) (y)', '  Skip (esc)'])

    const explained = await rig.explain()

    expect(explained).toMatchObject({
      state: 'blocked',
      kind: 'approval',
      decidedBy: 'rule',
      row: { state: 'working', display: 'working' },
      screen: { verdict: { rule: 'approval-menu', state: 'blocked', kind: 'approval', origin: { kind: 'built-in' } } },
      summary: 'blocked: waiting for approval (screen rule approval-menu)'
    })
    expect(explanationLines(explained, ctx).find((line) => line.startsWith('screen:'))).toMatch(/^screen: rule approval-menu matched, blocked approval \(built-in /)
  })
})

describe('SC-9: a user file overrides the whole set without a restart', () => {
  const idleAndMarker = { agent: 'codex', rules: [{ id: 'prompt', state: 'idle', region: 'screen', all: [{ contains: 'ready prompt' }] }] }
  const held = { agent: 'codex', rules: [{ id: 'held', state: 'blocked', kind: 'question', region: 'screen', all: [{ contains: 'custom marker' }] }] }

  test('the user rule wins, the built-ins go unconsulted, and deleting the file brings them back', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'codex' }], builtinRules: { codex: idleAndMarker } })
    rig.show(['ready prompt'])
    expect(await rig.explain()).toMatchObject({ state: 'idle', decidedBy: 'rule', screen: { verdict: { rule: 'prompt', origin: { kind: 'built-in' } } } })

    const path = rig.writeUserRules('codex', held)
    rig.show(['custom marker'])
    expect(await rig.explain()).toMatchObject({
      state: 'blocked',
      kind: 'question',
      screen: { verdict: { rule: 'held', origin: { kind: 'user', path } } }
    })

    rig.show(['ready prompt'])
    expect(await rig.explain()).toMatchObject({ state: 'unknown', screen: { verdict: null, origin: { kind: 'user', path } } })

    unlinkSync(path)
    expect(await rig.explain()).toMatchObject({ state: 'idle', screen: { verdict: { rule: 'prompt', origin: { kind: 'built-in' } } } })
  })
})

describe('SC-10: an invalid user file is ignored with a warning', () => {
  const builtin = { agent: 'codex', rules: [{ id: 'prompt', state: 'idle', region: 'screen', all: [{ contains: 'ready prompt' }] }] }
  const rule = (extra: Record<string, unknown>) => ({ agent: 'codex', rules: [{ id: 'bad', state: 'working', region: 'screen', ...extra }] })

  test.each([
    ['not JSON', 'this is not json', 'not valid JSON'],
    ['missing rules', { agent: 'codex' }, 'rules'],
    ['a repeated group', rule({ all: [{ regex: '(a+)+$' }] }), 'repeats a group that can match in more than one way'],
    ['a backreference', rule({ all: [{ regex: '(x)\\1' }] }), 'backreference'],
    ['an unknown state', { agent: 'codex', rules: [{ id: 'bad', state: 'asleep', region: 'screen', all: [{ contains: 'x' }] }] }, 'state']
  ] as const)('%s', async (_name, body, reason) => {
    rig = await Rig.start({ sessions: [{ agent: 'codex' }], builtinRules: { codex: builtin } })
    const path = rig.writeUserRules('codex', body)
    rig.show(['ready prompt'])

    const explained = await rig.explain()

    expect(explained.screen.verdict).toMatchObject({ rule: 'prompt', origin: { kind: 'built-in' } })
    expect(explained.screen.ignored).toHaveLength(1)
    expect(explained.screen.ignored[0]).toMatchObject({ origin: { kind: 'user', path } })
    expect(explained.screen.ignored[0]!.reason).toContain(reason)
    const warnings = explanationLines(explained, ctx).filter((line) => line.startsWith('warning:'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(reason)

    const listing = (await rig.client.callAny('quirky.agent-status/rules', {})) as { agent: string; ignored: { reason: string }[] }[]
    expect(listing.find((entry) => entry.agent === 'codex')!.ignored[0]!.reason).toContain(reason)
  })
})

describe('SC-12: rules list and show', () => {
  test('one listing per agent with its origin, count and ignored sources', async () => {
    rig = await Rig.start({ builtinRules: { cursor: approvalMenu, claude: quiet('claude') } })
    const userPath = rig.writeUserRules('claude', 'nope')

    const listings = (await rig.client.callAny('quirky.agent-status/rules', {})) as { agent: string; origin: { kind: string; path?: string } | null; rules: number; ignored: { origin: unknown }[] }[]

    expect(listings.map((entry) => entry.agent)).toEqual(['claude', 'cursor'])
    expect(listings[0]).toMatchObject({ agent: 'claude', origin: { kind: 'built-in' }, rules: 1, ignored: [{ origin: { kind: 'user', path: userPath } }] })
    expect(listings[1]).toMatchObject({ agent: 'cursor', origin: { kind: 'built-in' }, rules: 2, ignored: [] })

    const lines = listingLines(listings as Parameters<typeof listingLines>[0], ctx)
    expect(lines[0]).toMatch(/^claude {2}built-in {2}.*claude\.json {2}1 rules$/)
    expect(lines[1]).toMatch(/^ {2}ignored user .*claude\.json: not valid JSON/)
    expect(lines[2]).toMatch(/^cursor {2}built-in {2}.*cursor\.json {2}2 rules$/)
  })

  test('show returns the effective set and its origin, or null', async () => {
    rig = await Rig.start({ builtinRules: { cursor: approvalMenu } })

    const shownRules = (await rig.client.callAny('quirky.agent-status/ruleSet', { agent: 'cursor' })) as { agent: string; origin: { kind: string }; set: { rules: { id: string }[] } }
    expect(shownRules).toMatchObject({ agent: 'cursor', origin: { kind: 'built-in' } })
    expect(shownRules.set.rules.map((r) => r.id)).toEqual(['approval-menu', 'busy'])

    expect(await rig.client.callAny('quirky.agent-status/ruleSet', { agent: 'nobody' })).toBeNull()
    await expect(rig.client.callAny('quirky.agent-status/ruleSet', {})).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  })

  test('the built-in rules are read from the rules folder of the plugin directory', async () => {
    rig = await Rig.start({ builtinRules: { cursor: approvalMenu } })
    const set = (await rig.client.callAny('quirky.agent-status/ruleSet', { agent: 'cursor' })) as { origin: { path: string } }
    expect(set.origin.path.endsWith(join('quirky.agent-status', 'rules', 'cursor.json'))).toBe(true)
  })
})

describe('quiet rules wait for the quiet they need', () => {
  const ready = { agent: 'fake', rules: [{ id: 'ready', state: 'idle', region: 'title', all: [{ regex: '^fake ready' }], quietMs: 1000 }] }

  test('SC-7: a screen quiet for the rule time gives its verdict, after the explain waits it out', async () => {
    scaled('0.5')
    rig = await Rig.start({ sessions: [{ agent: 'fake' }], builtinRules: { fake: ready } })
    await rig.title('fake ready')
    rig.show(['>'])
    rig.output('prompt')

    const started = performance.now()
    const explained = await rig.explain()

    expect(performance.now() - started).toBeGreaterThanOrEqual(450)
    expect(explained).toMatchObject({ state: 'idle', decidedBy: 'rule', screen: { verdict: { rule: 'ready' } } })
    expect(explained.screen.pendingQuiet).toBeUndefined()
  })

  test('SC-7: a screen that keeps changing gives no verdict and names the rule it was waiting on', async () => {
    scaled('0.5')
    rig = await Rig.start({ sessions: [{ agent: 'fake' }], builtinRules: { fake: ready } })
    await rig.title('fake ready')
    rig.show(['>'])
    const timer = setInterval(() => rig.output('.'), 50)
    try {
      expect(await rig.explain()).toMatchObject({
        state: 'unknown',
        screen: { verdict: null, pendingQuiet: 'ready' }
      })
    } finally {
      clearInterval(timer)
    }
  })
})

describe('the title the sampler reads', () => {
  test('a title fact is used, and without one the PTY snapshot title is', async () => {
    const titled = {
      agent: 'fake',
      rules: [
        { id: 'by-fact', state: 'working', region: 'title', all: [{ contains: 'busy by fact' }] },
        { id: 'by-snapshot', state: 'idle', region: 'title', all: [{ contains: 'from snapshot' }] }
      ]
    }
    rig = await Rig.start({ sessions: [{ agent: 'fake' }, { id: 's2', agent: 'fake' }], builtinRules: { fake: titled } })
    rig.show(['x'], 's1')
    rig.show(['x'], 's2')
    await rig.fact({ kind: 'title', title: 'busy by fact' }, 's1')
    rig.h.pty.setSnapshotResult({ ...snapshot, title: 'idle from snapshot' })

    expect(await rig.explain('s1')).toMatchObject({ state: 'working', screen: { verdict: { rule: 'by-fact' } } })
    expect(await rig.explain('s2')).toMatchObject({ state: 'idle', screen: { verdict: { rule: 'by-snapshot' } } })
  })
})

describe('ScreenSampler', () => {
  function fakePty(state: { offset: number; title: string | null; listed?: boolean }) {
    return {
      read: async () => ({ lines: ['a', 'b'], cols: 80, rows: 24, alt: false }),
      list: async () => (state.listed === false ? [] : [{ sessionId: 's1', offset: state.offset }]),
      snapshot: async () => ({ title: state.title })
    } as unknown as ConstructorParameters<typeof ScreenSampler>[0]
  }

  test('quiet is null at the first look, grows while the offset holds and restarts when it moves', async () => {
    const state = { offset: 10, title: null as string | null }
    let now = 1000
    const sampler = new ScreenSampler(fakePty(state), () => undefined, () => now)

    expect((await sampler.sample('s1')).quietForMs).toBeNull()
    now += 400
    expect((await sampler.sample('s1')).quietForMs).toBe(400)
    now += 100
    state.offset = 11
    expect((await sampler.sample('s1')).quietForMs).toBe(0)
    now += 250
    expect(await sampler.sample('s1')).toMatchObject({ offset: 11, quietForMs: 250, lines: ['a', 'b'] })
  })

  test('quiet is reported on the scale of a rule time, so a shrunken test clock still satisfies it', async () => {
    const state = { offset: 1, title: null }
    let now = 0
    const sampler = new ScreenSampler(fakePty(state), () => undefined, () => now, 0.1)
    await sampler.sample('s1')
    now = 100
    expect((await sampler.sample('s1')).quietForMs).toBe(1000)
  })

  test('forgetting a session starts its quiet over', async () => {
    let now = 0
    const sampler = new ScreenSampler(fakePty({ offset: 1, title: null }), () => undefined, () => now)
    await sampler.sample('s1')
    now = 500
    sampler.forget('s1')
    expect((await sampler.sample('s1')).quietForMs).toBeNull()
  })

  test('the title comes from the last title fact, else the snapshot, else empty', async () => {
    const state = { offset: 1, title: 'from snapshot' as string | null }
    const facts = new Map<string, string>()
    const sampler = new ScreenSampler(fakePty(state), (id) => facts.get(id), Date.now)
    expect((await sampler.sample('s1')).title).toBe('from snapshot')
    facts.set('s1', 'from fact')
    expect((await sampler.sample('s1')).title).toBe('from fact')
    facts.clear()
    state.title = null
    expect((await sampler.sample('s1')).title).toBe('')
  })

  test('a session the PTY host does not list has an unknown quiet', async () => {
    const sampler = new ScreenSampler(fakePty({ offset: 1, title: null, listed: false }), () => undefined, Date.now)
    expect(await sampler.sample('s1')).toMatchObject({ offset: 0, quietForMs: null })
    expect((await sampler.sample('s1')).quietForMs).toBeNull()
  })
})

const snapshot = {
  ansi: '',
  cols: 80,
  rows: 24,
  cursor: { x: 0, y: 0 },
  modes: { alternateScreen: false, bracketedPaste: false, mouseTracking: false, applicationCursor: false },
  cwd: '/fake/alpha',
  title: null,
  shellState: 'unsupported' as const,
  offset: 0
}
