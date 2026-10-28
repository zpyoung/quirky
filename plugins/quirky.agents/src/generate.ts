import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { PluginCaller, PluginContext, PluginErrorKind } from '@quirky/protocol'
import { decodeOutput, failureMessage, sanitizeFailureDetail, stripAnsi } from './core/one-shot-output'
import { buildOneShotCommand, extractEnvAssignments, OneShotError, planCustomCommand, shouldRetryWithoutStrictMcp, type OneShotCommand } from './core/one-shot'
import { findOptionOccurrence, hasOption, terminatorIndex } from './core/arg-occurrence'
import { buildLaunchPlan, PlanError } from './core/plan'
import { resolveLaunch } from './core/resolve'
import { SelectionError, validateSelection } from './core/selection'
import { joinCommand, tokenize } from './core/shell'
import type { AgentConfig, AgentEntry, ExtraArgKind, OneShotArg, ParsedExtras, Resolution, ValidSelection } from './core/types'
import { startOneShot, type OneShotOutcome, type OneShotRun } from './one-shot-run'

type Params = Record<string, unknown>

/** The most a run may take; also the default. */
export const MAX_GENERATE_TIMEOUT_MS = 60_000

const CUSTOM_AGENT = 'custom'
/** Variables that tie a process to a Quirky session; a one-shot run is not one, so the agent's own hooks must not report as one. */
const SESSION_ENV = ['QUIRKY_SESSION_ID', 'QUIRKY_HOOK_URL', 'QUIRKY_HOOK_TOKEN']

/** What the generator needs from the agents service. */
export type GenerateDeps = {
  context: PluginContext
  entryOf(id: string): AgentEntry | undefined
  configOf(id: string): AgentConfig
  installed(id: string): boolean
  resolveExecutable(name: string): string | null
}

/** One agent or custom command, planned: what to start and how to read what it says. */
type Target = {
  agent: string
  label: string
  /** The command words, ahead of the generated arguments. */
  command: string[]
  env: Record<string, string | null>
  build(strictMcp: boolean): OneShotCommand
  spec: AgentEntry['oneShot']
}

type Job = { cancelled: boolean; run: OneShotRun | null }
function keepFirstPrefixedConflict(tokens: string[], conflict: { flags: string[]; valuePrefix?: string }, valueFlags: string[]): string[] {
  if (conflict.valuePrefix === undefined) return tokens
  let rest = tokens
  let output: string[] = []
  let kept = false
  for (let found = findOptionOccurrence(rest, conflict.flags, true, valueFlags); found; found = findOptionOccurrence(rest, conflict.flags, true, valueFlags)) {
    const end = found.index + found.consumed
    output = [...output, ...rest.slice(0, found.index)]
    const matching = found.value?.startsWith(conflict.valuePrefix) ?? false
    if (!matching || !kept) output = [...output, ...rest.slice(found.index, end)]
    if (matching) kept = true
    rest = rest.slice(end)
  }
  return [...output, ...rest]
}
function keepFirstOption(tokens: string[], aliases: string[], valueFlags: string[]): string[] {
  const first = findOptionOccurrence(tokens, aliases, true, valueFlags)
  if (!first) return tokens
  const end = first.index + first.consumed
  const output = tokens.slice(0, end)
  let rest = tokens.slice(end)
  for (let found = findOptionOccurrence(rest, aliases, true, valueFlags); found; found = findOptionOccurrence(rest, aliases, true, valueFlags)) {
    output.push(...rest.slice(0, found.index))
    rest = rest.slice(found.index + found.consumed)
  }
  return [...output, ...rest]
}

function oneShotSingletons(entry: AgentEntry): string[][] {
  const groups = entry.oneShot!.singletonOptions.map((group) => [...group])
  const conflicts = [
    ...(entry.launchOptions?.model.conflicts ?? []),
    ...(entry.launchOptions?.options.flatMap((option) => option.conflicts) ?? [])
  ]
  for (const conflict of conflicts) {
    if (conflict.valuePrefix !== undefined || groups.some((group) => group.length === conflict.flags.length && group.every((flag) => conflict.flags.includes(flag)))) continue
    groups.push([...conflict.flags])
  }
  return groups
}
function hasOneShotPlaceholder(args: OneShotArg[], placeholder: string): boolean {
  return args.some((item) =>
    typeof item === 'string' ? item.includes(placeholder) : item.args.some((part) => part.includes(placeholder))
  )
}

function withoutModelTemplate(args: OneShotArg[], flags: string[]): OneShotArg[] {
  const strip = (words: string[]): string[] => {
    const result: string[] = []
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!
      if (flags.includes(word) && words[index + 1]?.includes('{model}')) {
        index += 1
        continue
      }
      if (flags.some((flag) => word.startsWith(`${flag}=`) && word.includes('{model}'))) continue
      result.push(word)
    }
    return result
  }
  const result: OneShotArg[] = []
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!
    if (typeof item === 'string') {
      const next = args[index + 1]
      if (flags.includes(item) && typeof next === 'string' && next.includes('{model}')) {
        index += 1
        continue
      }
      if (flags.some((flag) => item.startsWith(`${flag}=`) && item.includes('{model}'))) continue
      result.push(item)
      continue
    }
    const nested = strip(item.args)
    if (nested.length > 0) result.push({ ...item, args: nested })
  }
  return result
}

function picksNotHandledByOneShot(entry: AgentEntry, selection: ValidSelection | null, resolution: Resolution): string[] {
  const catalog = entry.launchOptions
  if (!catalog || !selection) return resolution.added
  const handlesModel = catalog.composeModel === null && hasOneShotPlaceholder(entry.oneShot!.args, '{model}')
  const handlesEffort = hasOneShotPlaceholder(entry.oneShot!.args, '{thinking}')
  let position = 0
  const passed: string[] = []
  if (selection.model !== null && !resolution.shadowed.includes('model')) {
    const count = catalog.model.flag.length
    if (!handlesModel) passed.push(...resolution.added.slice(position, position + count))
    position += count
  }
  for (const option of catalog.options) {
    if (!Object.hasOwn(selection.values, option.id) || resolution.shadowed.includes(option.id)) continue
    const count = option.flag?.length ?? 0
    if (!(option.id === 'effort' && handlesEffort)) passed.push(...resolution.added.slice(position, position + count))
    position += count
  }
  return [...passed, ...resolution.added.slice(position)]
}

/** `quirky.agents/generate` and `cancelGenerate`: runs one agent once and returns what it printed. */
export class Generator {
  private readonly jobs = new Map<string, Job>()
  private readonly running = new Set<Job>()

  constructor(private readonly deps: GenerateDeps) {}

  generate = async (params: Params, caller: PluginCaller): Promise<{ text: string; agent: string; command: string; args: string[] }> => {
    const requestId = params.requestId as string | undefined
    if (requestId !== undefined && this.jobs.has(requestId)) throw this.deps.context.error('invalid-params', `requestId ${requestId} is already running`)
    const job: Job = { cancelled: false, run: null }
    if (requestId !== undefined) this.jobs.set(requestId, job)
    this.running.add(job)
    try {
      return await this.run(params, caller, job)
    } finally {
      if (requestId !== undefined) this.jobs.delete(requestId)
      this.running.delete(job)
    }
  }

  cancelGenerate = (params: Params): { cancelled: boolean } => {
    const job = this.jobs.get(params.requestId as string)
    if (!job) return { cancelled: false }
    job.cancelled = true
    job.run?.stop('cancelled')
    return { cancelled: true }
  }

  /** Stops every run, for the daemon shutting the plugin down. */
  stopAll(): void {
    for (const job of this.running) {
      job.cancelled = true
      job.run?.stop('cancelled')
    }
  }

  private async run(params: Params, caller: PluginCaller, job: Job) {
    const prompt = params.prompt as string
    const target = this.plan(params.agent as string, params.args as string | undefined, prompt, params.model, params.optionValues)
    target.build(true)
    const { cwd, worktreeId } = await this.workingDirectory(params, caller)
    const timeoutMs = this.timeoutOf(params)
    const env = this.environment(target, worktreeId)

    const attempt = async (strictMcp: boolean) => {
      if (job.cancelled) throw this.refuse('conflict', 'cancelled', 'Generation was stopped.')
      const { argv, stdin } = target.build(strictMcp)
      const words = [...target.command, ...argv]
      const run = startOneShot({ argv: this.deps.context.launch.commandArgv(joinCommand(words)), cwd, env, stdin, timeoutMs })
      job.run = run
      const outcome = await run.done
      job.run = null
      return { outcome, words }
    }

    let result = await attempt(true)
    if (target.spec && result.outcome.kind === 'exited' && shouldRetryWithoutStrictMcp(target.spec, result.outcome) && !job.cancelled) {
      result = await attempt(false)
    }
    if (job.cancelled) throw this.refuse('conflict', 'cancelled', 'Generation was stopped.')

    const text = this.textOf(target, result.outcome, timeoutMs)
    return { text, agent: target.agent, command: result.words[0]!, args: result.words.slice(1) }
  }

  private refuse(kind: PluginErrorKind, reason: string, message: string): Error {
    return Object.assign(this.deps.context.error(kind, message), { data: { reason } })
  }

  private guard<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      if (error instanceof PlanError || error instanceof OneShotError || error instanceof SelectionError) throw this.deps.context.error('invalid-params', error.message)
      throw error
    }
  }

  private plan(agent: string, userArgs: string | undefined, prompt: string, model: unknown, optionValues: unknown): Target {
    if (agent !== CUSTOM_AGENT) return this.planAgent(agent, userArgs, prompt, model, optionValues)
    if (model !== undefined && model !== null) throw this.deps.context.error('invalid-params', 'Custom commands do not support model or option picks.')
    if (optionValues !== undefined) {
      if (typeof optionValues !== 'object' || optionValues === null || Array.isArray(optionValues)) {
        throw this.deps.context.error('invalid-params', 'Custom commands do not support model or option picks.')
      }
      if (Object.keys(optionValues).length > 0) throw this.deps.context.error('invalid-params', 'Custom commands do not support model or option picks.')
    }
    return this.planCustom(userArgs ?? '', prompt)
  }

  private planCustom(commandLine: string, prompt: string): Target {
    const planned = this.guard(() => planCustomCommand(commandLine, prompt))
    const binary = planned.binary
    const resolved = binary.includes('/') ? null : this.deps.resolveExecutable(binary)
    return {
      agent: CUSTOM_AGENT,
      label: binary,
      command: [resolved ?? binary],
      env: planned.env,
      build: () => ({ argv: planned.args, stdin: planned.stdin }),
      spec: null
    }
  }

  private planAgent(id: string, userArgs: string | undefined, prompt: string, requestedModel: unknown, optionValues: unknown): Target {
    const entry = this.deps.entryOf(id)
    if (!entry) throw this.deps.context.error('invalid-params', `unknown agent: ${id}`)
    const spec = entry.oneShot
    if (!spec) throw this.refuse('invalid-params', 'cannot-generate', `${entry.label} can't generate text. Pick another agent.`)
    const selection = this.guard(() =>
      validateSelection(entry, {
        model: requestedModel,
        options: optionValues
      })
    )
    const config = this.deps.configOf(id)
    if (config.disabled) throw this.refuse('invalid-params', 'not-installed', `${entry.label} is disabled. Enable it in Settings.`)
    if (!this.deps.installed(id)) throw this.refuse('invalid-params', 'not-installed', `${entry.label} is not installed.`)

    // the saved launch arguments (permission flags and the like) are for sessions, not for a one-shot run
    const launch = this.guard(() =>
      buildLaunchPlan({
        entry: { ...entry, launch: spec.command ?? entry.launch },
        config: { ...config, args: '' },
        resolveExecutable: this.deps.resolveExecutable
      })
    )
    const words = tokenize(launch.command)
    const { env, rest } = extractEnvAssignments(words.ok ? words.tokens : [])
    return {
      agent: id,
      label: entry.label,
      command: rest,
      env: { ...launch.env, ...env },
      build: (strictMcp) =>
        this.guard(() => {
          const parsed = tokenize(userArgs ?? '')
          if (!parsed.ok) throw new OneShotError(`CLI arguments are invalid: ${parsed.error}`)
          let rawTokens = parsed.tokens
          const catalog = entry.launchOptions
          const valueFlags = catalog?.valueFlags ?? []
          const singletonGroups = oneShotSingletons(entry)
          for (const group of singletonGroups) rawTokens = keepFirstOption(rawTokens, group, valueFlags)
          if (catalog) {
            const prefixed = [
              ...catalog.model.conflicts,
              ...catalog.options.flatMap((option) => option.conflicts)
            ].filter((conflict) => conflict.valuePrefix !== undefined)
            for (const conflict of prefixed) rawTokens = keepFirstPrefixedConflict(rawTokens, conflict, valueFlags)
          }

          const kinds = new Set<ExtraArgKind>()
          if (catalog) {
            if (catalog.model.conflicts.some((conflict) => hasOption(rawTokens, conflict, valueFlags))) kinds.add('model')
            for (const option of catalog.options) {
              if (option.conflicts.some((conflict) => hasOption(rawTokens, conflict, valueFlags))) {
                kinds.add(option.id === 'effort' ? 'effort' : 'repeatable')
              }
            }
          }
          const extras: ParsedExtras | null = rawTokens.length === 0 ? null : { tokens: rawTokens, kinds }
          const picks = resolveLaunch({ entry, commandTokens: [], configuredArgs: [], selection, extras, structured: false })
          const selectedModel = selection?.model ?? undefined
          const selectedEffort = selection?.values.effort
          const models =
            selectedModel !== undefined && !spec.models.some((candidate) => candidate.id === selectedModel)
              ? [...spec.models, { id: selectedModel, label: selectedModel, thinking: typeof selectedEffort === 'string' ? selectedEffort : null }]
              : spec.models
          const rawModel = catalog?.model.conflicts.some((conflict) => hasOption(rawTokens, conflict, valueFlags)) ?? false
          const rawModelUsesConfig = catalog?.model.conflicts.some(
            (conflict) => conflict.valuePrefix !== undefined && hasOption(rawTokens, conflict, valueFlags)
          ) ?? false
          const rawEffort =
            catalog?.options.find((option) => option.id === 'effort')?.conflicts.some((conflict) => hasOption(rawTokens, conflict, valueFlags)) ?? false
          const rawEffortNeedsSuppression =
            catalog?.options
              .find((option) => option.id === 'effort')
              ?.conflicts.some((conflict) => conflict.valuePrefix !== undefined && hasOption(rawTokens, conflict, valueFlags)) ?? false
          const oneShot = {
            ...spec,
            ...(selectedModel === undefined ? {} : { defaultModel: selectedModel }),
            ...(rawModelUsesConfig && catalog ? { args: withoutModelTemplate(spec.args, catalog.model.conflicts.flatMap((conflict) => conflict.flags)) } : {}),
            models,
            singletonOptions: singletonGroups
          }
          const pickedEffort = selection?.values.effort
          const keepGenericEffort = selection?.model === null && typeof pickedEffort === 'string'
          const suppressEffort = rawEffortNeedsSuppression || (rawModel && !rawEffort && !keepGenericEffort)
          const userTokens = [...rawTokens.slice(0, terminatorIndex(rawTokens, valueFlags)), ...picksNotHandledByOneShot(entry, selection, picks), ...rawTokens.slice(terminatorIndex(rawTokens, valueFlags))]
          return buildOneShotCommand(
            { label: entry.label, oneShot },
            {
              userArgs: joinCommand(userTokens),
              prompt,
              strictMcp,
              ...(selectedModel === undefined ? {} : { model: selectedModel }),
              ...(suppressEffort ? { thinking: null } : typeof pickedEffort === 'string' ? { thinking: pickedEffort } : {})
            }
          )
        }),
      spec
    }
  }

  /** The folder to run in: `cwd` when given, else the worktree the caller (or `worktree`) names. */
  private async workingDirectory(params: Params, caller: PluginCaller): Promise<{ cwd: string; worktreeId: string }> {
    const identity = caller.role === 'plugin' ? {} : { ...(caller.cwd ? { cwd: caller.cwd } : {}), ...(caller.worktreeId ? { worktreeId: caller.worktreeId } : {}) }
    let cwd = params.cwd as string | undefined
    let worktreeId = caller.role === 'plugin' ? '' : (caller.worktreeId ?? '')
    if (cwd === undefined) {
      const worktree = (await this.deps.context.call('quirky.worktree/resolve', { selector: (params.worktree as string | undefined) ?? 'current', ...identity })) as {
        id: string
        path: string
      }
      cwd = worktree.path
      worktreeId = worktree.id
    }
    const isDirectory = isAbsolute(cwd) && existsSync(cwd) && statSync(cwd).isDirectory()
    if (!isDirectory) throw this.deps.context.error('invalid-params', 'cwd must be an existing directory')
    return { cwd, worktreeId }
  }

  /** The run's time limit: the caller's, at most a minute; `QUIRKY_TEST_GENERATE_TIMEOUT_MS` replaces it in tests. */
  private timeoutOf(params: Params): number {
    const knob = Number(process.env.QUIRKY_TEST_GENERATE_TIMEOUT_MS)
    if (process.env.QUIRKY_TEST_GENERATE_TIMEOUT_MS !== undefined && Number.isFinite(knob) && knob > 0) return knob
    return Math.min((params.timeoutMs as number | undefined) ?? MAX_GENERATE_TIMEOUT_MS, MAX_GENERATE_TIMEOUT_MS)
  }

  private environment(target: Target, worktreeId: string): Record<string, string> {
    const env = this.deps.context.launch.env({ sessionId: `generate-${randomUUID()}`, worktreeId, agent: target.agent, envPatch: target.env })
    for (const name of SESSION_ENV) delete env[name]
    return env
  }

  /** The decoded text of a run that finished well; every other outcome becomes the error its contract names. */
  private textOf(target: Target, outcome: OneShotOutcome, timeoutMs: number): string {
    const { label } = target
    switch (outcome.kind) {
      case 'timeout':
        throw this.refuse('conflict', 'timeout', `${label} did not finish within ${durationText(timeoutMs)}.`)
      case 'too-much-output':
        throw this.refuse('conflict', 'too-much-output', `${label} produced more than 4 MiB of output.`)
      case 'cancelled':
        throw this.refuse('conflict', 'cancelled', 'Generation was stopped.')
      case 'not-started':
        throw this.refuse('conflict', 'not-started', `${label} could not be started. Check the agent command in Settings and try again.`)
    }
    const output = target.spec?.output ?? 'text'
    if (outcome.code !== 0) {
      if (isMissingCommand(outcome.code, outcome.stderr)) {
        throw this.refuse('conflict', 'not-started', `${label} could not be started. Check the agent command in Settings and try again.`)
      }
      throw this.refuse('conflict', 'failed', failureMessage(label, { ...outcome, output }))
    }
    const decoded = decodeOutput(output, stripAnsi(outcome.stdout))
    if (!decoded.ok) {
      const detail = sanitizeFailureDetail(decoded.error) ?? decoded.error
      throw this.refuse('conflict', 'failed', decoded.reported ? `${label} failed: ${detail}` : detail)
    }
    return decoded.text
  }
}

/** Seconds in words: "60 seconds", "1 second", "0.3 seconds". */
function durationText(ms: number): string {
  const seconds = ms / 1000
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}

/** The shell that starts a run exits 127 (not found) or 126 (not executable) when its command can't start. */
function isMissingCommand(code: number | null, stderr: string): boolean {
  return (code === 127 || code === 126) && /not found|no such file|not executable|permission denied/i.test(stderr)
}
