import type { CliContext, CliModule } from '@quirky/protocol'

function sessionIdOr(explicit: string | undefined, ctx: CliContext): string {
  const id = explicit ?? ctx.env.QUIRKY_SESSION_ID
  if (!id) throw ctx.usage('no session id; pass <sessionId> or set QUIRKY_SESSION_ID')
  return id
}

const named: CliModule['commands'] = {
  async read(args, ctx) {
    if (args.positionals.length > 1) throw ctx.usage(`unexpected argument "${args.positionals[1]}"`)
    const session = sessionIdOr(args.positionals[0], ctx)
    const lines = args.flags.lines as number | undefined
    if (lines !== undefined && lines < 1) throw ctx.usage('--lines must be at least 1')
    const result = (await ctx.call('quirky.terminal/read', { session, ...(lines ? { lines } : {}) })) as { lines: string[] }
    ctx.out.result(result, () => result.lines.join('\n'))
  },

  async send(args, ctx) {
    const { positionals } = args
    if (positionals.length > 2) throw ctx.usage(`unexpected argument "${positionals[2]}"`)
    if (positionals.length === 0) throw ctx.usage('missing <text>')
    const implicitSession = positionals.length === 1 && ctx.env.QUIRKY_SESSION_ID
    const session = implicitSession ? (ctx.env.QUIRKY_SESSION_ID as string) : sessionIdOr(positionals[0], ctx)
    const text = implicitSession ? positionals[0] : positionals[1]
    if (text === undefined) throw ctx.usage('missing <text>')
    const enter = args.flags.enter === true
    const result = await ctx.call('quirky.terminal/send', { session, text, ...(enter ? { enter } : {}) })
    ctx.out.result(result, () => `sent to ${session}`)
  }
}

/** The CLI finds a command by its contribution name or by its full contribution ID; both resolve here. */
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.terminal/${name}`, run]))
}
