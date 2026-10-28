import type { PluginContext } from '@quirky/protocol'
import { registerControlApi } from './control-api'
import { createControlHost, type OperatorKernel } from './control-host'
import { createControlPlane } from './control-plane'
import { createFleetService } from './fleet'

/** Installs the operator surface around the same kernel that owns ticks and durable state. */
export async function installControls(context: PluginContext, kernel: OperatorKernel): Promise<{ dispose(): void }> {
  const host = createControlHost(context, kernel)
  const controls = createControlPlane(host)
  const fleet = createFleetService(host, controls)
  registerControlApi(host, controls, fleet)
  const unsubscribe = context.subscribe(event => {
    if (event.type === 'quirky.heimdall/changed') void fleet.publish()
  })
  try {
    // Establishes a live baseline without notifying restored terminal/approval history.
    await fleet.fleet()
  } catch (error) {
    context.log(`Heimdall initial fleet read failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { dispose() { unsubscribe(); fleet.dispose() } }
}
