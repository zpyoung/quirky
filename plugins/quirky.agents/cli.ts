import type { CliContext, CliModule } from '@quirky/protocol'

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

type Plan = {
  command: string
  env: Record<string, string | null>
  promptDelivery: string | null
}

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
    const result = await ctx.call('quirky.agents/setEnabled', { agent, enabled: true })
    ctx.out.result(result, () => `enabled ${agent}`)
  },

  async disable(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const result = await ctx.call('quirky.agents/setEnabled', { agent, enabled: false })
    ctx.out.result(result, () => `disabled ${agent}`)
  },

  async default(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const result = await ctx.call('quirky.agents/setDefault', { agent })
    ctx.out.result(result, () => `default agent: ${agent}`)
  },

  async configure(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const { command, args: argsText, env, reset } = args.flags
    const params: Record<string, unknown> = { agent }
    if (typeof command === 'string') params.command = command
    if (typeof argsText === 'string') params.args = argsText
    if (env !== undefined) params.env = parseEnv(env, ctx)
    if (Array.isArray(reset)) params.reset = reset
    const result = await ctx.call('quirky.agents/configure', params)
    ctx.out.result(result, () => `configured ${agent}`)
  },

  async permissions(args, ctx) {
    const mode = args.positionals[0]
    if (mode === undefined) throw ctx.usage('missing <mode>')
    if (!MODES.includes(mode)) throw ctx.usage(`mode must be one of ${MODES.join(', ')}`)
    const params: Record<string, unknown> = { mode }
    if (typeof args.flags.agent === 'string') params.agent = args.flags.agent
    if (args.flags['replace-custom'] === true) params.replaceCustom = true
    const result = (await ctx.call('quirky.agents/setPermissions', params)) as { changed: string[] }
    ctx.out.result(result, () => (result.changed.length ? `changed: ${result.changed.join(', ')}` : 'no changes'))
  },

  async plan(args, ctx) {
    const agent = agentArg(args.positionals, ctx)
    const params: Record<string, unknown> = { agent }
    if (typeof args.flags.prompt === 'string') params.prompt = args.flags.prompt
    if (args.flags.draft === true) params.submitPrompt = false
    const plan = (await ctx.call('quirky.agents/plan', params)) as Plan
    ctx.out.result(plan, () =>
      ctx.format.record([
        ['command', plan.command],
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
