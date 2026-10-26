import { AGENT_KINDS, type AgentKind, type CliModule, type Session } from '@quirky/protocol'

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
    if (typeof agent !== 'string' || agent === '') throw ctx.usage('--agent is required')
    if (!AGENT_KINDS.includes(agent as AgentKind)) throw ctx.usage(`--agent must be one of ${AGENT_KINDS.join(', ')}`)
    const prompt = args.flags.prompt as string | undefined
    const worktree = args.flags.worktree as string | undefined
    const background = args.flags.background === true
    if (background && !prompt) throw ctx.usage('--background requires --prompt')
    const target = worktree ? { worktree } : {}
    const session = (await (background
      ? ctx.call('quirky.structured/create', { ...target, agent, prompt: prompt as string })
      : ctx.call('quirky.session/create', { ...target, agent, ...(prompt ? { prompt } : {}) }))) as Session
    ctx.out.result(session, () =>
      ctx.format.record([
        ['id', session.id],
        ['agent', session.agent],
        ['kind', session.kind],
        ['status', session.status],
        ['worktree', session.worktreeId]
      ])
    )
  },

  async close(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const result = await ctx.call('quirky.session/close', { session })
    ctx.out.result(result, () => `closed ${session}`)
  }
}

/** The CLI finds a command by its contribution name or by its full contribution ID; both resolve here. */
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.session/${name}`, run]))
}
