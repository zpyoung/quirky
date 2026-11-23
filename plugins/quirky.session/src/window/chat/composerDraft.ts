import { useEffect, useRef } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { Draft } from '../../drafts'
import { NO_PICKS } from './controls'

/** An attached image; `preview` is an object URL for a thumbnail when the composer holds the image's bytes. */
export type Attachment = { name: string; path: string; preview?: string }
export type PasteChip = { id: string; text: string }

const SAVE_DELAY_MS = 400
const LONG_PASTE_NOTE = 'Pasted text'

export const EMPTY_DRAFT: Draft = { text: '', images: [], pastes: [], picks: NO_PICKS }

const keyOf = (draft: Draft) => JSON.stringify(draft)
/** Whether `draft` holds nothing worth saving. */
export const isEmptyDraft = (draft: Draft) => keyOf(draft) === keyOf(EMPTY_DRAFT)

/** A stored draft, with picks saved before Plan became a mode (a `plan` flag) folded into `mode`. */
const asDraft = (value: unknown): Draft | null => {
  const draft = value as Partial<Draft> | null
  if (typeof draft !== 'object' || draft === null || typeof draft.text !== 'string' || !Array.isArray(draft.images) || !Array.isArray(draft.pastes)) return null
  if (typeof draft.picks !== 'object' || draft.picks === null) return null
  const { plan, ...picks } = draft.picks as Draft['picks'] & { plan?: boolean }
  return { ...(draft as Draft), picks: plan === true ? { ...picks, mode: 'plan' } : picks }
}

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The typed message exactly as typed, with each long-paste chip's text after it, separated by blank lines. */
export function composeMessage(text: string, pastes: PasteChip[]): string {
  const typed = pastes.length > 0 || text.trim() !== '' ? text : ''
  return [typed, ...pastes.map((paste) => paste.text)].filter((part) => part !== '').join('\n\n')
}

export function pasteLabel(text: string): string {
  const lines = text.split('\n').length
  return `${LONG_PASTE_NOTE} · ${lines} ${lines === 1 ? 'line' : 'lines'}`
}

/** `path` relative to `root` when it lies inside it, else `path` unchanged. */
export function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** Base64 of the file's bytes, in chunks so a large screenshot does not overflow the call stack. */
export async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export type DraftSync = {
  /** Deletes the stored draft after a successful send. */
  cleared(): void
}

/**
 * Keeps the session's stored draft in step with `draft`: loads it when the session changes, saves
 * changes after a short pause and again when the composer leaves the session.
 */
export function useDraftSync(context: UiPluginContext, session: string, draft: Draft, restore: (draft: Draft | null) => void): DraftSync {
  const latest = useRef(draft)
  latest.current = draft
  const onRestore = useRef(restore)
  onRestore.current = restore
  const saved = useRef(keyOf(EMPTY_DRAFT))
  const ready = useRef(false)
  const edited = useRef(false)
  const origin = useRef(keyOf(EMPTY_DRAFT))
  const generation = useRef(0)
  const inFlight = useRef(false)

  const persist = (target: string, next: Draft, leaving = false) => {
    const key = keyOf(next)
    if (key === saved.current) return
    // one save at a time so a stale response cannot land after a newer one
    if (inFlight.current && !leaving) return
    const mine = generation.current
    inFlight.current = true
    const call = isEmptyDraft(next)
      ? context.call('quirky.session/clearDraft', { session: target })
      : context.call('quirky.session/saveDraft', { session: target, draft: next })
    // a failed call leaves the draft dirty so the next save retries it
    const settled = (ok: boolean) => {
      inFlight.current = false
      if (mine !== generation.current) return
      if (ok) saved.current = key
      // a failed save is retried only once the draft has moved on, so a dead backend cannot loop
      const moved = keyOf(latest.current) !== key
      if (ready.current && (ok || moved) && keyOf(latest.current) !== saved.current) persist(target, latest.current)
    }
    call.then(
      () => settled(true),
      () => settled(false)
    )
  }

  useEffect(() => {
    let cancelled = false
    ready.current = false
    generation.current++
    inFlight.current = false
    edited.current = false
    origin.current = keyOf(latest.current)
    saved.current = keyOf(EMPTY_DRAFT)
    onRestore.current(null)
    context
      .call('quirky.session/draft', { session })
      .then((loaded) => {
        if (cancelled) return
        const found = asDraft(loaded)
        saved.current = keyOf(found ?? EMPTY_DRAFT)
        ready.current = true
        if (edited.current) persist(session, latest.current)
        else if (found) onRestore.current(found)
      })
      .catch(() => {
        if (!cancelled) ready.current = true
      })
    return () => {
      cancelled = true
      if (ready.current) persist(session, latest.current, true)
    }
  }, [context, session])

  const key = keyOf(draft)
  useEffect(() => {
    if (key !== origin.current && key !== keyOf(EMPTY_DRAFT)) edited.current = true
  }, [key])
  useEffect(() => {
    if (!ready.current) return
    const timer = setTimeout(() => persist(session, latest.current), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [context, session, key])

  return {
    cleared() {
      edited.current = true
      saved.current = keyOf({ ...EMPTY_DRAFT, picks: latest.current.picks })
      context.call('quirky.session/clearDraft', { session }).catch(() => {})
    }
  }
}
