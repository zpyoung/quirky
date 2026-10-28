/** A sandboxed system-webview hosted inside a plugin-owned element. Never available in a plain web client. */
export type NativeBrowserState = {
  id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
  zoom: number; error: string | null; findCurrent: number; findTotal: number
}
export type NativeBrowserRequest =
  | { action: 'navigate'; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'hardReload' | 'stop' }
  | { action: 'find'; text: string; forward?: boolean }
  | { action: 'zoom'; level: number }
export type NativeBrowserOptions = { id: string; url: string; zoom: number; onState(state: NativeBrowserState): void; onPopup?(url: string, userGesture: boolean): void }
export type NativeBrowserHandle = { request(request: NativeBrowserRequest): Promise<NativeBrowserState>; dispose(): void }
export type NativeBrowserCapability = { readonly available: boolean; mount(element: HTMLElement, options: NativeBrowserOptions): NativeBrowserHandle }
