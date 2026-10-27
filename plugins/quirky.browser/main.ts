import type { PluginContext } from '@quirky/protocol'
import { BrowserService } from './src/service'
import { browserDependencies } from './src/runtime/defaults'
import type { BrowserDependencies } from './src/runtime/dependencies'
import type { BrowserPlugin } from './src/service'

let active: BrowserPlugin | undefined

export function createBrowserPlugin(context: PluginContext, dependencies: BrowserDependencies): BrowserPlugin {
  const plugin = new BrowserService(context, dependencies)
  plugin.activate()
  return { deactivate: () => plugin.deactivate() }
}

export function activate(context: PluginContext): void {
  active = createBrowserPlugin(context, browserDependencies(import.meta.dir))
}

export async function deactivate(): Promise<void> {
  const plugin = active
  active = undefined
  await plugin?.deactivate()
}
