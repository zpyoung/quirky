import { takePositionals } from './support'
import type { Command } from './types'

export const open: Command = {
  name: 'open',
  usage: 'open',
  summary: 'launch the Quirky desktop app',
  flags: {},
  async run(args, ctx) {
    takePositionals(args, [])
    const result = await ctx.openDesktopApp()
    if (!result.ok) throw new Error(result.reason)
    ctx.out.result({ ok: true }, () => 'opened Quirky')
  }
}
