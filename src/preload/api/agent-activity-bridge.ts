import { ipcRenderer } from 'electron'
import type { AttributedCaller } from '../../shared/public-rpc/caller-hint'

/** One thing an agent or script did through the public API, as pushed by main's activity trail. */
export type AgentActivityEntry = {
  caller: AttributedCaller
  method: string
  summary: string
  workspaceId?: string
  /** Set when the host knows which tab the call touched; main does not send it today. */
  tabId?: string
  at: number
}

/** Optional so a renderer built without this preload (older web shells, test fixtures) still mounts. */
export type AgentActivityBridgeApi = {
  onActivityRecorded?: (callback: (entry: AgentActivityEntry) => void) => () => void
}

export const agentActivityBridgeApi = {
  onActivityRecorded: (callback: (entry: AgentActivityEntry) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: AgentActivityEntry) =>
      callback(entry)
    ipcRenderer.on('activity:recorded', listener)
    return () => ipcRenderer.removeListener('activity:recorded', listener)
  }
} satisfies AgentActivityBridgeApi
