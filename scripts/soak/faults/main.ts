import type { PluginContext } from '@quirky/protocol'

type LeakParams = { count: number; everyMs: number; lifetimeSeconds: number }
type ZombiesParams = { holders: number; each: number; lifetimeSeconds: number }
type RefreshParams = { owner: string }
type BlockParams = { ms: number }
type FeedbackStartParams = { worktrees: [string, string] }
type FeedbackRefreshParams = { owner: string }
type FeedbackState = { worktrees: [string, string]; refreshes: number; active: boolean }
type FloodStartParams = { worktree: string; requests: number }
type FloodTickParams = { owner: string; sequence: number }
type FloodState = { worktree: string; expected: number; requests: number; active: boolean; sequences: Set<number> }

function validFloodCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10_000
}

function validFloodWorktree(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validFloodSequence(value: unknown, expected: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= expected
}
function validWorktrees(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2
    && value.every((worktree) => typeof worktree === 'string' && worktree.trim() !== '')
    && value[0] !== value[1]
}

/** Registers fault handlers for an explicitly marked soak daemon. */
export function activate(context: PluginContext): () => void {
  if (process.env.QUIRKY_SOAK_FAULTS !== '1') {
    throw new Error('soak.faults runs only inside a soak')
  }

  const leaked: number[] = []
  const holders: number[] = []
  let refreshes = 0
  let blockedMs: number | null = null
  let refreshOwner = ''
  let feedback: FeedbackState | null = null
  let flood: FloodState | null = null
  let deactivated = false
  const feedbackTimers = new Set<ReturnType<typeof setTimeout>>()

  context.provide('method:soak.faults/leak', (params: LeakParams) => {
    let started = 0
    const timer = setInterval(() => {
      const child = Bun.spawn(['sleep', String(params.lifetimeSeconds)], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore'
      })
      leaked.push(child.pid)
      started += 1
      if (started === params.count) clearInterval(timer)
    }, params.everyMs)

    return { started: true }
  })

  context.provide('method:soak.faults/zombies', (params: ZombiesParams) => {
    for (let index = 0; index < params.holders; index += 1) {
      const command = Array.from({ length: params.each }, () => 'sleep 0.3').join(' & ')
      const child = Bun.spawn(['/bin/sh', '-c', `${command} & exec sleep ${params.lifetimeSeconds}`], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore'
      })
      holders.push(child.pid)
    }

    return { holders }
  })

  context.provide('method:soak.faults/refresh', (params: RefreshParams) => {
    refreshes += 1
    refreshOwner = params.owner
    const result = { owner: refreshOwner }
    setTimeout(() => context.emit('changed', { owner: refreshOwner }), 50)
    return result
  })

  context.provide('method:soak.faults/block', (params: BlockParams) => {
    const startedAt = performance.now()
    Bun.spawnSync(['sleep', String(params.ms / 1000)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    })
    blockedMs = Math.round(performance.now() - startedAt)
    return { blockedMs }
  })

  context.provide('method:soak.faults/report', () => ({ leaked, holders, refreshes, blockedMs }))

  context.provide('method:soak.faults/floodStart', (params: FloodStartParams) => {
    if (deactivated) throw new Error('flood fixture is deactivated')
    if (flood) throw new Error('flood fixture can only be started once per activation')
    if (!validFloodWorktree(params?.worktree)) throw new Error('flood fixture needs a nonempty worktree')
    if (!validFloodCount(params?.requests)) throw new Error('flood fixture requests must be a safe integer from 1 through 10000')
    flood = {
      worktree: params.worktree,
      expected: params.requests,
      requests: 0,
      active: true,
      sequences: new Set()
    }
    context.emit('floodStarted', { worktree: flood.worktree, requests: flood.expected })
    return { started: true }
  })

  context.provide('method:soak.faults/floodTick', (params: FloodTickParams) => {
    if (deactivated) throw new Error('flood fixture is deactivated')
    if (!flood?.active) throw new Error('flood fixture is not armed or has completed')
    if (params?.owner !== flood.worktree) throw new Error(`flood owner must be ${flood.worktree}`)
    if (!validFloodSequence(params?.sequence, flood.expected)) {
      throw new Error(`flood sequence must be a unique integer from 1 through ${flood.expected}`)
    }
    if (flood.sequences.has(params.sequence)) throw new Error(`flood sequence ${params.sequence} was already accepted`)
    flood.sequences.add(params.sequence)
    flood.requests += 1
    if (flood.requests === flood.expected) flood.active = false
    return { owner: params.owner, sequence: params.sequence }
  })

  context.provide('method:soak.faults/floodReport', () => ({
    worktree: flood?.worktree ?? null,
    expected: flood?.expected ?? 0,
    requests: flood?.requests ?? 0,
    active: flood?.active ?? false
  }))

  context.provide('method:soak.faults/feedbackStart', (params: FeedbackStartParams) => {
    if (deactivated) throw new Error('feedback fixture is deactivated')
    if (feedback) throw new Error('feedback fixture can only be started once per activation')
    if (!validWorktrees(params?.worktrees)) throw new Error('feedback fixture needs two distinct nonempty worktrees')
    const worktrees: [string, string] = [...params.worktrees]
    feedback = { worktrees, refreshes: 0, active: true }
    context.emit('feedbackStarted', { worktrees: [...worktrees], first: worktrees[0] })
    return { started: true }
  })

  context.provide('method:soak.faults/feedbackRefresh', (params: FeedbackRefreshParams) => {
    if (deactivated) throw new Error('feedback fixture is deactivated')
    if (!feedback?.active) throw new Error('feedback fixture is not armed or has completed')
    const sequence = feedback.refreshes + 1
    const expectedOwner = sequence % 2 === 1 ? feedback.worktrees[0] : feedback.worktrees[1]
    if (params?.owner !== expectedOwner) throw new Error(`feedback owner must be ${expectedOwner} for sequence ${sequence}`)
    feedback.refreshes = sequence
    if (sequence === 17) feedback.active = false
    const event = { worktrees: [...feedback.worktrees] as [string, string], owner: params.owner, sequence }
    const timer = setTimeout(() => {
      feedbackTimers.delete(timer)
      if (!deactivated) context.emit('feedbackChanged', event)
    }, 50)
    feedbackTimers.add(timer)
    return { owner: params.owner, sequence }
  })

  context.provide('method:soak.faults/feedbackReport', () => ({
    worktrees: feedback ? [...feedback.worktrees] as [string, string] : null,
    refreshes: feedback?.refreshes ?? 0,
    active: feedback?.active ?? false
  }))

  return () => {
    deactivated = true
    for (const timer of feedbackTimers) clearTimeout(timer)
    feedbackTimers.clear()
  }
}
