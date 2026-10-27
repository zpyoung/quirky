import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { PLUGIN_ID, SETTINGS_VIEW_ID } from './window/copy'
import { NotificationsStore } from './window/model'
import { NotificationsView } from './window/NotificationsView'

/** Activates the notifications plugin's window code: the Notifications settings view and the command that opens it. */
export function activate(context: UiPluginContext): void {
  const mountSettings: MountFunction = (element, props) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const store = new NotificationsStore(context, props.report)
    const root = createRoot(element)
    store.start()
    root.render(<NotificationsView store={store} />)
    return () => {
      store.stop()
      root.unmount()
    }
  }

  context.provide(SETTINGS_VIEW_ID, mountSettings)
  context.provide(`command:${PLUGIN_ID}/open-settings`, () => context.openView(SETTINGS_VIEW_ID))
}
