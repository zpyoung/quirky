import type { BrowserWindow } from 'electron'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { HEIMDALL_FLEET_CHANGED_CHANNEL } from '../../shared/fork-heimdall/fleet-types'
import type { HeimdallFleetTransport } from './fleet-transport'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import { requireHeimdallTransport } from '../runtime/rpc/methods/fork-heimdall/kernel-binding'

export function forwardHeimdallFleetToRenderer(
  transport: Pick<HeimdallFleetTransport, 'subscribe'>,
  getMainWindow: () => BrowserWindow | null,
  getDashboardPopoutWindow: () => BrowserWindow | null
): () => void {
  return transport.subscribe((snapshot) => {
    const windows = [getMainWindow(), getDashboardPopoutWindow()]
    for (const window of windows) {
      if (window && !window.isDestroyed()) {
        window.webContents.send(HEIMDALL_FLEET_CHANGED_CHANNEL, snapshot)
      }
    }
  })
}

export function wireHeimdallFleetWindows(
  runtime: QuirkyRuntimeService,
  getMainWindow: () => BrowserWindow | null
): () => void {
  return forwardHeimdallFleetToRenderer(
    requireHeimdallTransport(runtime),
    getMainWindow,
    getDashboardPopoutWindow
  )
}
