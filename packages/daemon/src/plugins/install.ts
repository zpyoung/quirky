import type { PluginInfo, PluginInspection } from '@quirky/protocol'
import { internal } from '../errors'
import type { PluginHost } from './host'

export type PluginInstallDeps = { home: string; plugins: PluginHost; log: (message: string) => void }

/** Reads a plugin directory's manifest and lists its contributions; runs no plugin code. */
export function inspectPlugin(_deps: PluginInstallDeps, _path: string): PluginInspection {
  throw internal('not implemented: inspectPlugin')
}

/** Copies the plugin at `path` into `<home>/plugins` (replacing an earlier install) and rescans. */
export async function installPlugin(_deps: PluginInstallDeps, _path: string): Promise<PluginInfo> {
  throw internal('not implemented: installPlugin')
}

/** Removes an installed plugin and its data, then rescans. */
export async function uninstallPlugin(_deps: PluginInstallDeps, _id: string): Promise<void> {
  throw internal('not implemented: uninstallPlugin')
}
