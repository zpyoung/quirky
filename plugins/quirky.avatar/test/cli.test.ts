import { describe, expect, test } from 'bun:test'
import type { CliArgs, CliContext } from '@quirky/protocol'
import { commands } from '../cli'

type Calls = { method: string; params: Record<string, unknown> }[]

function harness(handlers: Record<string, (params: Record<string, unknown>) => unknown>, json = false) {
  const calls: Calls = []
  const lines: unknown[] = []
  const ctx = {
    requestBase: 'req',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      const handler = handlers[method]
      if (handler === undefined) throw new Error(`no handler for ${method}`)
      return handler(params)
    },
    out: {
      json,
      result: (value: unknown, text: () => string) => void lines.push(json ? value : text()),
      line: (text: string) => void lines.push(text),
      jsonLine: (value: unknown) => void lines.push(value)
    },
    format: { table: (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.join('|')).join('\n'), record: () => '' },
    env: {},
    cwd: '/',
    readFile: async () => '',
    sleep: async () => {},
    now: () => 0,
    usage: (message: string) => Object.assign(new Error(message), { exit: 2 }),
    fail: (message: string) => Object.assign(new Error(message), { exit: 1 }),
    reconnect: async () => {}
  } as unknown as CliContext
  return { ctx, calls, lines }
}

const args = (positionals: string[] = [], flags: Record<string, unknown> = {}): CliArgs => ({ positionals, flags })
const resolveBy = (table: Record<string, string>) => (params: Record<string, unknown>) => {
  const id = table[String(params.selector)]
  if (id === undefined) throw new Error(`no worktree ${String(params.selector)}`)
  return { id, name: String(params.selector) }
}

describe('quirky avatar handoff', () => {
  test('resolves the worktree and sends one item with every field', async () => {
    const h = harness({
      'quirky.worktree/resolve': resolveBy({ fix: 'wt-1' }),
      'quirky.avatar/handoff': () => ({ results: [{ worktreeId: 'wt-1', ok: true }] })
    })
    await commands.handoff!(
      args(['fix'], {
        goal: 'Fix the build',
        'done-when': 'bun test',
        level: 'local',
        guideline: ['small commits', 'no refactors'],
        switch: ['messaging', 'deploys=false', 'history-rewrite=true'],
        agent: 'codex',
        notes: 'be careful',
        'allow-split': true,
        'shared-goal': 'Ship it'
      }),
      h.ctx
    )
    expect(h.calls).toEqual([
      { method: 'quirky.worktree/resolve', params: { selector: 'fix' } },
      {
        method: 'quirky.avatar/handoff',
        params: {
          items: [
            {
              worktreeId: 'wt-1',
              goal: 'Fix the build',
              doneWhen: 'bun test',
              level: 'local',
              guidelines: ['small commits', 'no refactors'],
              switches: { messaging: true, deploys: false, historyRewrite: true },
              agent: 'codex',
              notes: 'be careful',
              allowSplit: true,
              sharedGoal: { goal: 'Ship it' }
            }
          ]
        }
      }
    ])
    expect(h.lines).toEqual(['Handed off fix to the avatar.'])
  })

  test('sends only what was given, so server defaults apply', async () => {
    const h = harness({ 'quirky.worktree/resolve': resolveBy({ fix: 'wt-1' }), 'quirky.avatar/handoff': () => ({ results: [{ worktreeId: 'wt-1', ok: true }] }) })
    await commands.handoff!(args(['fix'], { goal: 'g', 'done-when': 'd', guideline: 'one', 'allow-messaging': true }), h.ctx)
    expect(h.calls[1]!.params).toEqual({ items: [{ worktreeId: 'wt-1', goal: 'g', doneWhen: 'd', guidelines: ['one'], switches: { messaging: true } }] })
  })

  test('fails with exit 1 and the reason when the item is refused', async () => {
    const h = harness({
      'quirky.worktree/resolve': resolveBy({ fix: 'wt-1' }),
      'quirky.avatar/handoff': () => ({ results: [{ worktreeId: 'wt-1', ok: false, error: "not-eligible: Can't hand off: not a git worktree" }] })
    })
    await expect(commands.handoff!(args(['fix'], { goal: 'g', 'done-when': 'd' }), h.ctx)).rejects.toMatchObject({ exit: 1, message: "not-eligible: Can't hand off: not a git worktree" })
  })

  test('usage errors name the missing or bad argument and make no call', async () => {
    for (const [positionals, flags, message] of [
      [[], { goal: 'g', 'done-when': 'd' }, 'a worktree is required'],
      [['a', 'b'], { goal: 'g', 'done-when': 'd' }, 'hand off one worktree at a time'],
      [['a'], { 'done-when': 'd' }, '--goal is required'],
      [['a'], { goal: 'g' }, '--done-when is required'],
      [['a'], { goal: 'g', 'done-when': 'd', switch: ['teleport'] }, '--switch expects messaging, history-rewrite or deploys, optionally =true or =false, got "teleport"'],
      [['a'], { goal: 'g', 'done-when': 'd', switch: ['deploys=maybe'] }, '--switch expects messaging, history-rewrite or deploys, optionally =true or =false, got "deploys=maybe"']
    ] as [string[], Record<string, unknown>, string][]) {
      const h = harness({})
      await expect(commands.handoff!(args(positionals, flags), h.ctx)).rejects.toMatchObject({ exit: 2, message })
      expect(h.calls).toEqual([])
    }
  })
})

describe('quirky avatar status and report', () => {
  test('status lists handed-off worktrees and how many wait on you', async () => {
    const h = harness({
      'quirky.avatar/status': () => ({ handoffs: [{ worktreeId: 'wt-1', name: 'fix', state: 'working', level: 'full' }], needsYouCount: 2 })
    })
    await commands.status!(args(), h.ctx)
    expect(h.lines).toEqual(['WORKTREE|STATE|LEVEL\nfix|working|full\n2 need you'])
  })

  test('status with nothing handed off says so', async () => {
    const h = harness({ 'quirky.avatar/status': () => ({ handoffs: [], needsYouCount: 0 }) })
    await commands.status!(args(), h.ctx)
    expect(h.lines).toEqual(['Nothing is handed off to the avatar.'])
  })

  test('--json prints the raw model', async () => {
    const model = { handoffs: [], needsYouCount: 0 }
    const h = harness({ 'quirky.avatar/status': () => model }, true)
    await commands.status!(args(), h.ctx)
    expect(h.lines).toEqual([model])
  })

  test('report prints the summary, what needs you and each story', async () => {
    const h = harness({
      'quirky.avatar/report': () => ({
        needsYou: [{ id: 'n1', worktreeId: 'wt-1', kind: 'held-call', title: 'force-push held', detail: {}, actions: [], createdAt: 1, resolvedAt: null, resolution: null }],
        stories: [{ worktreeId: 'wt-1', name: 'fix', switchesOn: ['deploys'], story: 'Fixed two checks.', handedBackWith: ['1 held force-push'] }],
        summary: { decisions: 5, allowed: 3, denied: 1, held: 1, guesses: 2, sleeps: [{ at: 1, durationMs: 60_000 }], keptAwake: true },
        topSkippedCalls: []
      })
    })
    await commands.report!(args(), h.ctx)
    const text = String(h.lines[0])
    expect(text).toContain('5 decisions: 3 allowed, 1 denied, 1 held')
    expect(text).toContain('2 guesses')
    expect(text).toContain('slept 1 time')
    expect(text).toContain('Needs you')
    expect(text).toContain('force-push held')
    expect(text).toContain('fix (deploys on)')
    expect(text).toContain('Fixed two checks.')
    expect(text).toContain('Handed back with: 1 held force-push')
  })
})

describe('quirky avatar log', () => {
  const entry = (seq: number, worktreeId: string | null) => ({ seq, at: Date.UTC(2026, 10, 4, 12, 0, 0), worktreeId, kind: 'gate', data: { decision: 'allow' } })

  test('passes the resolved worktree, limit and before and prints newest first', async () => {
    const h = harness({ 'quirky.worktree/resolve': resolveBy({ fix: 'wt-1' }), 'quirky.avatar/log': () => [entry(9, 'wt-1'), entry(8, null)] })
    await commands.log!(args([], { worktree: 'fix', limit: 5, before: 10 }), h.ctx)
    expect(h.calls[1]).toEqual({ method: 'quirky.avatar/log', params: { worktreeId: 'wt-1', limit: 5, before: 10 } })
    const text = String(h.lines[0]).split('\n')
    expect(text).toHaveLength(2)
    expect(text[0]).toContain('#9')
    expect(text[0]).toContain('gate')
    expect(text[0]).toContain('{"decision":"allow"}')
    expect(text[1]).toContain('#8')
  })

  test('without flags asks for the whole journal', async () => {
    const h = harness({ 'quirky.avatar/log': () => [] })
    await commands.log!(args(), h.ctx)
    expect(h.calls).toEqual([{ method: 'quirky.avatar/log', params: {} }])
    expect(h.lines).toEqual(['The journal is empty.'])
  })
})

describe('quirky avatar take-back', () => {
  test('takes back each named worktree', async () => {
    const h = harness({
      'quirky.worktree/resolve': resolveBy({ a: 'wt-1', b: 'wt-2' }),
      'quirky.avatar/takeBack': () => ({ results: [{ worktreeId: 'wt-1', ok: true, handedBackWith: ['held force-push'] }, { worktreeId: 'wt-2', ok: true, handedBackWith: [] }] })
    })
    await commands['take-back']!(args(['a', 'b']), h.ctx)
    expect(h.calls.at(-1)).toEqual({ method: 'quirky.avatar/takeBack', params: { worktreeIds: ['wt-1', 'wt-2'] } })
    expect(h.lines).toEqual(['Took back wt-1 (handed back with: held force-push)\nTook back wt-2'])
  })

  test('--all takes back everything', async () => {
    const h = harness({ 'quirky.avatar/takeBack': () => ({ results: [] }) })
    await commands['take-back']!(args([], { all: true }), h.ctx)
    expect(h.calls).toEqual([{ method: 'quirky.avatar/takeBack', params: { all: true } }])
    expect(h.lines).toEqual(['Nothing was handed off.'])
  })

  test('needs a worktree or --all, not both', async () => {
    const none = harness({})
    await expect(commands['take-back']!(args(), none.ctx)).rejects.toMatchObject({ exit: 2, message: 'name a worktree or pass --all' })
    const both = harness({})
    await expect(commands['take-back']!(args(['a'], { all: true }), both.ctx)).rejects.toMatchObject({ exit: 2, message: 'name worktrees or pass --all, not both' })
    expect([...none.calls, ...both.calls]).toEqual([])
  })

  test('a worktree that was not handed off is reported rather than hidden', async () => {
    const h = harness({ 'quirky.worktree/resolve': resolveBy({ a: 'wt-1' }), 'quirky.avatar/takeBack': () => ({ results: [] }) })
    await commands['take-back']!(args(['a']), h.ctx)
    expect(h.lines).toEqual(['None of those worktrees was handed off.'])
  })
})
