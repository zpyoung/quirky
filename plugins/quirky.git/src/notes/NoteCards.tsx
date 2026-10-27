import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { rangeLabel } from './line-range'
import type { NoteDraft } from './extension'
import type { Note } from './useNotes'

const MIN_TEXT_PX = 60
const MAX_TEXT_PX = 240
const SCAN_MAX_BYTES = 64 * 1024

/** Grows the textarea with its content between 60 and 240 px; true when the height changed. */
function fit(area: HTMLTextAreaElement): boolean {
  const before = area.style.height
  area.style.height = 'auto'
  area.style.height = `${Math.min(Math.max(area.scrollHeight, MIN_TEXT_PX), MAX_TEXT_PX)}px`
  return area.style.height !== before
}

/**
 * Whether `text` has a visible character, looking at no more than 64 KiB of it: a body that is
 * blank for that long is refused as too large, so a pasted wall of whitespace cannot stall the card.
 */
function bodyState(text: string): 'empty' | 'ready' | 'too-large' {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes > SCAN_MAX_BYTES) return 'too-large'
    if (/\S/u.test(char)) return 'ready'
  }
  return 'empty'
}

const canSubmitText = (text: string): boolean => bodyState(text) === 'ready'

/** Keeps a React state update from running after the card was unmounted by the editor. */
function useAlive(): { current: boolean } {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return alive
}

/** Tells the editor when the card changed size, so the block it sits in is measured again. */
function useRemeasure(remeasure: () => void): React.RefObject<HTMLDivElement | null> {
  const card = useRef<HTMLDivElement>(null)
  const latest = useRef(remeasure)
  latest.current = remeasure
  useLayoutEffect(() => {
    const element = card.current
    latest.current()
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => latest.current())
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return card
}

type DraftProps = {
  draft: NoteDraft
  onBodyChange(text: string): void
  onCancel(): void
  /** Resolves false when the note was not saved, which keeps the draft open. */
  onSubmit(body: string): Promise<boolean>
  /** The text has nothing visible within the first 64 KiB. */
  onTooLarge(): void
  remeasure(): void
}

/**
 * The card a new note is written in: "Line N" or "Lines S-E", a textarea that grows from 60 to
 * 240 px, and Cancel / Add note. Escape cancels; Enter and Mod+Enter save; Shift+Enter and an
 * Enter that confirms an input method's composition do not. A press outside cancels only an
 * empty draft, so a half-written note survives a click on another line's "+".
 */
export function DraftCard({ draft, onBodyChange, onCancel, onSubmit, onTooLarge, remeasure }: DraftProps) {
  const [body, setBody] = useState(draft.body)
  const [submitting, setSubmitting] = useState(false)
  const alive = useAlive()
  const card = useRemeasure(remeasure)
  const area = useRef<HTMLTextAreaElement>(null)
  const latest = useRef({ body, onCancel })
  latest.current = { body, onCancel }
  const labelId = useId()

  useLayoutEffect(() => {
    if (area.current) fit(area.current)
    area.current?.focus()
  }, [])

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target
      if (!card.current || (target instanceof Node && card.current.contains(target))) return
      if (/\S/u.test(latest.current.body)) return
      latest.current.onCancel()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [card])

  const submit = async () => {
    if (submitting) return
    const state = bodyState(body)
    if (state === 'empty') return
    if (state === 'too-large') return onTooLarge()
    area.current?.focus()
    setSubmitting(true)
    const saved = await onSubmit(body.trim())
    if (!saved && alive.current) setSubmitting(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // keys typed here belong to the card, not to the window's shortcuts
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!submitting) onCancel()
      return
    }
    const composing = event.nativeEvent.isComposing || event.keyCode === 229
    if (event.key === 'Enter' && !composing && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div ref={card} className="qgv-note-box qgv-note-draft" role="region" aria-labelledby={labelId}>
      <div id={labelId} className="qgv-note-title">
        {rangeLabel(draft)}
      </div>
      <textarea
        ref={area}
        className="qgv-note-input"
        placeholder="Add note for the AI"
        aria-label="Note"
        rows={3}
        value={body}
        onChange={(event) => {
          setBody(event.target.value)
          onBodyChange(event.target.value)
          if (fit(event.currentTarget)) remeasure()
        }}
        onKeyDown={onKeyDown}
      />
      <div className="qgv-note-footer">
        <button type="button" className="qgv-note-ghost" disabled={submitting} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="qgv-note-primary" disabled={submitting || !canSubmitText(body)} aria-label="Add note" onClick={() => void submit()}>
          {submitting ? 'Adding...' : 'Add note'}
        </button>
      </div>
    </div>
  )
}

type SavedProps = {
  note: Note
  /** The card's send menu. */
  send: ReactNode
  /** Resolves false when the edit was not saved, which keeps the editor open. */
  onEdit(body: string): Promise<boolean>
  onDelete(): void
  remeasure(): void
}

const icon = { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/**
 * A saved note: "Note line N" over its text, with the send menu, Edit note and Delete note. Edit
 * note opens the text for change: Enter saves, Shift+Enter adds a line break, Escape and Cancel
 * leave it as it was, and Save is enabled only for a non-empty text that differs. Delete note
 * deletes at once.
 */
export function SavedCard({ note, send, onEdit, onDelete, remeasure }: SavedProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [saving, setSaving] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const alive = useAlive()
  const card = useRemeasure(remeasure)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setShown(null), [note.body])
  useLayoutEffect(() => {
    if (!editing || !area.current) return
    fit(area.current)
    area.current.focus()
    area.current.setSelectionRange(area.current.value.length, area.current.value.length)
    remeasure()
  }, [editing])

  const trimmed = draft.trim()
  const canSave = !saving && trimmed !== '' && trimmed !== note.body

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    const saved = await onEdit(trimmed)
    if (!alive.current) return
    setSaving(false)
    if (saved) {
      setShown(trimmed)
      setEditing(false)
    }
  }

  const cancel = () => {
    setEditing(false)
    setDraft(note.body)
  }

  const label = `Note ${rangeLabel(note).toLowerCase()}`
  return (
    <div ref={card} className="qgv-note-box qgv-note-card">
      <div className="qgv-note-head">
        <span className="qgv-note-meta">{label}</span>
        {!editing && (
          <span className="qgv-note-actions">
            {send}
            <button
              type="button"
              className="qgv-note-action"
              aria-label="Edit note"
              title="Edit note"
              onClick={() => {
                setDraft(shown ?? note.body)
                setEditing(true)
              }}
            >
              <svg {...icon}>
                <path d="M2.5 13.5 3 10.2l7.4-7.4a1.4 1.4 0 0 1 2 2L5 12.2z" />
              </svg>
            </button>
            <button type="button" className="qgv-note-action qgv-note-danger" aria-label="Delete note" title="Delete note" onClick={onDelete}>
              <svg {...icon}>
                <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
              </svg>
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            ref={area}
            className="qgv-note-input"
            aria-label="Edit note text"
            rows={3}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              if (fit(event.currentTarget)) remeasure()
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.shiftKey) {
                event.preventDefault()
                void save()
              }
            }}
          />
          <div className="qgv-note-footer">
            <button type="button" className="qgv-note-ghost" disabled={saving} onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="qgv-note-primary" disabled={!canSave} onClick={() => void save()}>
              Save
            </button>
          </div>
        </>
      ) : (
        <div className="qgv-note-body">{shown ?? note.body}</div>
      )}
    </div>
  )
}
