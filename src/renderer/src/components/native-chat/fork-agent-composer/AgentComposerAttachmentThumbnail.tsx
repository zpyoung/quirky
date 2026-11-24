import { useEffect, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  loadLocalImageAbsolutePath,
  onImageCacheInvalidated
} from '@/components/editor/useLocalImageSrc'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { chatImageAccess } from '@/lib/local-file-access'
import { findTerminalTabWorktreeId } from '../native-chat-file-link'
import { attachmentPreviewSourcePath } from './agent-composer-attachment-preview'

export type AgentComposerAttachmentThumbnailProps = {
  path: string
  label: string
  /** Which pane's worktree the attachment belongs to; an SSH pane's uploaded
   *  paths only name a real file on that pane's connection. */
  terminalTabId: string
  className?: string
}

/**
 * The image side of a composer attachment chip: the attached image itself
 * once it can be read, and the generic image icon until then or when it
 * cannot (a remote-only path, a file the user has since deleted).
 */
export function AgentComposerAttachmentThumbnail({
  path,
  label,
  terminalTabId,
  className
}: AgentComposerAttachmentThumbnailProps): React.JSX.Element {
  const source = useAttachmentThumbnailSource(path, terminalTabId)
  // Remembering which source failed rather than a bare flag lets a later source
  // render without a reset pass that would first paint the stale failure.
  const [failedSource, setFailedSource] = useState<string>()

  if (!source || source === failedSource) {
    return <ImageIcon className={cn('size-3.5 shrink-0', className)} />
  }

  return (
    <img
      src={source}
      alt={label}
      onError={() => setFailedSource(source)}
      className={cn('size-5 shrink-0 rounded-sm border border-border object-cover', className)}
    />
  )
}

/** The SSH connection this pane's attachments were uploaded over, or null for
 *  a local worktree. An unresolvable owner reads as local: the remote path then
 *  fails to load and the chip keeps its icon, never another host's image. */
function attachmentPreviewConnectionId(terminalTabId: string): string | null {
  const state = useAppStore.getState()
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  return getConnectionIdFromState(state, worktreeId) ?? null
}

function useAttachmentThumbnailSource(path: string, terminalTabId: string): string | undefined {
  const [source, setSource] = useState<string>()
  // Blob URLs are dropped and re-read when the window regains focus, so an
  // image replaced outside Quirky doesn't keep showing its stale pixels.
  const [cacheGeneration, setCacheGeneration] = useState(0)

  useEffect(() => onImageCacheInvalidated(() => setCacheGeneration((current) => current + 1)), [])

  useEffect(() => {
    let cancelled = false
    setSource(undefined)
    void (async () => {
      const previewPath = attachmentPreviewSourcePath(
        attachmentPreviewConnectionId(terminalTabId),
        path
      )
      let url: string | null = null
      try {
        // Why chat-image: attachments from outside a worktree are otherwise denied.
        url = await loadLocalImageAbsolutePath(previewPath, undefined, undefined, chatImageAccess())
      } catch {
        // An unreadable preview shows the chip without a thumbnail.
      }
      if (!cancelled) {
        setSource(url ?? undefined)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, terminalTabId, cacheGeneration])

  return source
}
