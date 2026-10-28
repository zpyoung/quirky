import type { PluginContext } from '@quirky/protocol'
import { MobileService, registerMobileMethods } from './src/daemon/service'
import { registerMobileNotifications } from './src/daemon/notifications'

let service: MobileService | undefined
let stopNotifications: (() => void) | undefined

export async function activate(context: PluginContext): Promise<void> {
  const active = new MobileService(context, {
    ...(process.env.QUIRKY_MOBILE_PORT === undefined ? {} : { portValue: process.env.QUIRKY_MOBILE_PORT }),
    ...(process.env.QUIRKY_MOBILE_HOST === undefined ? {} : { hostValue: process.env.QUIRKY_MOBILE_HOST })
  })
  service = active
  registerMobileMethods(context, active)
  stopNotifications = registerMobileNotifications(context)
  await active.start()
}

export async function deactivate(): Promise<void> {
  const active = service
  service = undefined
  stopNotifications?.()
  stopNotifications = undefined
  await active?.stop()
}
