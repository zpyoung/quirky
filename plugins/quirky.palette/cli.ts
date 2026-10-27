import type { CliModule } from '@quirky/protocol'

type PaletteState = { open: boolean }

export const commands: CliModule['commands'] = {
  async status(_args, context) {
    const state = (await context.call('quirky.palette/status', {})) as PaletteState
    context.out.result(state, () => `palette: ${state.open ? 'open' : 'closed'}`)
  },

  async set(args, context) {
    const open = args.flags.open === true
    const close = args.flags.close === true
    if (open && close) throw context.usage('pass --open or --close, not both')
    const params = open ? { open: true } : close ? { open: false } : {}
    const state = (await context.call('quirky.palette/set', params)) as PaletteState
    context.out.result(state, () => `palette: ${state.open ? 'open' : 'closed'}`)
  }
}
