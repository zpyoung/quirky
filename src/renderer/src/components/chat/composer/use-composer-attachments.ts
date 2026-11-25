import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { formatNativeChatFileReference } from '@/components/native-chat/native-chat-composer-target'
import type { NativeChatComposerInput } from '@/components/native-chat/native-chat-composer-input'
import { useNativeChatComposerAttachments } from '@/components/native-chat/use-native-chat-composer-attachments'
import { useNativeChatComposerPaste } from '@/components/native-chat/use-native-chat-composer-paste'
import { useNativeChatFileDrops } from '@/components/native-chat/use-native-chat-file-drops'
import {
  clipboardEventCopiedFilePaths,
  clipboardEventImageFile
} from '@/components/native-chat/native-chat-clipboard-payload'
import type { ComposerEditorHandle, ImeGesture } from './editor/types'
import type { ComposerMode, ComposerWorkspace } from './composer-types'

/** An image chip as the draft store and the pending-upload cache describe it. */
export type ComposerImage = {
  id: string
  /** Empty while `pending`. */
  path: string
  connectionId?: string
  previewUrl?: string
  pending?: boolean
  pendingName?: string
  /** Set on an image the draft names but can't send: the file to attach again. */
  unavailableName?: string
}

const NO_TAB = ''
const hasWhitespace = (path: string) => /\s/.test(path)

/**
 * Wires the chat's paste, picker and drop hooks to the CodeMirror editor. The hooks speak to a
 * textarea-shaped input, so the editor is presented to them through one; image chips live in the
 * draft store under the scope key and come back as `images`. Without a `workspace` the composer
 * takes no attachments.
 */
export function useComposerAttachments(args: {
  scopeKey: string
  mode: ComposerMode
  workspace: ComposerWorkspace | undefined
  acceptsImages: boolean
  disabled: boolean
  ime: ImeGesture
  editor: RefObject<ComposerEditorHandle | null>
  replaceText: (next: string) => void
  setNotice: (notice: string | null) => void
}): {
  images: ComposerImage[]
  removeImage: (id: string) => void
  pickAttachments: () => void
  /** Takes images and copied files off a paste; false leaves the paste to the editor. */
  takePaste: (event: ClipboardEvent) => boolean
  flushPendingAttachments: () => void
} {
  const {
    scopeKey,
    mode,
    workspace,
    acceptsImages,
    disabled,
    ime,
    editor,
    replaceText,
    setNotice
  } = args
  const attachable = workspace !== undefined && !disabled
  const disabledRef = useRef(!attachable)
  useLayoutEffect(() => {
    disabledRef.current = !attachable
  }, [attachable])

  const input = useMemo<NativeChatComposerInput>(
    () => ({
      get value() {
        return editor.current?.getValue() ?? ''
      },
      get selectionStart() {
        return editor.current?.selection().from ?? 0
      },
      get selectionEnd() {
        return editor.current?.selection().to ?? 0
      },
      get disabled() {
        return disabledRef.current
      },
      focus: () => editor.current?.focus(),
      select: () => {},
      setSelectionRange: () => {},
      contains: (node) => editor.current?.containsNode(node) ?? false,
      insertText: (text) => editor.current?.insertText(text),
      insertFileReferences: (paths) => {
        for (const path of paths) {
          // a pill is one whitespace-free token, so a spaced path keeps its quoted text form
          if (hasWhitespace(path)) {
            editor.current?.insertText(`${formatNativeChatFileReference(path)} `)
          } else {
            editor.current?.insertPill({ kind: 'file', path })
          }
        }
      }
    }),
    [editor]
  )
  const inputRef = useRef<NativeChatComposerInput | null>(input)

  const noWorkspace = workspace === undefined
  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    allowWithoutTarget: mode === 'chat',
    acceptsImages,
    caret: 0,
    disabled: !attachable,
    isComposing: ime.isComposing,
    resolveTarget: workspace?.resolveTarget ?? (() => null),
    textareaRef: inputRef,
    setCaret: () => {},
    setDraft: (updater) => replaceText(updater(editor.current?.getValue() ?? '')),
    setNotice
  })
  const { pickAttachments, attachExternalPaths, captureCopiedFiles, resolveAttachmentOwner } =
    useNativeChatFileDrops({
      paneKey: workspace?.paneKey ?? scopeKey,
      draftScopeKey: scopeKey,
      targetPtyId: workspace?.targetPtyId ?? null,
      terminalTabId: workspace?.terminalTabId ?? NO_TAB,
      ...(workspace?.worktreeId === undefined
        ? {}
        : { structuredWorktreeId: workspace.worktreeId }),
      ...(workspace?.structuredSession === undefined
        ? {}
        : { structuredSession: workspace.structuredSession }),
      disabled: !attachable,
      attachResolvedPaths: attachments.attachResolvedPaths,
      pendingChips: attachments.pendingChips,
      setNotice
    })
  const { handlePaste } = useNativeChatComposerPaste({
    targetKey: JSON.stringify([scopeKey, workspace?.paneKey, workspace?.targetPtyId]),
    attachmentScopeKey: scopeKey,
    ...(workspace === undefined ? {} : { agent: workspace.agent }),
    disabled: !attachable,
    caret: 0,
    resolveAttachmentOwner,
    attachResolvedPaths: attachments.attachResolvedPaths,
    attachCopiedFiles: attachExternalPaths,
    captureCopiedFiles,
    beginPendingImageAttachment: attachments.beginPendingImageAttachment,
    resolvePendingImageAttachment: attachments.pendingChips.resolve,
    revealPendingImageAttachment: attachments.revealPendingImageAttachment,
    dropPendingImageAttachment: attachments.dropPendingImageAttachment,
    insertTypedText: (text) => {
      if (disabledRef.current || !editor.current) {
        return false
      }
      editor.current.focus()
      editor.current.insertText(text)
      return true
    },
    setCaret: () => {},
    setNotice
  })

  const takePaste = useCallback(
    (event: ClipboardEvent): boolean => {
      if (noWorkspace) {
        return false
      }
      if (clipboardEventCopiedFilePaths(event).length === 0 && !clipboardEventImageFile(event)) {
        return false
      }
      handlePaste(event)
      return true
    },
    [handlePaste, noWorkspace]
  )

  return {
    images: attachments.imageAttachments,
    removeImage: attachments.removeImageAttachment,
    pickAttachments,
    takePaste,
    flushPendingAttachments: attachments.flushPendingAttachments
  }
}
