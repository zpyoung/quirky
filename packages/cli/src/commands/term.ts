import { UsageError, flagBoolean, flagInt } from '../args'
import { sessionIdOr } from './support'
import type { Command } from './types'

export const termRead: Command = {
  name: 'term read',
  usage: 'term read [<sessionId>] [--lines N]',
  summary: 'print the terminal screen and recent scrollback (session defaults to $QUIRKY_SESSION_ID)',
  flags: { lines: 'int' },
  async run(args, ctx) {
    if (args.positionals.length > 1) throw new UsageError(`unexpected argument "${args.positionals[1]}"`)
    const sessionId = sessionIdOr(args.positionals[0], ctx)
    const lines = flagInt(args, 'lines')
    if (lines !== undefined && lines < 1) throw new UsageError('--lines must be at least 1')
    const result = await ctx.rpc.call('terminal.read', { sessionId, ...(lines ? { lines } : {}) })
    ctx.out.result(result, () => result.lines.join('\n'))
  }
}

export const termSend: Command = {
  name: 'term send',
  usage: 'term send <sessionId> <text> [--enter]',
  summary: 'type text into a terminal; with $QUIRKY_SESSION_ID set, <sessionId> may be omitted',
  flags: { enter: 'boolean' },
  async run(args, ctx) {
    const { positionals } = args
    if (positionals.length > 2) throw new UsageError(`unexpected argument "${positionals[2]}"`)
    const implicitSession = positionals.length === 1 && ctx.env.QUIRKY_SESSION_ID
    if (positionals.length === 0) throw new UsageError('missing <text>')
    const sessionId = implicitSession ? (ctx.env.QUIRKY_SESSION_ID as string) : sessionIdOr(positionals[0], ctx)
    const text = implicitSession ? positionals[0] : positionals[1]
    if (text === undefined) throw new UsageError('missing <text>')
    const enter = flagBoolean(args, 'enter')
    const result = await ctx.rpc.call('terminal.send', { sessionId, text, ...(enter ? { enter } : {}) })
    ctx.out.result(result, () => `sent to ${sessionId}`)
  }
}
