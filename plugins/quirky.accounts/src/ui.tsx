import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { AccountsSettings } from './window/AccountsSettings'
import { AccountSwitchDialog, SessionAccessory, StatusBarUsage } from './window/Usage'
import { AccountsUiStore } from './window/model'

const STATUS_BAR_ID = 'status-bar:quirky.accounts/usage'
const SETTINGS_ID = 'view:quirky.accounts/settings'
const ACCESSORY_ID = 'view:quirky.accounts/session-accessory'
const SWITCH_DIALOG_ID = 'overlay:quirky.accounts/switch-dialog'
const OPEN_COMMAND_ID = 'command:quirky.accounts/open'
const REFRESH_COMMAND_ID = 'command:quirky.accounts/refresh'

let activeStore: AccountsUiStore | null = null


function setRootClass(element: HTMLElement, kind: 'bar' | 'view' | 'overlay' | 'accessory'): void {
  element.classList.add('accounts-mount-root', `accounts-mount-root--${kind}`)
}

function mountStatusBar(store: AccountsUiStore): MountFunction {
  return (element, props) => {
    setRootClass(element, 'bar')
    const root = createRoot(element)
    root.render(<StatusBarUsage store={store} report={props.report} />)
    return () => root.unmount()
  }
}

export function activate(context: UiPluginContext): void {
  activeStore?.stop()
  const store = new AccountsUiStore(context)
  activeStore = store
  store.start()

  context.provide(STATUS_BAR_ID, mountStatusBar(store))
  const mountSettings: MountFunction = (element, props) => {
    setRootClass(element, 'view')
    const root = createRoot(element)
    root.render(<AccountsSettings context={context} store={store} report={props.report} />)
    return () => root.unmount()
  }
  context.provide(SETTINGS_ID, mountSettings)

  const mountAccessory: MountFunction = (element, props) => {
    setRootClass(element, 'accessory')
    const root = createRoot(element)
    root.render(<SessionAccessory store={store} input={props.input} report={props.report} />)
    return () => root.unmount()
  }
  context.provide(ACCESSORY_ID, mountAccessory)

  const mountSwitchDialog: MountFunction = (element, props) => {
    setRootClass(element, 'overlay')
    const root = createRoot(element)
    root.render(<AccountSwitchDialog store={store} report={props.report} />)
    return () => root.unmount()
  }
  context.provide(SWITCH_DIALOG_ID, mountSwitchDialog)
  context.provide(OPEN_COMMAND_ID, async () => {
    await store.setUiState({ open: true })
    if (!store.getSnapshot().accounts?.preferences.hidden) return
    await store.openSettingsSection('appearance')
  })
  context.provide(REFRESH_COMMAND_ID, () => store.refresh())
}

export function deactivate(): void {
  activeStore?.stop()
  activeStore = null
}
