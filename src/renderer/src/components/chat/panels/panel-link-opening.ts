import { openHttpLink } from '@/lib/http-link-routing'

export type PanelLinkOpener = (href: string) => void

/** Opens an http(s) link the way chat links open; other schemes are refused. */
export function openPanelLink(href: string): void {
  if (/^https?:\/\//i.test(href)) {
    openHttpLink(href)
  }
}

/** Opens a local preview URL in Quirky's browser tab for `worktreeId`, or externally without one. */
export function openPanelPreview(url: string, worktreeId: string | null | undefined): void {
  if (worktreeId) {
    openHttpLink(url, { worktreeId, forceInApp: true, allowRemoteInApp: true })
    return
  }
  openHttpLink(url)
}
