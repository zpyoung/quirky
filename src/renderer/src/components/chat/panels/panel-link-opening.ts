import { openRoutedHttpLink, type HttpLinkDestination } from '@/lib/http-link-destinations'
import { resolveNativeChatHttpLinkSourceOwner } from '@/components/native-chat/native-chat-http-link-source-owner'
import { useAppStore } from '@/store'

export type PanelLinkOpener = (href: string) => void

function openOwned(
  url: string,
  worktreeId: string | null | undefined,
  destination: HttpLinkDestination | undefined
): void {
  if (!worktreeId) {
    return
  }
  openRoutedHttpLink(url, {
    worktreeId,
    sourceOwner: resolveNativeChatHttpLinkSourceOwner(useAppStore.getState(), worktreeId),
    modifierHeld: false,
    ...(destination ? { forceDestination: destination } : {})
  })
}

/**
 * Opens an http(s) link for the workspace that owns the panel; other schemes are refused, and so
 * is a link with no workspace, since nothing says which machine it belongs to.
 */
export function openPanelLink(href: string, worktreeId?: string | null): void {
  if (/^https?:\/\//i.test(href)) {
    openOwned(href, worktreeId, undefined)
  }
}

/** Opens a local preview URL in Quirky's browser tab for the workspace that owns it. */
export function openPanelPreview(url: string, worktreeId: string | null | undefined): void {
  openOwned(url, worktreeId, 'quirky')
}
