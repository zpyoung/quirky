import type { PluginContext, UiLayout, UiState } from '@quirky/protocol'

async function readOpen(context: PluginContext): Promise<boolean> {
  const state = (await context.call('ui.state', {})) as UiState
  return state.layout.palette === true
}

/** Publishes the palette CLI API as a thin adapter over the kernel's canonical layout methods. */
export function activate(context: PluginContext): void {
  context.provide('method:quirky.palette/status', async () => ({ open: await readOpen(context) }))
  context.provide('method:quirky.palette/set', async (params: Record<string, unknown>) => {
    const layout = (await context.call('ui.palette.set', params)) as UiLayout
    return { open: layout.palette === true }
  })
}
