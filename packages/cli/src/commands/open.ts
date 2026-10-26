import { takePositionals } from './support'
import type { Command } from './types'

export const open: Command = {
  name: 'open',
  summary: 'launch the Quirky desktop app',
  positionals: [],
  flags: {},
  methods: [],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const result = await ctx.openDesktopApp()
    if (!result.ok) throw new Error(result.reason)
    ctx.out.result({ ok: true }, () => 'opened Quirky')
  }
}
