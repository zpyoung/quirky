import type { CliModule, Session } from '@quirky/protocol'

const recordRows = (session: Session): [string, string][] => [
  ['id', session.id],
  ['agent', session.agent],
  ['kind', session.kind],
  ['status', session.status],
  ['worktree', session.worktreeId]
]

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
    const session = (await (background
      ? ctx.call('quirky.structured/create', { ...target, agent, prompt: prompt as string })
      : ctx.call('quirky.session/create', {
          ...target,
          ...(agent === undefined ? {} : { agent }),
          ...(prompt ? { prompt } : {}),
          ...(wait ? { waitForPrompt: true } : {}),
          ...(draft ? { submitPrompt: false } : {})
        }))) as Session
    ctx.out.result(session, () => ctx.format.record([...recordRows(session), ['prompt', session.promptDelivery ?? 'none']]))
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
