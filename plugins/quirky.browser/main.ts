import type { PluginContext } from '@quirky/protocol'
import { BrowserService } from './src/service'
import { browserDependencies } from './src/runtime/defaults'
import type { BrowserDependencies } from './src/runtime/dependencies'
import type { BrowserPlugin } from './src/service'
import type { PaneTab } from './src/pane-contract'

let active: BrowserPlugin | undefined

export function createBrowserPlugin(context: PluginContext, dependencies: BrowserDependencies): BrowserPlugin {
  const plugin = new BrowserService(context, dependencies)
  plugin.activate()
  return {
    deactivate: () => plugin.deactivate(),
    setPaneProfile: (paneId, profileId) => plugin.setPaneProfile(paneId, profileId),
    listPanes: () => plugin.listPanes()
  }
}

export function activate(context: PluginContext): void {
  active = createBrowserPlugin(context, browserDependencies(import.meta.dir))
}
export function setPaneProfile(paneId: string, profileId: string): Promise<PaneTab> {
  if (!active) throw new Error('browser plugin is not active')
  return active.setPaneProfile(paneId, profileId)
}

export function listPanes(): PaneTab[] {
  return active?.listPanes() ?? []
}

export async function deactivate(): Promise<void> {
  const plugin = active
  active = undefined
  await plugin?.deactivate()
}
