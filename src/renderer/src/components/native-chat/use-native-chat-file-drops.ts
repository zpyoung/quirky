import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  useNativeChatExternalAttachments,
  type UseNativeChatExternalAttachmentsArgs
} from './use-native-chat-external-attachments'
import { useNativeChatWorkspaceFileDrop } from './use-native-chat-workspace-file-drop'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatPaneFileDropClaim } from './NativeChatPaneFileDropSurface'
import type { NativeChatAttachmentFocusOptions } from './native-chat-resolved-path-ownership'

type Args = UseNativeChatExternalAttachmentsArgs & {
  paneKey: string
  draftScopeKey?: string
  targetPtyId?: string | null
}

export function useNativeChatFileDrops(args: Args) {
  const external = useNativeChatExternalAttachments(args)
  const workspace = useNativeChatWorkspaceFileDrop(args)
  const destinationKey = JSON.stringify([
    args.paneKey,
    args.draftScopeKey,
    args.targetPtyId,
    args.structuredSession?.sessionId,
    args.structuredWorktreeId,
    args.structuredSession?.runtimeEnvironmentId
  ])
  const destinationRef = useRef(destinationKey)
  useLayoutEffect(() => {
    destinationRef.current = destinationKey
  }, [destinationKey])
  useNativeChatPaneFileDropClaim({
    destinationKey,
    disabled: args.disabled,
    ...workspace,
    captureExternalDrop: () =>
      external.captureExternalDrop(() => destinationRef.current === destinationKey)
  })
  const { captureReservedAttachments } = external
  // A paste's files keep this destination, which a later retarget or deletion cancels.
  const captureCopiedFiles = useCallback(
    (options?: NativeChatAttachmentFocusOptions) =>
      captureReservedAttachments(() => destinationRef.current === destinationKey, options),
    [captureReservedAttachments, destinationKey]
  )
  return {
    ...useNativeChatFileAttachmentActions(external.attachExternalPaths),
    attachExternalPaths: external.attachExternalPaths,
    captureCopiedFiles,
    resolveAttachmentOwner: external.resolveAttachmentOwner
  }
}
