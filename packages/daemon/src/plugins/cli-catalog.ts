import type { ApiDescription } from '@quirky/protocol'
import type { PluginHost } from './host'

/** The `cli` section of `api.describe`: plugin CLI groups, aliases and commands in effect. */
export function describeCli(_plugins: PluginHost): ApiDescription['cli'] {
  return { groups: [], commands: [] }
}
