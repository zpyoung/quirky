import type { PluginContext } from '@quirky/protocol'
import { carryOverOldSwitch, migrations } from './src/migration'
import { NotificationsService } from './src/service'

let service: NotificationsService | undefined

function positiveInteger(text: string | undefined): number | undefined {
  const value = Number(text)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Wires the notifications policy: producers' events in, markers, banners, sounds and the badge out. */
export function activate(context: PluginContext): void {
  const store = context.openStore(migrations)
  const cooldownMs = positiveInteger(process.env.QUIRKY_NOTIFICATION_COOLDOWN_MS)
  const active = new NotificationsService(context, cooldownMs === undefined ? {} : { cooldownMs })
  service = active

  context.provide('method:quirky.notifications/status', () => active.status())
  context.provide('method:quirky.notifications/send', (params: Record<string, unknown>) => active.send(params))
  context.provide('method:quirky.notifications/test', () => active.test())
  context.provide('method:quirky.notifications/preview', (params: Record<string, unknown>) => active.preview(params))

  carryOverOldSwitch(context, store)
  context.subscribe((event) => active.onEvent(event))
  active.start()
}

export function deactivate(): void {
  service?.shutdown()
  service = undefined
}
