import type { CliArgs, CliContext, CliModule, PtySnapshot } from '@quirky/protocol'
import { paneCommands } from './src/cli/pane'
import { quickFloatingCommands } from './src/cli/quick-floating'
import { workspaceCommands } from './src/cli/workspace'

function singleSessionArg(args: CliArgs, ctx: CliContext): string {
  if (args.positionals.length > 1) throw ctx.usage(`unexpected argument "${args.positionals[1]}"`)
  return sessionIdOr(args.positionals[0], ctx)
}

function noArgs(args: CliArgs, ctx: CliContext): void {
  if (args.positionals.length > 0) throw ctx.usage(`unexpected argument "${args.positionals[0]}"`)
}

function sessionIdOr(explicit: string | undefined, ctx: CliContext): string {
  const id = explicit ?? ctx.env.QUIRKY_SESSION_ID
  if (!id) throw ctx.usage('no session id; pass <sessionId> or set QUIRKY_SESSION_ID')
  return id
}

const named: CliModule['commands'] = {
  ...workspaceCommands,
  ...paneCommands,
  ...quickFloatingCommands,

  async read(args, ctx) {
    const session = singleSessionArg(args, ctx)
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
  },

  async snapshot(args, ctx) {
    const session = singleSessionArg(args, ctx)
    const result = (await ctx.call('quirky.terminal/snapshot', { session })) as PtySnapshot
    // the host owns the screen model; lines 0 asks for the visible rows alone, without history
    const rows = ctx.out.json ? [] : ((await ctx.call('quirky.terminal/read', { session, lines: 0 })) as { lines: string[] }).lines
    ctx.out.result(result, () => rows.join('\n'))
  },

  async history(args, ctx) {
    const session = singleSessionArg(args, ctx)
    const { lines, before, ansi } = args.flags as { lines?: number; before?: string; ansi?: boolean }
    if (lines !== undefined && lines < 1) throw ctx.usage('--lines must be at least 1')
    const result = (await ctx.call('quirky.terminal/history', {
      session,
      ...(lines === undefined ? {} : { lines }),
      ...(before === undefined ? {} : { before }),
      ...(ansi === true ? { format: 'ansi' } : {})
    })) as { lines: string[]; cursor: string | null }
    ctx.out.result(result, () => result.lines.join('\n'))
    if (!ctx.out.json && result.cursor !== null) process.stderr.write(`next: ${result.cursor}\n`)
  },

  async sessions(args, ctx) {
    noArgs(args, ctx)
    const result = (await ctx.call('quirky.terminal/sessions', {})) as {
      sessions: { sessionId: string; state: string; shellState: string; pid: number; workspace: string }[]
    }
    ctx.out.result(result, () =>
      ctx.format.table(
        ['ID', 'STATE', 'SHELL', 'PID', 'WORKSPACE'],
        result.sessions.map((s) => [s.sessionId, s.state, s.shellState, String(s.pid), s.workspace])
      )
    )
  },

  async kill(args, ctx) {
    if (args.positionals.length > 1) throw ctx.usage(`unexpected argument "${args.positionals[1]}"`)
    const session = args.positionals[0]
    if (!session) throw ctx.usage('missing <session>')
    const result = await ctx.call('quirky.terminal/kill', { session })
    ctx.out.result(result, () => `killed ${session}`)
  },

  async 'kill-all'(args, ctx) {
    noArgs(args, ctx)
    const result = (await ctx.call('quirky.terminal/killAll', {})) as { killedCount: number }
    ctx.out.result(result, () => `killed ${result.killedCount} sessions`)
  },

  async 'restart-host'(args, ctx) {
    noArgs(args, ctx)
    const result = (await ctx.call('quirky.terminal/restartHost', {})) as { pid: number }
    ctx.out.result(result, () => `terminal host restarted (pid ${result.pid})`)
  }
}

/** The CLI finds a command by its contribution name or by its full contribution ID; both resolve here. */
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.terminal/${name}`, run]))
}
