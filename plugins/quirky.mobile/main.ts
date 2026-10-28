import type { PluginContext } from '@quirky/protocol'
import { MobileService, registerMobileMethods } from './src/daemon/service'

let service: MobileService | undefined

export async function activate(context: PluginContext): Promise<void> {
  const active = new MobileService(context, {
    ...(process.env.QUIRKY_MOBILE_PORT === undefined ? {} : { portValue: process.env.QUIRKY_MOBILE_PORT }),
    ...(process.env.QUIRKY_MOBILE_HOST === undefined ? {} : { hostValue: process.env.QUIRKY_MOBILE_HOST })
  })
  service = active
  registerMobileMethods(context, active)
  await active.start()
}

export async function deactivate(): Promise<void> {
  const active = service
  service = undefined
  await active?.stop()
}
