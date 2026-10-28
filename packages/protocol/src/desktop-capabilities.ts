/** Public shell operations carry caller/window identity through the normal daemon routing seam. */
export type FolderPickerRequest = { title?: string; startingFolder?: string; multiple?: boolean }
export type FolderPickerResult = { cancelled: boolean; paths: string[] }
export type DesktopWindowRequest = { view: string; input?: unknown; title?: string }
export type DesktopWindowResult = { windowId: string }

/** Absence of an SDK acknowledgement must never be reported as native delivery or permission. */
export type NativeNotificationCapabilities = {
  permission: boolean
  click: boolean
  dismiss: boolean
}
