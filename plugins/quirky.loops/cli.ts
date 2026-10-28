import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { LoopConfig, LoopConfigPatch, LoopPreset, LoopSnapshot, IterationDetail, QueueOperation } from './src/types'

type Flags = Record<string, unknown>
type EditPatch = LoopConfigPatch & { name?: string }

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function stringFlag(flags: Flags, name: string, ctx: CliContext): string | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw ctx.usage(`--${name} must be a string`)
  return value
}

function numericFlag(flags: Flags, name: string, ctx: CliContext): number | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ctx.usage(`--${name} must be a number`)
  return value
}

function positiveInteger(flags: Flags, name: string, ctx: CliContext): number | undefined {
  const value = numericFlag(flags, name, ctx)
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw ctx.usage(`--${name} must be a positive integer`)
  return value
}

function nonnegativeInteger(flags: Flags, name: string, ctx: CliContext): number | undefined {
  const value = numericFlag(flags, name, ctx)
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw ctx.usage(`--${name} must be a nonnegative integer`)
  }
  return value
}

function positionalIndex(args: CliArgs, index: number, name: string, ctx: CliContext): number {
  const raw = positional(args, index, name, ctx)
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw ctx.usage(`${name} must be a nonnegative integer`)
  return value
}

function booleanFlag(flags: Flags, name: string, ctx: CliContext): boolean | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw ctx.usage(`--${name} must be a boolean`)
  return value
}

function stringList(value: unknown, name: string, ctx: CliContext): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  throw ctx.usage(`--${name} must be a string${name === 'protected-path' || name === 'option' || name === 'queue-item' ? ' or repeated strings' : ''}`)
}

function nonEmpty(value: string | undefined, flag: string, ctx: CliContext): string | undefined {
  if (value !== undefined && value.trim() === '') throw ctx.usage(`--${flag} must be non-empty`)
  return value
}

function selectionOptions(flags: Flags, ctx: CliContext): { model?: string; options?: Record<string, string | boolean> } {
  const model = nonEmpty(stringFlag(flags, 'model', ctx), 'model', ctx)
  const effort = nonEmpty(stringFlag(flags, 'effort', ctx), 'effort', ctx)
  const entries = flags.option === undefined ? [] : stringList(flags.option, 'option', ctx)
  if (model === undefined && effort !== undefined) throw ctx.usage('--effort requires --model')
  if (model === undefined && entries.length > 0) throw ctx.usage('--option requires --model')

  const options = Object.create(null) as Record<string, string | boolean>
  if (effort !== undefined) options.effort = effort
  for (const entry of entries) {
    const split = entry.indexOf('=')
    if (split < 1) throw ctx.usage(`--option expects KEY=VALUE, got ${JSON.stringify(entry)}`)
    const key = entry.slice(0, split)
    const raw = entry.slice(split + 1)
    if (Object.hasOwn(options, key)) throw ctx.usage(`--option ${key} is supplied more than once`)
    if (key === 'effort' && effort !== undefined) throw ctx.usage('--effort cannot be combined with --option effort=…')
    options[key] = raw === 'true' ? true : raw === 'false' ? false : raw
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(Object.keys(options).length === 0 ? {} : { options })
  }
}

function capsFrom(flags: Flags, ctx: CliContext): LoopConfig['caps'] {
  const maxIterations = positiveInteger(flags, 'max-iterations', ctx)
  const maxActiveMinutes = positiveInteger(flags, 'max-minutes', ctx)
  const maxCostUsd = numericFlag(flags, 'max-cost', ctx)
  if (maxCostUsd !== undefined && maxCostUsd <= 0) throw ctx.usage('--max-cost must be above 0')
  return {
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxActiveMinutes === undefined ? {} : { maxActiveMinutes }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd })
  }
}

function createConfig(
  flags: Flags,
  ctx: CliContext
): { preset: LoopPreset; config: LoopConfig; queueItems?: { body: string }[] } {
  const presetFlag = stringFlag(flags, 'preset', ctx)
  const preset = presetFlag ?? 'until-done'
  if (preset !== 'until-done' && preset !== 'queue' && preset !== 'interval') {
    throw ctx.usage('--preset must be until-done, queue, or interval')
  }
  const prompt = nonEmpty(stringFlag(flags, 'prompt', ctx), 'prompt', ctx)
  const queueItemsFlag = flags['queue-item']
  let repeatQueue = booleanFlag(flags, 'repeat-queue', ctx)
  const every = positiveInteger(flags, 'every', ctx)
  const anchor = stringFlag(flags, 'anchor', ctx)
  if (anchor !== undefined && anchor !== 'from-end' && anchor !== 'wall-clock') {
    throw ctx.usage('--anchor must be from-end or wall-clock')
  }

  let promptSource: LoopConfig['promptSource']
  let pacing: LoopConfig['pacing']
  let queueItems: { body: string }[] | undefined
  if (preset === 'queue') {
    if (prompt !== undefined) throw ctx.usage('--preset queue cannot be combined with --prompt')
    if (every !== undefined || anchor !== undefined) throw ctx.usage('--every and --anchor require --preset interval')
    if (queueItemsFlag === undefined) throw ctx.usage('--preset queue requires at least one --queue-item')
    const bodies = stringList(queueItemsFlag, 'queue-item', ctx)
    if (bodies.length === 0 || bodies.some((body) => body.trim() === '')) {
      throw ctx.usage('--queue-item must be non-empty')
    }
    if (repeatQueue === undefined) repeatQueue = false
    promptSource = { kind: 'queue', repeatQueue }
    pacing = { kind: 'on-idle' }
    queueItems = bodies.map((body) => ({ body }))
  } else {
    if (queueItemsFlag !== undefined || repeatQueue !== undefined) {
      throw ctx.usage('--queue-item and --repeat-queue require --preset queue')
    }
    if (prompt === undefined) {
      throw ctx.usage(preset === 'interval' ? '--preset interval requires --prompt' : 'create requires --prompt')
    }
    promptSource = { kind: 'repeat', body: prompt }
    if (preset === 'interval') {
      if (every === undefined) throw ctx.usage('--preset interval requires --every')
      pacing = { kind: 'interval', minutes: every, anchor: anchor ?? 'from-end' }
    } else {
      if (every !== undefined || anchor !== undefined) throw ctx.usage('--every and --anchor require --preset interval')
      pacing = { kind: 'on-idle' }
    }
  }

  const checkCommand = nonEmpty(stringFlag(flags, 'check', ctx), 'check', ctx)
  const timeout = positiveInteger(flags, 'check-timeout', ctx)
  if (timeout !== undefined && timeout > 600) throw ctx.usage('--check-timeout must be between 1 and 600')
  const runWhen = stringFlag(flags, 'check-when', ctx)
  if (checkCommand === undefined && timeout !== undefined) throw ctx.usage('--check-timeout requires --check')
  if (checkCommand === undefined && runWhen !== undefined) throw ctx.usage('--check-when requires --check')
  if (runWhen !== undefined && runWhen !== 'every-iteration' && runWhen !== 'on-claim') {
    throw ctx.usage('--check-when must be every-iteration or on-claim')
  }
  const evaluator = nonEmpty(stringFlag(flags, 'evaluator', ctx), 'evaluator', ctx)
  const protectedPaths = flags['protected-path'] === undefined ? undefined : stringList(flags['protected-path'], 'protected-path', ctx)
  if (protectedPaths?.some((path) => path.trim() === '')) throw ctx.usage('--protected-path must be non-empty')
  const sessionPolicy = stringFlag(flags, 'session', ctx) ?? (preset === 'until-done' ? 'fresh' : 'continue')
  if (sessionPolicy !== 'fresh' && sessionPolicy !== 'continue') throw ctx.usage('--session must be fresh or continue')

  const done: LoopConfig['done'] = {
    ...(checkCommand === undefined ? {} : {
      check: { command: checkCommand, timeoutSeconds: timeout ?? 300, runWhen: runWhen ?? 'every-iteration' }
    }),
    ...(evaluator === undefined ? {} : { evaluator: { condition: evaluator } })
  }
  const noProgress = booleanFlag(flags, 'no-progress', ctx) ?? false
  const checkpointCommits = booleanFlag(flags, 'checkpoint-commits', ctx) ?? false
  const askBeforeNext = booleanFlag(flags, 'ask-before-next', ctx) ?? false
  const resumeAtLimitReset = booleanFlag(flags, 'resume-at-reset', ctx) ?? false
  const config: LoopConfig = {
    promptSource,
    pacing,
    sessionPolicy,
    done,
    caps: capsFrom(flags, ctx),
    noProgress,
    ...(protectedPaths === undefined ? {} : { protectedPaths }),
    checkpointCommits,
    askBeforeNext,
    resumeAtLimitReset
  }
  return { preset, config, ...(queueItems === undefined ? {} : { queueItems }) }
}

function positional(args: CliArgs, index: number, name: string, ctx: CliContext): string {
  const value = args.positionals[index]
  if (value === undefined || value.trim() === '') throw ctx.usage(`${name} is required`)
  return value
}

function assertNoExtraPositionals(args: CliArgs, count: number, ctx: CliContext): void {
  if (args.positionals.length > count) throw ctx.usage('too many positional arguments')
}

function jsonObjectFlag(flags: Flags, name: string, ctx: CliContext): Record<string, unknown> | undefined {
  const raw = stringFlag(flags, name, ctx)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw ctx.usage(`--${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!object(parsed)) throw ctx.usage(`--${name} must be a JSON object`)
  return parsed
}

async function invokeUiCommand(name: string, args: Record<string, unknown>, ctx: CliContext): Promise<void> {
  const result = await ctx.call('ui.command.run', { id: `command:quirky.loops/${name}`, args })
  ctx.out.result(result, () => JSON.stringify(result, null, 2) ?? 'null')
}

function statusText(loop: LoopSnapshot): string {
  return `${loop.state}${loop.pauseReason ? `: ${loop.pauseReason}` : ''}${loop.pauseDetail ? ` — ${loop.pauseDetail}` : ''}`
}

function capText(loop: LoopSnapshot): string {
  const max = loop.config.caps.maxIterations
  return `${loop.iterationsCompleted}${max === undefined ? '' : `/${max}`}`
}

function queueSummary(loop: LoopSnapshot): string | undefined {
  if (loop.preset !== 'queue') return undefined
  const pending = loop.queueItems.filter((item) => item.state === 'pending').length
  const inFlight = loop.queueItems.filter((item) => item.state === 'in-flight').length
  const done = loop.queueItems.filter((item) => item.state === 'done').length
  return `queue ${done} done, ${pending} pending, ${inFlight} in flight`
}

function scheduleSummary(loop: LoopSnapshot): string[] {
  return [
    ...(loop.nextIterationAt === null ? [] : [`next ${new Date(loop.nextIterationAt).toISOString()}`]),
    ...(loop.skippedTicks === 0 ? [] : [`skipped ticks ${loop.skippedTicks}`])
  ]
}

function loopLine(loop: LoopSnapshot): string {
  return [
    loop.id,
    loop.name,
    loop.preset,
    loop.agent,
    statusText(loop),
    `iterations ${capText(loop)}`,
    queueSummary(loop),
    ...scheduleSummary(loop)
  ].filter((part): part is string => part !== undefined).join('  ')
}

function showText(loop: LoopSnapshot, ctx: CliContext): string {
  const rows: [string, string][] = [
    ['id', loop.id],
    ['name', loop.name],
    ['status', statusText(loop)],
    ['preset', loop.preset],
    ['agent', loop.agent],
    ['session policy', loop.config.sessionPolicy],
    ['worktree', loop.worktreeId],
    ['workspace', loop.cwd],
    ['iterations', capText(loop)],
    ...(loop.nextIterationAt === null ? [] : [['next iteration', new Date(loop.nextIterationAt).toISOString()] as [string, string]]),
    ...(loop.skippedTicks === 0 ? [] : [['skipped ticks', String(loop.skippedTicks)] as [string, string]]),
    ...loop.queueItems.map((item): [string, string] => [
      `queue item ${item.position}`,
      `${item.id} [${item.state}] ${item.body}`
    ]),
    ['active time', `${Math.floor(loop.activeMs / 60_000)}m ${Math.floor(loop.activeMs / 1000) % 60}s`],
    ['cost', loop.costUsd === null ? 'n/a' : `$${loop.costUsd.toFixed(4)}`],
    ...(loop.phase === null ? [] : [['phase', loop.phase] as [string, string]]),
    ...(loop.pauseDetail === null ? [] : [['pause detail', loop.pauseDetail] as [string, string]]),
    ...(loop.sessionId === null ? [] : [['session', loop.sessionId] as [string, string]]),
    ...loop.warnings.map((warning): [string, string] => ['warning', warning])
  ]
  const recent = loop.recentIterations.slice(-5).map((iteration) => `#${iteration.n}.${iteration.attempt} ${iteration.endReason ?? 'in progress'}`)
  return [ctx.format.record(rows), ...(recent.length ? ['recent iterations:', ...recent] : [])].join('\n')
}

function checkLabel(iteration: IterationDetail): string {
  if (!iteration.check) return 'no check'
  if (!iteration.check.ran) return `check not run${iteration.check.error ? ` (${iteration.check.error})` : ''}`
  return iteration.check.pass ? 'check passed' : 'check failed'
}

function iterationText(iteration: IterationDetail): string {
  const lines = [`Iteration ${iteration.n} attempt ${iteration.attempt}: ${iteration.endReason ?? 'in progress'} · ${checkLabel(iteration)}`]
  if (iteration.check?.stdoutTail) lines.push(`check stdout: ${iteration.check.stdoutTail}`)
  if (iteration.check?.stderrTail) lines.push(`check stderr: ${iteration.check.stderrTail}`)
  if (iteration.evaluator) lines.push(`evaluator: ${iteration.evaluator.verdict} — ${iteration.evaluator.reason}`)
  if (iteration.protectedPathHits.length) lines.push(`protected paths: ${iteration.protectedPathHits.join(', ')}`)
  if (iteration.error) lines.push(`error: ${iteration.error}`)
  if (iteration.outputTail) lines.push(iteration.outputTail)
  return lines.join('\n')
}

function actionText(action: string, loop: LoopSnapshot): string {
  return `${action} loop ${loop.id} (${loop.name}): ${statusText(loop)}.`
}

const named: CliModule['commands'] = {
  async create(args, ctx) {
    assertNoExtraPositionals(args, 0, ctx)
    const agent = stringFlag(args.flags, 'agent', ctx)
    if (agent !== 'claude' && agent !== 'codex') throw ctx.usage('create requires --agent claude|codex')
    const name = nonEmpty(stringFlag(args.flags, 'name', ctx), 'name', ctx)
    const { model, options } = selectionOptions(args.flags, ctx)
    const created = createConfig(args.flags, ctx)
    const snapshot = await ctx.call('quirky.loops/create', {
      worktree: stringFlag(args.flags, 'worktree', ctx) ?? 'current',
      agent,
      preset: created.preset,
      config: created.config,
      ...(created.queueItems === undefined ? {} : { queueItems: created.queueItems }),
      name: name ?? `${agent} ${created.preset}`,
      ...(model === undefined ? {} : { model }),
      ...(options === undefined ? {} : { options })
    }) as LoopSnapshot
    const warning = snapshot.warnings.includes('worktree-has-running-loop') ? '\nWarning: another loop is already running in this worktree.' : ''
    ctx.out.result(snapshot, () => `Started loop ${snapshot.id} (${snapshot.name}): ${snapshot.state}.${warning}`)
  },
  async list(args, ctx) {
    assertNoExtraPositionals(args, 0, ctx)
    const worktree = stringFlag(args.flags, 'worktree', ctx)
    const loops = await ctx.call('quirky.loops/list', worktree === undefined ? {} : { worktree }) as LoopSnapshot[]
    ctx.out.result(loops, () => loops.length === 0 ? 'No loops.' : loops.map(loopLine).join('\n'))
  },
  async show(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'show requires a loop ID', ctx)
    const loop = await ctx.call('quirky.loops/get', { loopId }) as LoopSnapshot
    ctx.out.result(loop, () => showText(loop, ctx))
  },
  async get(args, ctx) {
    await named.show!(args, ctx)
  },
  async iterations(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'iterations requires a loop ID', ctx)
    const limit = positiveInteger(args.flags, 'limit', ctx)
    const iterations = await ctx.call('quirky.loops/iterations', { loopId, ...(limit === undefined ? {} : { limit }) }) as IterationDetail[]
    ctx.out.result(iterations, () => iterations.length === 0 ? 'No iterations.' : iterations.map(iterationText).join('\n\n'))
  },
  async pause(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'pause requires a loop ID', ctx)
    const loop = await ctx.call('quirky.loops/pause', { loopId, mode: 'after-iteration' }) as LoopSnapshot
    ctx.out.result(loop, () => `Pausing loop ${loop.id} after this iteration.`)
  },
  async resume(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'resume requires a loop ID', ctx)
    const addIterations = positiveInteger(args.flags, 'add-iterations', ctx)
    const loop = await ctx.call('quirky.loops/resume', { loopId, ...(addIterations === undefined ? {} : { addIterations }) }) as LoopSnapshot
    ctx.out.result(loop, () => actionText('Resumed', loop))
  },
  async stop(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'stop requires a loop ID', ctx)
    const now = booleanFlag(args.flags, 'now', ctx) ?? false
    const loop = await ctx.call('quirky.loops/stop', { loopId, mode: now ? 'now' : 'after-iteration' }) as LoopSnapshot
    ctx.out.result(loop, () => `${now ? 'Stopping' : 'Stopping after this iteration'} loop ${loop.id} (${loop.name}): ${loop.state}.`)
  },
  async steer(args, ctx) {
    if (args.positionals.length < 2) throw ctx.usage('steer requires a loop ID and guidance text')
    const loopId = positional(args, 0, 'steer requires a loop ID', ctx)
    const text = args.positionals.slice(1).join(' ').trim()
    if (text === '') throw ctx.usage('steer requires non-empty guidance text')
    const loop = await ctx.call('quirky.loops/steer', { loopId, text }) as LoopSnapshot
    ctx.out.result(loop, () => `Steered loop ${loop.id} (${loop.name}); the note will be used on its next iteration.`)
  },
  async edit(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'edit requires a loop ID', ctx)
    const flags = args.flags
    const allowed = [
      'name', 'prompt', 'session', 'check', 'check-timeout', 'check-when', 'evaluator',
      'max-iterations', 'max-minutes', 'max-cost', 'no-progress', 'checkpoint-commits',
      'ask-before-next', 'resume-at-reset', 'protected-path', 'no-check', 'no-evaluator',
      'no-max-iterations', 'no-max-minutes', 'no-max-cost', 'no-protected-paths',
      'repeat-queue', 'every', 'anchor'
    ]
    const extra = Object.keys(flags).find((key) => !allowed.includes(key))
    if (extra !== undefined) throw ctx.usage(`edit does not support --${extra}`)
    const removals: [string, string][] = [
      ['check', 'no-check'], ['evaluator', 'no-evaluator'], ['max-iterations', 'no-max-iterations'],
      ['max-minutes', 'no-max-minutes'], ['max-cost', 'no-max-cost'], ['protected-path', 'no-protected-paths']
    ]
    for (const [set, remove] of removals) {
      if (flags[set] !== undefined && flags[remove] === true) throw ctx.usage(`--${set} cannot be combined with --${remove}`)
    }
    if (flags['no-check'] === true && (flags['check-timeout'] !== undefined || flags['check-when'] !== undefined)) {
      throw ctx.usage('--no-check cannot be combined with --check-timeout or --check-when')
    }
    const supplied = Object.keys(flags).filter((name) => name !== 'json' && (flags[name] !== undefined))
    if (supplied.length === 0) throw ctx.usage('Nothing to edit; pass at least one setting flag')

    const current = await ctx.call('quirky.loops/get', { loopId }) as LoopSnapshot
    const repeatQueue = booleanFlag(flags, 'repeat-queue', ctx)
    const every = positiveInteger(flags, 'every', ctx)
    const anchor = stringFlag(flags, 'anchor', ctx)
    if (anchor !== undefined && anchor !== 'from-end' && anchor !== 'wall-clock') {
      throw ctx.usage('--anchor must be from-end or wall-clock')
    }
    if (current.preset === 'queue' && flags.prompt !== undefined) {
      throw ctx.usage('--prompt cannot be used with the queue preset')
    }
    if (repeatQueue !== undefined && current.preset !== 'queue') {
      throw ctx.usage('--repeat-queue requires the queue preset')
    }
    if ((every !== undefined || anchor !== undefined) && current.preset !== 'interval') {
      throw ctx.usage('--every and --anchor require the interval preset')
    }
    const patch: EditPatch = {}
    const name = nonEmpty(stringFlag(flags, 'name', ctx), 'name', ctx)
    if (name !== undefined) patch.name = name
    const prompt = nonEmpty(stringFlag(flags, 'prompt', ctx), 'prompt', ctx)
    if (prompt !== undefined) patch.promptSource = { kind: 'repeat', body: prompt }
    if (repeatQueue !== undefined) patch.promptSource = { kind: 'queue', repeatQueue }
    if (every !== undefined || anchor !== undefined) {
      if (current.config.pacing.kind !== 'interval') throw ctx.usage('interval pacing is required to edit --every or --anchor')
      patch.pacing = {
        kind: 'interval',
        minutes: every ?? current.config.pacing.minutes,
        anchor: anchor ?? current.config.pacing.anchor
      }
    }
    const session = stringFlag(flags, 'session', ctx)
    if (session !== undefined) {
      if (session !== 'fresh' && session !== 'continue') throw ctx.usage('--session must be fresh or continue')
      patch.sessionPolicy = session
    }

    const checkCommand = nonEmpty(stringFlag(flags, 'check', ctx), 'check', ctx)
    const timeout = positiveInteger(flags, 'check-timeout', ctx)
    if (timeout !== undefined && timeout > 600) throw ctx.usage('--check-timeout must be between 1 and 600')
    const runWhen = stringFlag(flags, 'check-when', ctx)
    if (runWhen !== undefined && runWhen !== 'every-iteration' && runWhen !== 'on-claim') {
      throw ctx.usage('--check-when must be every-iteration or on-claim')
    }
    let done: LoopConfig['done'] | undefined
    const checkWasSupplied = checkCommand !== undefined || timeout !== undefined || runWhen !== undefined || flags['no-check'] === true
    if (checkWasSupplied || flags.evaluator !== undefined || flags['no-evaluator'] === true) done = { ...current.config.done }
    if (checkWasSupplied) {
      if (flags['no-check'] === true) delete done!.check
      else {
        const existing = current.config.done.check
        const command = checkCommand ?? existing?.command
        if (command === undefined) throw ctx.usage('--check-timeout and --check-when require --check or an existing check')
        done!.check = {
          command,
          timeoutSeconds: timeout ?? existing?.timeoutSeconds ?? 300,
          runWhen: runWhen ?? existing?.runWhen ?? 'every-iteration'
        }
      }
    }
    const evaluator = nonEmpty(stringFlag(flags, 'evaluator', ctx), 'evaluator', ctx)
    if (evaluator !== undefined) done!.evaluator = { condition: evaluator }
    if (flags['no-evaluator'] === true) delete done!.evaluator
    if (done !== undefined) patch.done = done

    const caps = { ...current.config.caps }
    let capsChanged = false
    const maxIterations = positiveInteger(flags, 'max-iterations', ctx)
    const maxMinutes = positiveInteger(flags, 'max-minutes', ctx)
    const maxCost = numericFlag(flags, 'max-cost', ctx)
    if (maxCost !== undefined && maxCost <= 0) throw ctx.usage('--max-cost must be above 0')
    if (maxIterations !== undefined) { caps.maxIterations = maxIterations; capsChanged = true }
    if (maxMinutes !== undefined) { caps.maxActiveMinutes = maxMinutes; capsChanged = true }
    if (maxCost !== undefined) { caps.maxCostUsd = maxCost; capsChanged = true }
    if (flags['no-max-iterations'] === true) { delete caps.maxIterations; capsChanged = true }
    if (flags['no-max-minutes'] === true) { delete caps.maxActiveMinutes; capsChanged = true }
    if (flags['no-max-cost'] === true) { delete caps.maxCostUsd; capsChanged = true }
    if (capsChanged) patch.caps = caps

    if (flags['protected-path'] !== undefined) {
      const paths = stringList(flags['protected-path'], 'protected-path', ctx)
      if (paths.length === 0 || paths.some((path) => path.trim() === '')) throw ctx.usage('--protected-path must be non-empty')
      patch.protectedPaths = paths
    }
    if (flags['no-protected-paths'] === true) patch.protectedPaths = []
    for (const [flag, key] of [
      ['no-progress', 'noProgress'], ['checkpoint-commits', 'checkpointCommits'],
      ['ask-before-next', 'askBeforeNext'], ['resume-at-reset', 'resumeAtLimitReset']
    ] as const) {
      const value = booleanFlag(flags, flag, ctx)
      if (value !== undefined) patch[key] = value
    }

    if (Object.keys(patch).length === 0) throw ctx.usage('Nothing to edit; pass at least one setting flag')
    const loop = await ctx.call('quirky.loops/edit', { loopId, patch }) as LoopSnapshot
    ctx.out.result(loop, () => `Updated loop ${loop.id} (${loop.name}); changes apply to the next iteration.`)
  },
  async queue(args, ctx) {
    const loopId = positional(args, 0, 'queue requires a loop ID', ctx)
    const kind = positional(args, 1, 'queue requires an operation', ctx)
    if (kind !== 'add' && kind !== 'edit' && kind !== 'move' && kind !== 'remove') {
      throw ctx.usage('queue operation must be add, edit, move, or remove')
    }
    const allowedFlags = kind === 'add' ? ['position', 'json'] : ['json']
    const extra = Object.keys(args.flags).find((key) => !allowedFlags.includes(key))
    if (extra !== undefined) throw ctx.usage(`queue ${kind} does not support --${extra}`)

    let operation: QueueOperation
    if (kind === 'add') {
      assertNoExtraPositionals(args, 3, ctx)
      if (args.positionals.length < 3) throw ctx.usage('queue add requires a body')
      const body = args.positionals.slice(2).join(' ').trim()
      if (body === '') throw ctx.usage('queue add requires a non-empty body')
      const position = nonnegativeInteger(args.flags, 'position', ctx)
      const current = await ctx.call('quirky.loops/get', { loopId }) as LoopSnapshot
      if (current.preset !== 'queue') throw ctx.usage('queue operations require a queue preset')
      if (position !== undefined && position > current.queueItems.length) {
        throw ctx.usage(`--position must be between 0 and ${current.queueItems.length}`)
      }
      operation = { kind: 'add', body, ...(position === undefined ? {} : { position }) }
    } else if (kind === 'edit') {
      assertNoExtraPositionals(args, 4, ctx)
      if (args.positionals.length < 4) throw ctx.usage('queue edit requires an item ID and body')
      const id = positional(args, 2, 'queue edit requires an item ID', ctx)
      const body = args.positionals.slice(3).join(' ').trim()
      if (body === '') throw ctx.usage('queue edit requires a non-empty body')
      const current = await ctx.call('quirky.loops/get', { loopId }) as LoopSnapshot
      if (current.preset !== 'queue') throw ctx.usage('queue operations require a queue preset')
      operation = { kind: 'edit', id, body }
    } else if (kind === 'move') {
      assertNoExtraPositionals(args, 4, ctx)
      if (args.positionals.length < 4) throw ctx.usage('queue move requires an item ID and position')
      const id = positional(args, 2, 'queue move requires an item ID', ctx)
      const position = positionalIndex(args, 3, 'queue move position', ctx)
      const current = await ctx.call('quirky.loops/get', { loopId }) as LoopSnapshot
      if (current.preset !== 'queue') throw ctx.usage('queue operations require a queue preset')
      if (position >= current.queueItems.length) {
        throw ctx.usage(`queue move position must be between 0 and ${current.queueItems.length - 1}`)
      }
      operation = { kind: 'move', id, position }
    } else {
      assertNoExtraPositionals(args, 3, ctx)
      if (args.positionals.length < 3) throw ctx.usage('queue remove requires an item ID')
      const id = positional(args, 2, 'queue remove requires an item ID', ctx)
      const current = await ctx.call('quirky.loops/get', { loopId }) as LoopSnapshot
      if (current.preset !== 'queue') throw ctx.usage('queue operations require a queue preset')
      operation = { kind: 'remove', id }
    }

    const loop = await ctx.call('quirky.loops/queue', { loopId, op: operation }) as LoopSnapshot
    ctx.out.result(loop, () => `Updated queue for loop ${loop.id} (${loop.name}).`)
  },
  async 'ui-new'(args, ctx) {
    assertNoExtraPositionals(args, 0, ctx)
    const workspace = stringFlag(args.flags, 'workspace', ctx)
    const group = stringFlag(args.flags, 'group', ctx)
    await invokeUiCommand('new', {
      ...(workspace === undefined ? {} : { workspace }),
      ...(group === undefined ? {} : { group })
    }, ctx)
  },
  async 'ui-setup-action'(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const action = positional(args, 0, 'setup-action requires an action', ctx)
    const params = jsonObjectFlag(args.flags, 'payload', ctx)
    await invokeUiCommand('setup-action', { action, ...(params === undefined ? {} : { params }) }, ctx)
  },
  async 'ui-open'(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'open requires a loop ID', ctx)
    await invokeUiCommand('open', { loopId }, ctx)
  },
  async 'ui-action'(args, ctx) {
    assertNoExtraPositionals(args, 2, ctx)
    const loopId = positional(args, 0, 'action requires a loop ID', ctx)
    const action = positional(args, 1, 'action requires an action name', ctx)
    const params = jsonObjectFlag(args.flags, 'payload', ctx)
    await invokeUiCommand('action', { loopId, action, ...(params === undefined ? {} : { params }) }, ctx)
  },
  async 'ui-close-tab'(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const loopId = positional(args, 0, 'close-tab requires a loop ID', ctx)
    const tabId = nonEmpty(stringFlag(args.flags, 'tab', ctx), 'tab', ctx)
    if (tabId === undefined) throw ctx.usage('close-tab requires --tab')
    await invokeUiCommand('close-tab', { loopId, tabId }, ctx)
  },
  async 'ui-close-choice'(args, ctx) {
    assertNoExtraPositionals(args, 1, ctx)
    const choice = positional(args, 0, 'close-choice requires a choice', ctx)
    await invokeUiCommand('close-choice', { choice }, ctx)
  }
}

export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, handler]) => [`cli-command:quirky.loops/${name}`, handler]))
}
