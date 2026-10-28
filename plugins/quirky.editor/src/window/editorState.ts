import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo, ExplorerInteraction } from '../types'

export type EditorTab = { tabId: string; bufferId: string; mode: 'edit' | 'preview'; group?: string }
export type ExplorerState = { worktreeId: string; showDotfiles: boolean; expanded: string[] } & Partial<ExplorerInteraction>
export type EditorSearchState = {
  worktreeId: string
  query: string
  loading: boolean
  error: string | null
  results: unknown[]
  totalMatches: number
  truncated: boolean
}
export type EditorState = {
  buffers: EditorBufferInfo[]
  tabs: EditorTab[]
  explorer: ExplorerState
  search: EditorSearchState | null
  quickOpenHistory: { worktreeId: string; paths: string[] }[]
  closeRequests: { bufferId: string; tabId: string; dirty: boolean }[]
}

function editorStateFrom(value: unknown): EditorState {
  if (typeof value !== 'object' || value === null || !('buffers' in value) || !Array.isArray(value.buffers) || !('tabs' in value) || !Array.isArray(value.tabs)) {
    throw new Error('Editor state response is malformed.')
  }
  return value as EditorState
}

export function worktreeFromLayout(context: UiPluginContext): string | undefined {
  const input = context.getLayout().view?.input
  if (typeof input !== 'object' || input === null || !('worktree' in input)) return undefined
  const worktree = input.worktree
  return typeof worktree === 'string' && worktree !== '' ? worktree : undefined
}

export function useEditorState(context: UiPluginContext, selector?: { worktree?: string; bufferId?: string }) {
  const [state, setState] = useState<EditorState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)

  const refresh = useCallback(() => {
    const request = ++sequence.current
    context.call('quirky.editor/state', selector ?? {}).then((value) => {
      if (request !== sequence.current) return
      setState(editorStateFrom(value))
      setError(null)
    }).catch((reason: unknown) => {
      if (request !== sequence.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [context, selector?.bufferId, selector?.worktree])

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.editor/changed') refresh()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') refresh()
    })
    refresh()
    return () => {
      sequence.current += 1
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, refresh])

  return { state, error, refresh }
}
