import type { CliContext, CliModule, Session } from '@quirky/protocol'

const recordRows = (session: Session): [string, string][] => [
  ['id', session.id],
  ['agent', session.agent],
  ['kind', session.kind],
  ['status', session.status],
  ['worktree', session.worktreeId],
  ...(session.unread ? ([['unread', session.unread]] as [string, string][]) : [])
]

/** What the launch applied, as record rows; none when the session recorded nothing. */
const launchRows = (session: Session): [string, string][] => {
  const settings = session.launchSettings
  if (typeof settings?.summary !== 'string') return []
  const args = settings.args?.value
  return [['launch', settings.summary], ...(typeof args === 'string' ? [['launch args', args] as [string, string]] : [])]
}

type Flags = Record<string, unknown>
type LaunchPicks = { model?: string; options?: Record<string, string | boolean>; extraArgs?: string }

/**
 * Turns `--model`, `--effort`, `--option KEY=VALUE` and `--extra-args` into launch params. An option
 * needs a model, a key is set once, and `true`/`false` values become booleans.
 */
function selectionParams(flags: Flags, ctx: CliContext): LaunchPicks {
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

const named: CliModule['commands'] = {
  async list(args, ctx) {
    const worktree = args.flags.worktree as string | undefined
    const sessions = (await ctx.call('quirky.session/list', worktree ? { worktree } : {})) as Session[]
    ctx.out.result(sessions, () =>
      sessions.length
        ? ctx.format.table(
            ['ID', 'AGENT', 'KIND', 'STATUS', 'WORKTREE', 'TITLE'],
            sessions.map((s) => [s.id, s.agent, s.kind, s.status, s.worktreeId, s.title])
          )
        : 'no sessions'
    )
  },

  async get(args, ctx) {
    const id = args.positionals[0]
    if (id === undefined) throw ctx.usage('missing <session>')
    const session = (await ctx.call('quirky.session/get', { session: id })) as Session
    ctx.out.result(session, () => ctx.format.record([...recordRows(session), ...launchRows(session)]))
  },

  async new(args, ctx) {
    const agent = args.flags.agent
    if (agent !== undefined && (typeof agent !== 'string' || agent === '')) throw ctx.usage('--agent must name an agent')
    const prompt = args.flags.prompt as string | undefined
    const worktree = args.flags.worktree as string | undefined
    const background = args.flags.background === true
    const wait = args.flags.wait === true
    const draft = args.flags.draft === true
    if (background && !prompt) throw ctx.usage('--background requires --prompt')
    if (background && agent === undefined) throw ctx.usage('--background requires --agent')
    if (background && (wait || draft)) throw ctx.usage('--wait and --draft do not apply to --background')
    const target = worktree ? { worktree } : {}
    const picks = selectionParams(args.flags, ctx)
    const session = (await (background
      ? ctx.call('quirky.structured/create', { ...target, agent, prompt: prompt as string, ...picks })
      : ctx.call('quirky.session/create', {
          ...target,
          ...(agent === undefined ? {} : { agent }),
          ...picks,
          ...(prompt ? { prompt } : {}),
          ...(wait ? { waitForPrompt: true } : {}),
          ...(draft ? { submitPrompt: false } : {})
        }))) as Session
    ctx.out.result(session, () => ctx.format.record([...recordRows(session), ...launchRows(session), ['prompt', session.promptDelivery ?? 'none']]))
  },

  async resume(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const providerSession = args.flags['provider-session'] as string | undefined
    const transcriptPath = args.flags.transcript as string | undefined
    const resumed = (await ctx.call('quirky.session/resume', {
      session,
      ...(providerSession === undefined ? {} : { providerSession }),
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
      ...(args.flags.fork === true ? { fork: true } : {})
    })) as Session
    ctx.out.result(resumed, () => ctx.format.record([...recordRows(resumed), ['resumed-from', resumed.resumedFrom ?? session]]))
  },

  async 'set-provider-session'(args, ctx) {
    const [session, id] = args.positionals
    if (session === undefined) throw ctx.usage('missing <session>')
    if (id === undefined) throw ctx.usage('missing <id>')
    const transcriptPath = args.flags.transcript as string | undefined
    const updated = (await ctx.call('quirky.session/setProviderSession', {
      session,
      id,
      ...(transcriptPath === undefined ? {} : { transcriptPath })
    })) as Session
    ctx.out.result(updated, () => `set provider session of ${updated.id} to ${id}`)
  },

  async close(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const result = await ctx.call('quirky.session/close', { session })
    ctx.out.result(result, () => `closed ${session}`)
  },

  async restore(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const before = (await ctx.call('quirky.session/get', { session })) as Session
    const result = (await ctx.call('quirky.session/restore', { session })) as Session
    ctx.out.result(result, () => (before.status === 'exited' ? `restored ${session}` : `${session} is already running`))
  }
}

/** The CLI finds a command by its contribution name or by its full contribution ID; both resolve here. */
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.session/${name}`, run]))
}
