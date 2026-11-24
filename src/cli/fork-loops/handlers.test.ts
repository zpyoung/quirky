import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { LOOPS_CHANNELS } from '../../shared/fork-loops/api'
import { LOOPS_RUNTIME_CAPABILITY } from '../../shared/fork-loops/capability'
import { LoopCreateInputSchema, type LoopSnapshot } from '../../shared/fork-loops/loop-types'
import { COMMAND_SPECS } from '../specs'
import { HANDLER_GROUPS } from '../handler-group-manifest'
import type { HandlerContext } from '../dispatch'
import { LOOP_HANDLERS } from './handlers'

const callMock = vi.fn()
const WORKTREE_ID = 'repo-1::/repo'

function snapshot(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    id: 'loop-1',
    worktreeId: WORKTREE_ID,
    name: 'fix tests',
    agent: 'claude',
    preset: 'until-done',
    config: {
      promptSource: { kind: 'repeat', body: 'fix the tests' },
      pacing: { kind: 'on-idle' },
      sessionPolicy: 'fresh',
      done: {},
      caps: { maxIterations: 10 },
      noProgress: false,
      checkpointCommits: false,
      askBeforeNext: false,
      resumeAtLimitReset: false
    },
    state: 'running',
    iterationsCompleted: 2,
    detached: false,
    skippedTicks: 0,
    activeMs: 1000,
    recentIterations: [],
    ...overrides
  }
}

function response<T>(result: T) {
  return { id: 'rpc-1', ok: true, result }
}

function context(
  flags: [string, string | boolean][],
  overrides: { json?: boolean } = {}
): HandlerContext {
  return {
    flags: new Map(flags),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers under test call only client.call; RuntimeClient's other members are unused.
    client: { call: callMock } as unknown as HandlerContext['client'],
    cwd: '/repo',
    json: overrides.json ?? false
  }
}

function primeCapabilities(capabilities: string[] = [LOOPS_RUNTIME_CAPABILITY]): void {
  callMock.mockResolvedValueOnce(response({ capabilities }))
}

function rpcCalls(): [string, unknown][] {
  return callMock.mock.calls
    .filter(([method]) => typeof method === 'string' && method.startsWith('loops:'))
    .map(([method, params]) => [method, params])
}

beforeEach(() => {
  callMock.mockReset()
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('quirky loop capability gate', () => {
  it.each<[string, [string, string][]]>([
    [
      'loop create',
      [
        ['worktree', `id:${WORKTREE_ID}`],
        ['agent', 'claude'],
        ['prompt', 'go']
      ]
    ],
    ['loop list', []],
    ['loop show', [['loop-id', 'loop-1']]],
    ['loop pause', [['loop-id', 'loop-1']]],
    ['loop resume', [['loop-id', 'loop-1']]],
    ['loop stop', [['loop-id', 'loop-1']]],
    [
      'loop steer',
      [
        ['loop-id', 'loop-1'],
        ['text', 'hint']
      ]
    ],
    [
      'loop edit',
      [
        ['loop-id', 'loop-1'],
        ['name', 'renamed']
      ]
    ]
  ])('%s throws incompatible_runtime when loops.v1 is missing', async (command, flags) => {
    primeCapabilities(['something.else'])

    await expect(LOOP_HANDLERS[command](context(flags))).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('status.get')
  })

  it('treats an absent capabilities list as unsupported', async () => {
    callMock.mockResolvedValueOnce(response({}))

    await expect(LOOP_HANDLERS['loop list'](context([]))).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })
})

describe('quirky loop create', () => {
  it('maps every flag to a LoopCreateInput', async () => {
    primeCapabilities()
    callMock
      .mockResolvedValueOnce(response({ worktree: { id: WORKTREE_ID } }))
      .mockResolvedValueOnce(response(snapshot({ preset: 'interval' })))

    await LOOP_HANDLERS['loop create'](
      context([
        ['worktree', `id:${WORKTREE_ID}`],
        ['name', 'babysit pr'],
        ['agent', 'codex'],
        ['preset', 'interval'],
        ['prompt', 'check the PR'],
        ['every', '10'],
        ['anchor', 'wall-clock'],
        ['session', 'fresh'],
        ['check', 'gh pr checks'],
        ['check-timeout', '120'],
        ['check-when', 'on-claim'],
        ['evaluator', 'CI is green'],
        ['max-iterations', '8'],
        ['max-minutes', '480'],
        ['max-cost', '2.5'],
        ['no-progress', true],
        ['protected-path', ['src/**', 'package.json'].join('\u0000')],
        ['checkpoint-commits', true],
        ['ask-before-next', true],
        ['resume-at-reset', true]
      ])
    )

    expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: `id:${WORKTREE_ID}` })
    const [[method, params]] = rpcCalls()
    expect(method).toBe(LOOPS_CHANNELS.create)
    expect(params).toEqual({
      worktreeId: WORKTREE_ID,
      name: 'babysit pr',
      agent: 'codex',
      preset: 'interval',
      config: {
        promptSource: { kind: 'repeat', body: 'check the PR' },
        pacing: { kind: 'interval', minutes: 10, anchor: 'wall-clock' },
        sessionPolicy: 'fresh',
        done: {
          check: { command: 'gh pr checks', timeoutSeconds: 120, runWhen: 'on-claim' },
          evaluator: { condition: 'CI is green' }
        },
        caps: { maxIterations: 8, maxActiveMinutes: 480, maxCostUsd: 2.5 },
        noProgress: true,
        protectedPaths: ['src/**', 'package.json'],
        checkpointCommits: true,
        askBeforeNext: true,
        resumeAtLimitReset: true
      }
    })
    expect(LoopCreateInputSchema.safeParse(params).success).toBe(true)
  })

  it('applies preset defaults for an until-done loop', async () => {
    primeCapabilities()
    callMock
      .mockResolvedValueOnce(response({ worktree: { id: WORKTREE_ID } }))
      .mockResolvedValueOnce(response(snapshot()))

    await LOOP_HANDLERS['loop create'](
      context([
        ['worktree', `id:${WORKTREE_ID}`],
        ['agent', 'claude'],
        ['prompt', 'fix the tests'],
        ['check', 'pnpm test']
      ])
    )

    const [[, params]] = rpcCalls()
    expect(LoopCreateInputSchema.parse(params)).toMatchObject({
      preset: 'until-done',
      config: {
        promptSource: { kind: 'repeat', body: 'fix the tests' },
        pacing: { kind: 'on-idle' },
        sessionPolicy: 'fresh',
        done: { check: { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' } },
        caps: {},
        noProgress: false,
        checkpointCommits: false,
        askBeforeNext: false,
        resumeAtLimitReset: false
      }
    })
  })

  it('creates a queue loop with its items in the single create call', async () => {
    primeCapabilities()
    callMock
      .mockResolvedValueOnce(response({ worktree: { id: WORKTREE_ID } }))
      .mockResolvedValueOnce(response(snapshot({ preset: 'queue' })))

    await LOOP_HANDLERS['loop create'](
      context([
        ['worktree', `id:${WORKTREE_ID}`],
        ['agent', 'claude'],
        ['preset', 'queue'],
        ['queue-item', ['first', 'second'].join('\u0000')],
        ['repeat-queue', true]
      ])
    )

    const calls = rpcCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(LOOPS_CHANNELS.create)
    expect(calls[0][1]).toMatchObject({
      preset: 'queue',
      queueItems: ['first', 'second'],
      config: {
        promptSource: { kind: 'queue', repeatQueue: true },
        pacing: { kind: 'on-idle' },
        sessionPolicy: 'continue'
      }
    })
    expect(LoopCreateInputSchema.safeParse(calls[0][1]).success).toBe(true)
  })

  it.each<[string, [string, string][]]>([
    ['an until-done loop with no prompt', [['agent', 'claude']]],
    [
      'an interval loop with no --every',
      [
        ['agent', 'claude'],
        ['preset', 'interval'],
        ['prompt', 'x']
      ]
    ],
    [
      'a queue loop with no items',
      [
        ['agent', 'claude'],
        ['preset', 'queue']
      ]
    ],
    [
      '--every on a non-interval preset',
      [
        ['agent', 'claude'],
        ['prompt', 'x'],
        ['every', '5']
      ]
    ],
    [
      'an unknown agent',
      [
        ['agent', 'nope'],
        ['prompt', 'x']
      ]
    ],
    [
      'a non-integer --max-iterations',
      [
        ['agent', 'claude'],
        ['prompt', 'x'],
        ['max-iterations', '2.5']
      ]
    ]
  ])('rejects %s before calling create', async (_label, flags) => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response({ worktree: { id: WORKTREE_ID } }))

    await expect(
      LOOP_HANDLERS['loop create'](context([['worktree', `id:${WORKTREE_ID}`], ...flags]))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(rpcCalls()).toEqual([])
  })

  it('prints the raw response envelope with --json', async () => {
    primeCapabilities()
    const created = response(snapshot())
    callMock
      .mockResolvedValueOnce(response({ worktree: { id: WORKTREE_ID } }))
      .mockResolvedValueOnce(created)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop create'](
      context(
        [
          ['worktree', `id:${WORKTREE_ID}`],
          ['agent', 'claude'],
          ['prompt', 'go']
        ],
        { json: true }
      )
    )

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(created)
  })

  it('prints the running-loop warning in human output', async () => {
    primeCapabilities()
    callMock
      .mockResolvedValueOnce(response({ worktree: { id: WORKTREE_ID } }))
      .mockResolvedValueOnce(response(snapshot({ warnings: ['worktree-has-running-loop'] })))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop create'](
      context([
        ['worktree', `id:${WORKTREE_ID}`],
        ['agent', 'claude'],
        ['prompt', 'go']
      ])
    )

    expect(log.mock.calls.join('\n')).toContain(
      'Warning: another loop is already running in this worktree'
    )
  })
})

describe('quirky loop read commands', () => {
  it('lists loops, filtering by worktree', async () => {
    primeCapabilities()
    callMock
      .mockResolvedValueOnce(response({ worktree: { id: WORKTREE_ID } }))
      .mockResolvedValueOnce(response([snapshot()]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop list'](context([['worktree', `id:${WORKTREE_ID}`]]))

    expect(rpcCalls()).toEqual([[LOOPS_CHANNELS.list, { worktreeId: WORKTREE_ID }]])
    const output = log.mock.calls.join('\n')
    expect(output).toContain('loop-1')
    expect(output).toContain('fix tests')
    expect(output).toContain('2/10')
  })

  it('lists every loop when no worktree is given', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response([]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop list'](context([]))

    expect(rpcCalls()).toEqual([[LOOPS_CHANNELS.list, {}]])
    expect(log.mock.calls.join('\n')).toContain('No loops')
  })

  it('shows a paused loop with its reason', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(
      response(snapshot({ state: 'paused', pauseReason: 'no-progress' }))
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop show'](context([['loop-id', 'loop-1']]))

    expect(rpcCalls()).toEqual([[LOOPS_CHANNELS.get, { loopId: 'loop-1' }]])
    expect(log.mock.calls.join('\n')).toContain('paused: no-progress')
  })

  it('shows an unverifiable loop as unverifiable, not running', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot({ unverifiableSince: 1_700_000_000_000 })))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop show'](context([['loop-id', 'loop-1']]))

    const output = log.mock.calls.join('\n')
    expect(output).toContain('Status: unverifiable')
    expect(output).toContain('Host unreachable since 2023-11-14T22:13:20.000Z')
  })

  it('reports skipped ticks in show and list, and omits them when there are none', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot({ skippedTicks: 3 })))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await LOOP_HANDLERS['loop show'](context([['loop-id', 'loop-1']]))
    expect(log.mock.calls.join('\n')).toContain('Ticks skipped: 3')

    log.mockClear()
    primeCapabilities()
    callMock.mockResolvedValueOnce(
      response([snapshot({ skippedTicks: 1 }), snapshot({ id: 'loop-2' })])
    )
    await LOOP_HANDLERS['loop list'](context([]))
    const rows = log.mock.calls.join('\n').split('\n')
    expect(rows[0]).toContain('1 tick skipped')
    expect(rows[1]).not.toContain('skipped')
  })

  it('prints the raw envelope for list with --json', async () => {
    primeCapabilities()
    const listed = response([snapshot()])
    callMock.mockResolvedValueOnce(listed)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop list'](context([], { json: true }))

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(listed)
  })
})

describe('quirky loop control commands', () => {
  it('pauses after the current iteration', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot({ state: 'running' })))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop pause'](context([['loop-id', 'loop-1']]))

    expect(rpcCalls()).toEqual([
      [LOOPS_CHANNELS.pause, { loopId: 'loop-1', mode: 'after-iteration' }]
    ])
  })

  it('resumes with extra iterations', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot()))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop resume'](
      context([
        ['loop-id', 'loop-1'],
        ['add-iterations', '5']
      ])
    )

    expect(rpcCalls()).toEqual([[LOOPS_CHANNELS.resume, { loopId: 'loop-1', addIterations: 5 }]])
  })

  it('resumes without an iteration grant by default', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot()))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop resume'](context([['loop-id', 'loop-1']]))

    expect(rpcCalls()).toEqual([[LOOPS_CHANNELS.resume, { loopId: 'loop-1' }]])
  })

  it.each(['0', '-1', '1.5', 'abc'])('rejects --add-iterations %s', async (value) => {
    primeCapabilities()

    await expect(
      LOOP_HANDLERS['loop resume'](
        context([
          ['loop-id', 'loop-1'],
          ['add-iterations', value]
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(rpcCalls()).toEqual([])
  })

  it('stops after the iteration by default and immediately with --now', async () => {
    const stopped = response(snapshot({ state: 'stopped' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    primeCapabilities()
    callMock.mockResolvedValueOnce(stopped)
    await LOOP_HANDLERS['loop stop'](context([['loop-id', 'loop-1']]))
    primeCapabilities()
    callMock.mockResolvedValueOnce(stopped)
    await LOOP_HANDLERS['loop stop'](
      context([
        ['loop-id', 'loop-1'],
        ['now', true]
      ])
    )

    expect(rpcCalls()).toEqual([
      [LOOPS_CHANNELS.stop, { loopId: 'loop-1', mode: 'after-iteration' }],
      [LOOPS_CHANNELS.stop, { loopId: 'loop-1', mode: 'now' }]
    ])
  })

  it('sends a steer note', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot()))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop steer'](
      context([
        ['loop-id', 'loop-1'],
        ['text', 'focus on the parser']
      ])
    )

    expect(rpcCalls()).toEqual([
      [LOOPS_CHANNELS.steer, { loopId: 'loop-1', text: 'focus on the parser' }]
    ])
  })
})

describe('quirky loop edit', () => {
  it('sends only the sections the flags touch, merged with the current config', async () => {
    primeCapabilities()
    const current = snapshot()
    current.config.done = {
      check: { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' }
    }
    callMock
      .mockResolvedValueOnce(response(current))
      .mockResolvedValueOnce(response(snapshot({ name: 'renamed' })))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop edit'](
      context([
        ['loop-id', 'loop-1'],
        ['name', 'renamed'],
        ['prompt', 'new prompt'],
        ['evaluator', 'no skipped tests'],
        ['max-minutes', '60']
      ])
    )

    expect(rpcCalls()).toEqual([
      [LOOPS_CHANNELS.get, { loopId: 'loop-1' }],
      [
        LOOPS_CHANNELS.edit,
        {
          loopId: 'loop-1',
          patch: {
            name: 'renamed',
            promptSource: { kind: 'repeat', body: 'new prompt' },
            done: {
              check: { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' },
              evaluator: { condition: 'no skipped tests' }
            },
            caps: { maxIterations: 10, maxActiveMinutes: 60 }
          }
        }
      ]
    ])
  })

  it('clears the done signals, caps, and protected paths named by the --no- flags', async () => {
    primeCapabilities()
    const current = snapshot()
    current.config.done = {
      check: { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' },
      evaluator: { condition: 'no skipped tests' }
    }
    current.config.caps = { maxIterations: 10, maxActiveMinutes: 60, maxCostUsd: 5 }
    current.config.protectedPaths = ['secrets/**']
    callMock.mockResolvedValueOnce(response(current)).mockResolvedValueOnce(response(snapshot()))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop edit'](
      context([
        ['loop-id', 'loop-1'],
        ['no-check', true],
        ['no-max-iterations', true],
        ['no-max-minutes', true],
        ['no-max-cost', true],
        ['no-protected-paths', true]
      ])
    )

    expect(rpcCalls()[1]).toEqual([
      LOOPS_CHANNELS.edit,
      {
        loopId: 'loop-1',
        patch: {
          done: { evaluator: { condition: 'no skipped tests' } },
          caps: {},
          protectedPaths: []
        }
      }
    ])
  })

  it('clears only the evaluator with --no-evaluator and keeps the check', async () => {
    primeCapabilities()
    const current = snapshot()
    const check = { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' } as const
    current.config.done = { check, evaluator: { condition: 'no skipped tests' } }
    callMock.mockResolvedValueOnce(response(current)).mockResolvedValueOnce(response(snapshot()))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await LOOP_HANDLERS['loop edit'](
      context([
        ['loop-id', 'loop-1'],
        ['no-evaluator', true]
      ])
    )

    expect(rpcCalls()[1]).toEqual([
      LOOPS_CHANNELS.edit,
      { loopId: 'loop-1', patch: { done: { check } } }
    ])
  })

  it.each<[string, [string, string | boolean][]]>([
    [
      '--no-check',
      [
        ['no-check', true],
        ['check', 'pnpm test']
      ]
    ],
    [
      '--no-check',
      [
        ['no-check', true],
        ['check-timeout', '30']
      ]
    ],
    [
      '--no-evaluator',
      [
        ['no-evaluator', true],
        ['evaluator', 'done']
      ]
    ],
    [
      '--no-max-iterations',
      [
        ['no-max-iterations', true],
        ['max-iterations', '5']
      ]
    ],
    [
      '--no-max-minutes',
      [
        ['no-max-minutes', true],
        ['max-minutes', '5']
      ]
    ],
    [
      '--no-max-cost',
      [
        ['no-max-cost', true],
        ['max-cost', '5']
      ]
    ],
    [
      '--no-protected-paths',
      [
        ['no-protected-paths', true],
        ['protected-path', 'secrets/**']
      ]
    ]
  ])('rejects %s combined with its setting flag', async (_name, flags) => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot()))

    await expect(
      LOOP_HANDLERS['loop edit'](context([['loop-id', 'loop-1'], ...flags]))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(rpcCalls().map(([method]) => method)).toEqual([LOOPS_CHANNELS.get])
  })

  it('refuses an edit with no changes', async () => {
    primeCapabilities()
    callMock.mockResolvedValueOnce(response(snapshot()))

    await expect(
      LOOP_HANDLERS['loop edit'](context([['loop-id', 'loop-1']]))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(rpcCalls().map(([method]) => method)).toEqual([LOOPS_CHANNELS.get])
  })

  it('refuses a prompt edit on a queue loop', async () => {
    primeCapabilities()
    const queued = snapshot({ preset: 'queue' })
    queued.config.promptSource = { kind: 'queue', repeatQueue: false }
    callMock.mockResolvedValueOnce(response(queued))

    await expect(
      LOOP_HANDLERS['loop edit'](
        context([
          ['loop-id', 'loop-1'],
          ['prompt', 'x']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('quirky loop registration', () => {
  it('declares a spec and a manifest key for every handler', () => {
    const specPaths = new Set(COMMAND_SPECS.map((spec) => spec.path.join(' ')))
    const manifestKeys = new Set(
      HANDLER_GROUPS.filter((group) => group.name === 'loop').flatMap((group) => group.keys)
    )
    for (const key of Object.keys(LOOP_HANDLERS)) {
      expect(specPaths.has(key)).toBe(true)
      expect(manifestKeys.has(key)).toBe(true)
    }
    expect(manifestKeys.size).toBe(Object.keys(LOOP_HANDLERS).length)
  })
})
