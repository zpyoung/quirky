import { useSyncExternalStore } from 'react'
import {
  isTerminalInputQuarantined,
  subscribeTerminalInputQuarantine
} from '../terminal-input-quarantine'

/** Whether the tab's terminal input is quarantined after a re-attach, live as it arms and releases. */
export function useTerminalInputQuarantined(tabId: string): boolean {
  return useSyncExternalStore(
    (notify) => subscribeTerminalInputQuarantine(tabId, notify),
    () => isTerminalInputQuarantined(tabId),
    () => false
  )
}
