import type { CliContext, CliModule, OwnerRuntimeCallResult } from '@quirky/protocol'
import { joinCommand } from './src/core/shell'

type Permissions = { mode: string | null; hasAuto: boolean }

type AgentRecord = {
  id: string
  label: string
  plugin: string
  installed: boolean
  enabled: boolean
  isDefault: boolean
  promptMode: string
  resumable: boolean
  canFork: boolean
  homepage: string | null
  install: string | null
  command: string
  commandOverridden: boolean
  args: string
  argsOverridden: boolean
  env: Record<string, string>
  envOverridden: boolean
  permissions: Permissions
}

type Listing = {
  defaultAgent: string
  permissions: { summary: string }
  agents: AgentRecord[]
  problems?: { plugin: string; id: string; status: string; error: string }[]
}

type LaunchSettings = { summary: string }

type Plan = {
  command: string
  env: Record<string, string | null>
  promptDelivery: string | null
  launchSettings: LaunchSettings | null
}

type OptionInfo = { id: string; type: string; choices: { value: string }[] | null }

type OptionsInfo = {
  agent: string
  host: string
  supported: boolean
  models: { id: string; label: string; description: string | null; options: OptionInfo[] }[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: OptionInfo[]
  extraArgs: { supported: boolean; allowed: string | null; placeholder: string | null; message: string | null }
}

type Resolved = {
  added: string[]
  args: string
  structured: Record<string, string | boolean>
  shadowed: string[]
  launchSettings: LaunchSettings | null
}

type LaunchPicks = { model?: string; options?: Record<string, string | boolean>; extraArgs?: string }

const MODES = ['manual', 'auto', 'yolo']

const yesNo = (value: boolean) => (value ? 'yes' : 'no')

function agentArg(positionals: string[], ctx: CliContext): string {
  const agent = positionals[0]
  if (agent === undefined) throw ctx.usage('missing <agent>')
  return agent
}

/** `KEY=VALUE` pairs as one environment object; the first `=` splits, so values may contain `=`. */
function parseEnv(pairs: unknown, ctx: CliContext): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of Array.isArray(pairs) ? (pairs as string[]) : []) {
    const eq = pair.indexOf('=')
    if (eq < 1) throw ctx.usage(`--env expects KEY=VALUE, got "${pair}"`)
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

/** Environment additions as `KEY=VALUE` words; a variable the launch removes shows as `-KEY`. */
function formatEnv(env: Record<string, string | null>): string {
  const words = Object.entries(env).map(([key, value]) => (value === null ? `-${key}` : `${key}=${value}`))
  return words.length ? words.join(' ') : '-'
}

/**
 * Turns `--model`, `--effort`, `--option KEY=VALUE` and `--extra-args` into launch params. An option
 * needs a model, a key is set once, and `true`/`false` values become booleans.
 */
function selectionParams(flags: Record<string, unknown>, ctx: CliContext): LaunchPicks {
  const model = flags.model as string | undefined
  const effort = flags.effort as string | undefined
  const entries = flags.option === undefined ? [] : ([flags.option].flat() as string[])
  const options: Record<string, string | boolean> = Object.create(null)
  for (const entry of entries) {
    const at = entry.indexOf('=')
    if (at === -1) throw ctx.usage(`--option expects KEY=VALUE, got "${entry}"`)
    const key = entry.slice(0, at)
    if (key === '') throw ctx.usage(`--option needs a key before "=", got "${entry}"`)
    if (Object.hasOwn(options, key)) throw ctx.usage(`--option ${key} given more than once`)
    const value = entry.slice(at + 1)
    options[key] = value === 'true' ? true : value === 'false' ? false : value
  }
  if (effort !== undefined) {
    if (Object.hasOwn(options, 'effort')) throw ctx.usage('effort is set by both --effort and --option effort=…')
    options.effort = effort
  }
  if (model === undefined && effort !== undefined) throw ctx.usage('--effort requires --model')
  if (model === undefined && entries.length > 0) throw ctx.usage('--option requires --model')
  return {
    ...(model === undefined ? {} : { model }),
    ...(Object.keys(options).length === 0 ? {} : { options }),
    ...(flags['extra-args'] === undefined ? {} : { extraArgs: flags['extra-args'] as string })
  }
}

/** Options as `id: v1|v2` cells joined by `; `, with `-` for none; a boolean offers `true|false`. */
function formatOptions(options: OptionInfo[]): string {
  if (options.length === 0) return '-'
  return options.map((o) => `${o.id}: ${o.choices ? o.choices.map((c) => c.value).join('|') : 'true|false'}`).join('; ')
}

function formatCatalog(info: OptionsInfo, ctx: CliContext): string {
  const lines: string[] = []
  if (!info.supported) {
    lines.push(`Agent ${info.agent} does not support launch-time model selection.`)
  } else {
    lines.push(
      info.models.length
        ? ctx.format.table(
            ['MODEL', 'LABEL', 'OPTIONS', 'DESCRIPTION'],
            info.models.map((m) => [m.id, m.label, formatOptions(m.options), m.description ?? '-'])
          )
        : 'no listed models'
    )
    lines.push(
      info.unlisted === 'refuse'
        ? 'unlisted models: refused'
        : `unlisted models: accepted${info.unlistedOptions.length ? `, with ${formatOptions(info.unlistedOptions)}` : ''}`
    )
  }
  if (info.host !== 'local') lines.push(`Host: ${info.host}`)
  const extra = info.extraArgs
  lines.push(
    `extra arguments: ${extra.supported ? `${extra.allowed} (for example ${extra.placeholder})` : extra.message}`
  )
  return lines.join('\n')
}

function formatListing(listing: Listing, ctx: CliContext): string {
  const table = ctx.format.table(
    ['ID', 'LABEL', 'INSTALLED', 'ENABLED', 'DEFAULT', 'PERMISSIONS', 'PROMPT', 'RESUME'],
    listing.agents.map((a) => [
      a.id,
      a.label,
      yesNo(a.installed),
      yesNo(a.enabled),
      yesNo(a.isDefault),
      a.permissions.mode ?? '-',
      a.promptMode,
      yesNo(a.resumable)
    ])
  )
  const problems = (listing.problems ?? []).map((p) => `${p.plugin} ${p.id} ${p.status}: ${p.error}`)
  return [table, `default: ${listing.defaultAgent}  permissions: ${listing.permissions.summary}`, ...problems].join('\n')
}

function runtimeCallResult(value: unknown): value is OwnerRuntimeCallResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const runtime = result.runtime
  return Object.hasOwn(result, 'result') &&
    typeof runtime === 'object' && runtime !== null && !Array.isArray(runtime) &&
    typeof (runtime as Record<string, unknown>).id === 'string' &&
    typeof (runtime as Record<string, unknown>).name === 'string'
}

function runtimeLine(runtime: OwnerRuntimeCallResult['runtime']): string {
  return `Runtime: ${runtime.name} (${runtime.id})`
}

function hostedText<T>(value: T | OwnerRuntimeCallResult, format: (result: T) => string): string {
  return runtimeCallResult(value)
    ? `${runtimeLine(value.runtime)}\n${format(value.result as T)}`
    : format(value as T)
}

async function callAtHost(
  ctx: CliContext,
  host: unknown,
  method: string,
  params: Record<string, unknown>,
  allowPeer: boolean
): Promise<unknown> {
  if (host === undefined || host === 'local') {
    return ctx.call(method, host === 'local' ? { ...params, host } : params)
  }
  if (typeof host !== 'string' || host.trim() === '') throw ctx.usage('--host must be local or a non-empty provider host')
  if (host.startsWith('runtime:')) {
    const runtime = host.slice('runtime:'.length)
    if (runtime === '' || runtime.trim() !== runtime || runtime.length > 2048 || /[\u0000-\u001f\u007f]/.test(runtime)) {
      throw ctx.usage('--host runtime selector must name a saved owner target')
    }
    return ctx.call('quirky.cli/runtimeCall', { runtime, method, params })
  }
  if (!allowPeer) throw ctx.usage('provider configuration changes support local or runtime:<saved owner selector> only')
  return ctx.call(method, { ...params, host })
}
function redactAgentEnvironments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAgentEnvironments)
  if (typeof value !== 'object' || value === null) return value
  const result = { ...(value as Record<string, unknown>) }
  if (typeof result.env === 'object' && result.env !== null && !Array.isArray(result.env)) {
    result.env = Object.fromEntries(Object.keys(result.env).map((name) => [name, '[redacted]']))
  }
  if (Array.isArray(result.agents)) result.agents = result.agents.map(redactAgentEnvironments)
  return result
}

function safeOwnerConfigResult(value: unknown): unknown {
  return runtimeCallResult(value) ? { ...value, result: redactAgentEnvironments(value.result) } : value
}


const named: CliModule['commands'] = {
  async list(args, ctx) {
    const listing = (await ctx.call('quirky.agents/list', args.flags.all === true ? { all: true } : {})) as Listing
    ctx.out.result(listing, () => formatListing(listing, ctx))
  },

  async get(args, ctx) {
    const agent = (await ctx.call('quirky.agents/get', { agent: agentArg(args.positionals, ctx) })) as AgentRecord
    ctx.out.result(agent, () =>
      ctx.format.record([
        ['id', agent.id],
        ['label', agent.label],
        ['plugin', agent.plugin],
        ['installed', yesNo(agent.installed)],
        ['enabled', yesNo(agent.enabled)],
        ['default', yesNo(agent.isDefault)],
        ['prompt', agent.promptMode],
        ['resume', yesNo(agent.resumable)],
        ['fork', yesNo(agent.canFork)],
        ['command', agent.command],
        ['command override', yesNo(agent.commandOverridden)],
        ['args', agent.args || '-'],
        ['args override', yesNo(agent.argsOverridden)],
        ['env', formatEnv(agent.env)],
        ['env override', yesNo(agent.envOverridden)],
        ['permissions', agent.permissions.mode ?? '-'],
        ['homepage', agent.homepage ?? '-'],
        ['install', agent.install ?? '-']
      ])
    )
  },

  async refresh(_args, ctx) {
    const listing = (await ctx.call('quirky.agents/refresh', {})) as Listing
    ctx.out.result(listing, () => formatListing(listing, ctx))
  },

  async enable(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const result = await callAtHost(ctx, args.flags.host, 'quirky.agents/setEnabled', { agent, enabled: true }, false)
    ctx.out.result(safeOwnerConfigResult(result), () => hostedText(result, () => `enabled ${agent}`))
  },

  async disable(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const result = await callAtHost(ctx, args.flags.host, 'quirky.agents/setEnabled', { agent, enabled: false }, false)
    ctx.out.result(safeOwnerConfigResult(result), () => hostedText(result, () => `disabled ${agent}`))
  },

  async default(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const result = await callAtHost(ctx, args.flags.host, 'quirky.agents/setDefault', { agent }, false)
    ctx.out.result(safeOwnerConfigResult(result), () => hostedText(result, () => `default agent: ${agent}`))
  },

  async configure(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const { command, args: argsText, env, reset } = args.flags
    const params: Record<string, unknown> = { agent }
    if (typeof command === 'string') params.command = command
    if (typeof argsText === 'string') params.args = argsText
    if (env !== undefined) params.env = parseEnv(env, ctx)
    if (Array.isArray(reset)) params.reset = reset
    const result = await callAtHost(ctx, args.flags.host, 'quirky.agents/configure', params, false)
    ctx.out.result(safeOwnerConfigResult(result), () => hostedText(result, () => `configured ${agent}`))
  },

  async permissions(args, ctx) {
    const mode = args.positionals[0]
    if (mode === undefined) throw ctx.usage('missing <mode>')
    if (!MODES.includes(mode)) throw ctx.usage(`mode must be one of ${MODES.join(', ')}`)
    const params: Record<string, unknown> = { mode }
    if (typeof args.flags.agent === 'string') params.agent = args.flags.agent
    if (args.flags['replace-custom'] === true) params.replaceCustom = true
    const result = await callAtHost(ctx, args.flags.host, 'quirky.agents/setPermissions', params, false) as
      { changed: string[] } | OwnerRuntimeCallResult
    ctx.out.result(result, () => hostedText(result, (local) =>
      local.changed.length ? `changed: ${local.changed.join(', ')}` : 'no changes'
    ))
  },

  async options(args, ctx) {
    const host = args.flags.host
    const info = await callAtHost(ctx, host, 'quirky.agents/options', {
      agent: agentArg(args.positionals, ctx)
    }, true) as OptionsInfo | OwnerRuntimeCallResult
    ctx.out.result(info, () => hostedText(info, (local) => formatCatalog(local, ctx)))
  },

  async 'discover-models'(args, ctx) {
    const host = args.flags.host
    if (typeof host !== 'string' || host.trim() === '') throw ctx.usage('missing --host')
    const result = await callAtHost(ctx, host, 'quirky.agents/discoverModels', {
      agent: agentArg(args.positionals, ctx),
      host: 'local'
    }, true) as { agent: string; host: string; status: string; authoritative: boolean; models: unknown[]; reason?: string } | OwnerRuntimeCallResult
    ctx.out.result(result, () => hostedText(result, (local) =>
      `${local.agent} on ${local.host}: ${local.status}, ${local.authoritative ? 'authoritative' : 'non-authoritative'}, ${local.models.length} models${local.reason ? `; ${local.reason}` : ''}`
    ))
  },

  async resolve(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const params: Record<string, unknown> = { agent, ...selectionParams(args.flags, ctx) }
    const result = await callAtHost(ctx, args.flags.host, 'quirky.agents/resolveLaunch', params, true) as Resolved | OwnerRuntimeCallResult
    ctx.out.result(result, () => hostedText(result, (local) => {
      const structured = Object.entries(local.structured).map(([key, value]) => `${key}=${value}`)
      return ctx.format.record([
        ['added', local.added.length ? joinCommand(local.added) : '-'],
        ['args', local.args || '-'],
        ['structured', structured.length ? structured.join(' ') : '-'],
        ['set by extra args', local.shadowed.length ? local.shadowed.join(', ') : '-'],
        ['launch', local.launchSettings?.summary ?? '-']
      ])
    }))
  },

  async plan(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const params: Record<string, unknown> = { agent, ...selectionParams(args.flags, ctx) }
    if (typeof args.flags.prompt === 'string') params.prompt = args.flags.prompt
    if (args.flags.draft === true) params.submitPrompt = false
    const plan = (await ctx.call('quirky.agents/plan', params)) as Plan
    ctx.out.result(plan, () =>
      ctx.format.record([
        ['command', plan.command],
        ...(plan.launchSettings ? [['launch', plan.launchSettings.summary] as [string, string]] : []),
        ['prompt', plan.promptDelivery ?? 'none'],
        ['env', formatEnv(plan.env)]
      ])
    )
  }
}

export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.agents/${name}`, run]))
}
