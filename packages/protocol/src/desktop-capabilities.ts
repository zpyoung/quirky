/** Public shell operations carry caller/window identity through the normal daemon routing seam. */
export type FolderPickerRequest = { title?: string; startingFolder?: string; multiple?: boolean }
export type FolderPickerResult = { cancelled: boolean; paths: string[] }
export type DesktopWindowRequest = { view: string; input?: unknown; title?: string }
export type DesktopWindowResult = { windowId: string }

export type DesktopWindowOwner = { connId: number; name?: string }
export type DesktopWindowSummary = {
  windowId: string
  view: string | null
  input?: unknown
  title?: string
  ownerShell: DesktopWindowOwner
  attached: boolean
}
export type DesktopWindowOpenRequest = { request: DesktopWindowRequest; ownerShell: DesktopWindowOwner }
export type DesktopWindowAttachRequest = { windowId: string; ownerShellConnId: number }
export type DesktopWindowUpdateRequest = { windowId: string; view: string | null; input?: unknown; title?: string }
export type DesktopWindowClosedRequest = { windowId: string; ownerShellConnId: number }
export type DesktopWindowRunOwnerCommandRequest = { windowId: string; id: string; args?: unknown }
export type DesktopWindowRunOwnerCommandResult = { result: unknown; activated: boolean }

/** Absence of an SDK acknowledgement must never be reported as native delivery or permission. */
export type NativeNotificationCapabilities = {
  permission: boolean
  click: boolean
  dismiss: boolean
}

export type DesktopWindowCloseResult = { closed: boolean }
export type DesktopRevealRequest = { path: string }
export type DesktopRevealResult = { requested: true }

export type NativeDesktopCapabilities = {
  directoryPicker: boolean
  auxiliaryWindows: boolean
  revealItem: boolean
  notifications: NativeNotificationCapabilities
}

export type DesktopShellAction =
  | { kind: 'folder-picker'; request: FolderPickerRequest }
  | { kind: 'window-open'; request: DesktopWindowRequest }
  | { kind: 'window-close'; request: { windowId: string } }
  | { kind: 'window-activate-owner'; request: { windowId: string } }
  | { kind: 'reveal-item'; request: DesktopRevealRequest }

export type DesktopShellResult =
  | FolderPickerResult
  | DesktopWindowResult
  | DesktopWindowCloseResult
  | { activated: boolean }
  | DesktopRevealResult

export type DesktopShellReply = {
  requestId: string
  result?: DesktopShellResult
  error?: { message: string }
}

/** The narrow bridge provided only to the trusted desktop UI webview. */
export type DesktopShellBridge = {
  readonly capabilities: NativeDesktopCapabilities
  pickFolder(request: FolderPickerRequest): Promise<FolderPickerResult>
  openWindow(request: DesktopWindowRequest, ownerShell: DesktopWindowOwner): Promise<DesktopWindowResult>
  closeWindow(windowId: string): Promise<DesktopWindowCloseResult>
  revealItem(request: DesktopRevealRequest): Promise<DesktopRevealResult>
  activateOwner(windowId: string): Promise<{ activated: boolean }>
}
