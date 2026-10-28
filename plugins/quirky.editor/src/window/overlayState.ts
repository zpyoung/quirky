import { useSyncExternalStore } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { activeDocument } from './activeDocument'
import type { EditorState } from './editorState'

export type QuickOpenPurpose = 'files' | 'markdown-open' | 'markdown-new'
export type QuickOpenRequest = { id: number; context: UiPluginContext; worktree?: string; group?: string; query: string; purpose: QuickOpenPurpose }
export type CloseTarget = { bufferId: string; tabId: string; name: string; dirty: boolean; mode: 'edit' | 'preview' }
export type CloseRequest = {
  id: number
  context: UiPluginContext
  kind: 'single' | 'all'
  targets: CloseTarget[]
  resolve(value: boolean): void
  error: string | null
}

type CloseResult = { closed: boolean; needsDecision?: boolean }
let nextRequestId = 0
let quickOpen: QuickOpenRequest | null = null
let closeRequest: CloseRequest | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function useQuickOpenRequest(): QuickOpenRequest | null {
  return useSyncExternalStore(subscribe, () => quickOpen, () => null)
}

export function useCloseRequest(): CloseRequest | null {
  return useSyncExternalStore(subscribe, () => closeRequest, () => null)
}

export function showQuickOpen(context: UiPluginContext, worktree?: string, query = '', purpose: QuickOpenPurpose = 'files', group?: string): void {
  quickOpen = { id: ++nextRequestId, context, worktree, group, query, purpose }
  notify()
}

export function showMarkdownOpen(context: UiPluginContext, worktree?: string, group?: string): void {
  showQuickOpen(context, worktree, '', 'markdown-open', group)
}

export function showNewMarkdown(context: UiPluginContext, worktree?: string, group?: string): void {
  showQuickOpen(context, worktree, '', 'markdown-new', group)
}

export function dismissQuickOpen(id?: number): void {
  if (id !== undefined && quickOpen?.id !== id) return
  quickOpen = null
  notify()
}

function showCloseRequest(context: UiPluginContext, kind: 'single' | 'all', targets: CloseTarget[]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  closeRequest = { id: ++nextRequestId, context, kind, targets, resolve, error: null }
  notify()
  return promise
}

export function updateCloseError(id: number, error: string | null): void {
  if (!closeRequest || closeRequest.id !== id) return
  closeRequest = { ...closeRequest, error }
  notify()
}

export function finishCloseRequest(id: number, result: boolean): void {
  const request = closeRequest
  if (!request || request.id !== id) return
  closeRequest = null
  notify()
  request.resolve(result)
}

export async function requestSingleClose(context: UiPluginContext, bufferId: string, tabId?: string): Promise<boolean> {
  const active = activeDocument()
  try {
    if (active?.bufferId === bufferId) await active.flush()
    const params = { bufferId, ...(tabId ? { tabId } : {}) }
    const result = await context.call('quirky.editor/close', params) as CloseResult
    if (result.closed) return true
    if (!result.needsDecision) return false
    const state = await context.call('quirky.editor/state', { bufferId }) as EditorState
    const buffer = state.buffers.find((entry) => entry.id === bufferId)
    return showCloseRequest(context, 'single', [{ bufferId, tabId: tabId ?? buffer?.tabId ?? '', name: buffer?.name ?? 'file', dirty: buffer?.dirty === true, mode: 'edit' }])
  } catch (reason) {
    context.toast('Unable to close file', messageOf(reason))
    return false
  }
}

export async function requestCloseAll(context: UiPluginContext, worktree?: string): Promise<boolean> {
  try {
    const active = activeDocument()
    if (active) await active.flush()
    const state = await context.call('quirky.editor/state', worktree ? { worktree } : {}) as EditorState
    const buffers = new Map(state.buffers.map((buffer) => [buffer.id, buffer]))
    const targets = state.tabs.map((tab) => {
      const buffer = buffers.get(tab.bufferId)
      return {
        bufferId: tab.bufferId,
        tabId: tab.tabId,
        name: buffer?.name ?? buffer?.relativePath ?? 'file',
        dirty: tab.mode === 'edit' && buffer?.dirty === true,
        mode: tab.mode
      }
    })
    if (targets.length === 0) return true
    if (targets.some((target) => target.dirty)) return showCloseRequest(context, 'all', targets)
    const canClose = await Promise.all(targets.map((target) => context.call('quirky.editor/canClose', { bufferId: target.bufferId, tabId: target.tabId })))
    for (let index = 0; index < canClose.length; index++) {
      if (canClose[index] === false) targets[index]!.dirty = true
    }
    if (targets.some((target) => target.dirty)) return showCloseRequest(context, 'all', targets)
    for (const target of targets) await context.call('quirky.editor/close', { bufferId: target.bufferId, tabId: target.tabId })
    return true
  } catch (reason) {
    context.toast('Unable to close editor tabs', messageOf(reason))
    return false
  }
}

export function clearOverlayRequests(): void {
  quickOpen = null
  if (closeRequest) {
    const request = closeRequest
    closeRequest = null
    request.resolve(false)
  }
  notify()
}
