import { ipcRenderer } from 'electron'
import type { UiStateSnapshot } from '../../shared/public-rpc/ui-state'

export type UiActionRequest = {
  requestId: string
  actionId: string
  worktreeId?: string
  probeOnly?: boolean
}
export type UiActionReply = { requestId: string; claimed: boolean; reason?: string }
export type UiStateRequest = { requestId: string }
export type UiStateReply = { requestId: string; state: UiStateSnapshot }
export type UiFocusChange = {
  worktreeId?: string
  tabId?: string
  tabType?: string
  view?: string
}
/** Every workspace's open tabs, so main can tell which opened or closed between two reports. */
export type UiTabsChange = { tabs: Record<string, { id: string; type: string }[]> }

/** Optional so a renderer built without this preload (older web shells, test fixtures) still mounts. */
export type UiActionBridgeApi = {
  onRequestUiAction?: (callback: (request: UiActionRequest) => void) => () => void
  replyUiAction?: (reply: UiActionReply) => void
  onRequestUiState?: (callback: (request: UiStateRequest) => void) => () => void
  replyUiState?: (reply: UiStateReply) => void
  notifyUiFocusChanged?: (change: UiFocusChange) => void
  notifyUiTabsChanged?: (change: UiTabsChange) => void
}

export const uiActionBridgeApi = {
  onRequestUiAction: (callback: (request: UiActionRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: UiActionRequest) =>
      callback(request)
    ipcRenderer.on('ui:requestAction', listener)
    return () => ipcRenderer.removeListener('ui:requestAction', listener)
  },
  replyUiAction: (reply: UiActionReply): void => {
    ipcRenderer.send('ui:actionReply', reply)
  },
  onRequestUiState: (callback: (request: UiStateRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: UiStateRequest) =>
      callback(request)
    ipcRenderer.on('ui:requestState', listener)
    return () => ipcRenderer.removeListener('ui:requestState', listener)
  },
  replyUiState: (reply: UiStateReply): void => {
    ipcRenderer.send('ui:stateReply', reply)
  },
  notifyUiFocusChanged: (change: UiFocusChange): void => {
    ipcRenderer.send('ui:focusChanged', change)
  },
  notifyUiTabsChanged: (change: UiTabsChange): void => {
    ipcRenderer.send('ui:tabsChanged', change)
  }
} satisfies UiActionBridgeApi
