import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { SETTINGS_VIEW_ID } from './window/copy'
import { connectionIdFrom, EDIT_CUSTOM_SOUND_COMMAND, NotificationsStore } from './window/model'
import { NotificationsView } from './window/NotificationsView'

/** Activates the notifications plugin's window code: the Notifications settings view and the command that opens it. */
export function activate(context: UiPluginContext): void {
  const stores = new Set<NotificationsStore>()
  const mountSettings: MountFunction = (element, props) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const store = new NotificationsStore(context, props.report)
    const root = createRoot(element)
    const input = props.input
    if (input !== null && typeof input === 'object' && 'customOpen' in input && input.customOpen === true) store.openCustom()
    stores.add(store)
    store.start()
    root.render(<NotificationsView store={store} />)
    return () => {
      stores.delete(store)
      store.stop()
      root.unmount()
    }
  }

  context.provide(SETTINGS_VIEW_ID, mountSettings)
  context.provide('command:quirky.notifications/open-settings', () => context.openView(SETTINGS_VIEW_ID))
  context.provide(EDIT_CUSTOM_SOUND_COMMAND, async (input?: unknown) => {
    if (typeof input === 'object' && input !== null && 'connId' in input) {
      const connId = input.connId
      if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId < 1) {
        throw new Error('connId must be a positive safe integer.')
      }
      const ownConnId = connectionIdFrom(await context.call('ui.window.self', {}))
      if (ownConnId === null) throw new Error('The daemon did not identify this window.')
      if (connId !== ownConnId) {
        await context.call('ui.window.command.run', { connId, id: EDIT_CUSTOM_SOUND_COMMAND, args: {} })
        return
      }
    }
    if (stores.size === 0) {
      context.openView(SETTINGS_VIEW_ID, { customOpen: true })
      return
    }
    for (const store of stores) store.openCustom()
  })
}
