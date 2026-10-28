import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { BrowserSettings } from './preferences-window/BrowserSettings'

/** Preference contributions share the ordinary settings and window-command hosts. */
export function registerPreferencesUi(context: UiPluginContext): void {
  const mountSettings = (embedded: boolean): MountFunction => (element, props) => {
    Object.assign(element.style, { minWidth: '0', width: '100%', overflow: 'auto' })
    const root = createRoot(element)
    root.render(<BrowserSettings context={context} embedded={embedded} onError={(message) => context.toast('Browser settings', message)} />)
    props.report?.({ section: 'browser' })
    return () => root.unmount()
  }
  context.provide('settings-section:quirky.browser/browser-preferences', mountSettings(true))
  context.provide('view:quirky.browser/browser-settings', mountSettings(false))
  context.provide('command:quirky.browser/browserSettings', async () => {
    await context.call('ui.view.open', { id: 'view:quirky.browser/browser-settings' })
  })
  context.provide('command:quirky.browser/profileClearNative', async (args: unknown) => {
    if (args === null || typeof args !== 'object' || !('request' in args) || typeof args.request !== 'string') {
      throw new Error('A pending confirmed profile clear request is required.')
    }
    if (!context.nativeBrowser.available) throw new Error('Native Browser profile clearing requires the desktop window.')
    if (!context.nativeBrowser.clearPartitionAvailable) throw new Error('Native profile clearing is unavailable: the SDK provides no deletion completion acknowledgement. Cookies, Chrome data and profile metadata were preserved.')
    const claim = await context.call('quirky.browser/profileClearNativeClaim', { request: args.request }) as { partition: string }
    if (!/^persist:quirky-browser-(?:default|profile_[0-9a-f]{32})$/.test(claim.partition)) {
      throw new Error('The profile clear request did not name a Browser partition.')
    }
    await context.nativeBrowser.clearPartition(claim.partition)
    return { cleared: true }
  })
}
