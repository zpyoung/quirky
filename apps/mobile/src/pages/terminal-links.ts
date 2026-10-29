import { safeExternalUrl } from '../shell/shell-security'

export type TerminalLinkMode = 'phone' | 'desktop'
export type TerminalLinkLaunchers = {
  openExternal(url: string): Promise<void>
  openChromeWatch(url: string): Promise<void>
}

export async function dispatchTerminalLink(value: unknown, mode: TerminalLinkMode, launchers: TerminalLinkLaunchers): Promise<void> {
  const url = safeExternalUrl(value)
  if (!url) throw new Error('Only valid http(s) terminal links can be opened.')
  if (mode === 'phone') return launchers.openExternal(url)
  return launchers.openChromeWatch(url)
}
