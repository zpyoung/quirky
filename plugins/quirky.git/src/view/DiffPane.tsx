import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@quirky/ui'
import type { GitDiff, UiPluginContext } from '@quirky/protocol'

import type { NotesBinding } from '../notes/binding'
import { markComposerUsed, registerComposer, type NoteComposer } from '../notes/composers'
import type { Note } from '../notes/useNotes'
import { messageOf, reasonOf } from './data'
import { BinaryNotice, ImagePanes, NoChangesNotice, TooLargeNotice } from './Fallbacks'
import { tooLargeFor, type TooLarge } from './limits'
import { createMerge, type MergeHandle } from './merge'
import type { DiffSettings } from './settings'

/** How long after an edit the draft is measured against the display limits. */
export const RECOUNT_MS = 300

export type PaneState = { changes: number; current: number | null; dirty: boolean; stale: boolean; tooLarge: boolean }

/** What a pane's owner can do to it. */
export type PaneHandle = {
  nextChange(): boolean
  previousChange(): boolean
  goToChange(n: number): boolean
  currentChange(): number | null
  changeCount(): number
  revertChange(): boolean
  save(): Promise<void>
  isDirty(): boolean
  reload(): Promise<void>
  overwrite(): Promise<void>
  /** The current modified-side draft, whether or not it has been saved. */
  modifiedText(): string
  /** The file changed on disk under an unsaved draft. */
  markStale(): void
}

export type PaneProps = {
  context: UiPluginContext
  worktree: string
  /** The path notes are filed under. */
  path: string
  diff: GitDiff
  editable: boolean
  settings: DiffSettings
  /** The stale bar's wording: a single file's, or a combined section's. */
  variant: 'file' | 'section'
  onState?(state: PaneState): void
  bind?(handle: PaneHandle | null): void
  /** A save wrote `content`; the owner updates the diff it holds without rebuilding the pane. */
  onSaved(content: string, hash: string): void
  /** Refetch the diff and replace this pane with it, dropping the draft. */
  onReload(): Promise<void>
  onFocus?(): void
  /** Draws and takes notes on the modified side of a text diff; image, binary and too-large diffs never use it. */
  notes?: NotesBinding
  /**
   * Offers Revert on each change of a text diff whose modified side is the file on disk: a press
   * asks for confirmation, puts the change back in the editor and saves the file at once with the
   * hash the diff was read at. A refused save puts the editor back and says so. With unsaved edits
   * in an editable pane a press undoes the change in the draft only, without asking or saving.
   */
  revertOnDisk?: boolean
}

const STALE_TEXT = {
  file: 'This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.',
  section: 'This file changed on disk since your edits.'
} as const

/** The banner for a file that changed on disk under unsaved edits, with the two ways out. */
export function StaleBar({ variant, onReload, onOverwrite }: { variant: 'file' | 'section'; onReload(): void; onOverwrite(): void }) {
  return (
    <div className="ui-cluster" role="alert" style={{ padding: 'var(--ui-space-8)' }}>
      <span>{STALE_TEXT[variant]}</span>
      <Button onClick={onReload}>Reload from Disk</Button>
      <Button variant="destructive" onClick={onOverwrite}>Overwrite</Button>
    </div>
  )
}

const NONE: PaneState = { changes: 0, current: null, dirty: false, stale: false, tooLarge: false }

/**
 * One file's diff in whichever form its content allows: the merge editor for text, image panes,
 * the binary notice, or the large-diff fallback. Remount it (change its key) to load new content.
 */
export function DiffPane(props: PaneProps) {
  const { diff, onState, bind } = props
  const text = diff.kind === 'text' && !diff.binary && diff.tooLarge === undefined
  useEffect(() => {
    if (text) return
    bind?.(null)
    onState?.({ ...NONE, tooLarge: diff.tooLarge !== undefined })
  }, [text, diff.tooLarge, bind, onState])
  if (diff.kind === 'image') return <ImagePanes diff={diff} />
  if (diff.kind === 'binary' || diff.binary) return <BinaryNotice />
  if (diff.tooLarge) return <TooLargeNotice tooLarge={diff.tooLarge} />
  if (diff.original === diff.modified) {
    return (
      <>
        <NoChangesNotice />
        <TextPane {...props} />
      </>
    )
  }
  return <TextPane {...props} />
}

const NO_NOTES: readonly Note[] = []

function TextPane({ context, worktree, path, diff, editable, settings, variant, onState, bind, onSaved, onReload, onFocus, notes, revertOnDisk }: PaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mergeRef = useRef<MergeHandle | null>(null)
  const base = useRef<{ text: string; hash: string | null | undefined }>({ text: diff.modified, hash: diff.modifiedHash })
  const carried = useRef<string | null>(null)
  const draft = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [view, setView] = useState<{ changes: number; current: number | null }>({ changes: 0, current: null })
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState(false)
  const [overflow, setOverflow] = useState<TooLarge | null>(null)
  const latest = useRef({ onFocus })
  latest.current = { onFocus }
  const binding = useRef(notes)
  binding.current = notes
  const withNotes = notes !== undefined
  const fileNotes = useMemo(() => (notes ? notes.notes.filter((n) => n.path === path) : NO_NOTES), [notes?.notes, path])
  const model = useMemo(() => ({ saved: fileNotes, draft: notes?.draft ?? null }), [fileNotes, notes?.draft])
  const modelRef = useRef(model)
  modelRef.current = model

  const measure = () => {
    const merge = mergeRef.current
    if (merge) setView({ changes: merge.changeCount(), current: merge.currentChange() })
  }

  const recount = () => {
    timer.current = null
    const merge = mergeRef.current
    if (!merge) return
    const current = merge.getModified()
    dirtyRef.current = current !== base.current.text
    setDirty(dirtyRef.current)
    const big = tooLargeFor(diff.original, current)
    if (big) {
      draft.current = current
      setOverflow(big)
    }
  }

  const write = async (content: string, force: boolean) => {
    const { hash } = base.current
    const result = (await context.call('quirky.git/save', {
      worktree,
      path: diff.path,
      content,
      ...(!force && hash !== undefined ? { expected: hash } : {})
    })) as { hash: string }
    base.current = { text: content, hash: result.hash }
    const now = mergeRef.current?.getModified() ?? draft.current ?? content
    dirtyRef.current = now !== content
    setDirty(dirtyRef.current)
    setStale(false)
    onSaved(content, result.hash)
  }

  const save = async (force: boolean) => {
    const content = overflow ? draft.current : (mergeRef.current?.getModified() ?? null)
    if (content === null) return
    try {
      await write(content, force)
    } catch (error) {
      if (reasonOf(error) === 'changed-on-disk') setStale(true)
      else context.toast('Save failed', messageOf(error))
    }
  }

  const reverting = useRef(false)
  const ownEdit = useRef(false)
  /** Runs `change` on the editor without it counting as the user's edit. */
  const silently = <T,>(change: () => T): T => {
    ownEdit.current = true
    try {
      return change()
    } finally {
      ownEdit.current = false
    }
  }
  /**
   * Runs `apply` on the editor. With unsaved edits that is all it does, so the change reaches disk
   * with the next save. Otherwise it confirms first and saves the result at once; a refused save
   * restores the editor unless the user typed meanwhile, in which case their text and the
   * reverted change stay in the draft.
   */
  const revert = async (apply: () => boolean) => {
    const merge = mergeRef.current
    if (reverting.current || !merge) return
    if (dirtyRef.current) {
      apply()
      return
    }
    reverting.current = true
    try {
      const confirmed = await context.confirm({
        title: 'Revert this change?',
        body: `The change is undone in ${path} on disk.`,
        confirmLabel: 'Revert'
      })
      if (!confirmed || mergeRef.current !== merge) return
      if (dirtyRef.current) {
        apply()
        return
      }
      const before = merge.getModified()
      if (!silently(apply)) return
      const reverted = merge.getModified()
      try {
        await write(reverted, false)
      } catch (error) {
        if (mergeRef.current === merge) {
          if (merge.getModified() === reverted) {
            silently(() => merge.setModified(before))
            dirtyRef.current = false
          } else {
            dirtyRef.current = true
          }
          setDirty(dirtyRef.current)
        }
        context.toast('Revert failed', messageOf(error))
      }
    } finally {
      reverting.current = false
    }
  }

  const ifDirty = (force: boolean) => () => (dirtyRef.current ? save(force) : Promise.resolve())
  const actions = useRef({ save: ifDirty(false), overwrite: ifDirty(true), reload: onReload, revert })
  actions.current = { save: ifDirty(false), overwrite: ifDirty(true), reload: onReload, revert }
  const canRevert = revertOnDisk === true && diff.modifiedDeleted !== true && typeof diff.modifiedHash === 'string'

  const showEditor = overflow === null
  useEffect(() => {
    const host = hostRef.current
    if (!host || !showEditor) return
    const handle = createMerge(host, {
      original: diff.original,
      modified: carried.current ?? base.current.text,
      path: diff.path,
      sideBySide: settings.sideBySide,
      wrap: settings.wrap,
      showWhitespace: settings.showWhitespace,
      collapseUnchanged: settings.collapseUnchanged,
      editable,
      ...(canRevert ? { onRevert: (apply: () => boolean) => void actions.current.revert(apply) } : {}),
      scrollToFirst: variant === 'file',
      onSave: () => void actions.current.save(),
      onDocChange: () => {
        if (ownEdit.current) return
        dirtyRef.current = true
        setDirty(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(recount, RECOUNT_MS)
      },
      onUpdate: measure,
      onFocus: () => latest.current.onFocus?.(),
      ...(withNotes
        ? {
            notes: {
              initial: modelRef.current,
              mountCard: (element, card, remeasure) => binding.current!.mountCard(path, element, card, remeasure),
              onRange: (range) => binding.current?.openDraft(range)
            }
          }
        : {})
    })
    carried.current = null
    mergeRef.current = handle
    measure()

    const composer: NoteComposer = {
      openFromSelection() {
        const owner = binding.current
        if (!owner || owner.draft) return false
        owner.openDraft(handle.selectionRange())
        return true
      }
    }
    const unregister = withNotes ? registerComposer(composer) : undefined
    const used = () => markComposerUsed(composer)
    host.addEventListener('focusin', used)
    host.addEventListener('pointerdown', used)
    return () => {
      host.removeEventListener('focusin', used)
      host.removeEventListener('pointerdown', used)
      unregister?.()
      carried.current = editable && dirtyRef.current ? handle.getModified() : null
      mergeRef.current = null
      handle.destroy()
    }
  }, [showEditor, editable, canRevert, variant, withNotes, path, settings.sideBySide, settings.wrap, settings.showWhitespace, settings.collapseUnchanged])

  useEffect(() => {
    mergeRef.current?.setNotes(model)
  }, [model])

  const revealId = notes?.reveal
  useEffect(() => {
    if (!revealId || !fileNotes.some((n) => n.id === revealId)) return
    if (mergeRef.current?.revealNote(revealId)) binding.current?.revealed()
  }, [revealId, fileNotes, showEditor])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  const canRevertRef = useRef(canRevert)
  canRevertRef.current = canRevert
  const handleRef = useRef<PaneHandle | null>(null)
  if (handleRef.current === null) {
    handleRef.current = {
      nextChange: () => mergeRef.current?.nextChange() ?? false,
      previousChange: () => mergeRef.current?.previousChange() ?? false,
      goToChange: (n) => mergeRef.current?.goToChange(n) ?? false,
      currentChange: () => mergeRef.current?.currentChange() ?? null,
      changeCount: () => mergeRef.current?.changeCount() ?? 0,
      revertChange: () => (editable || canRevertRef.current ? (mergeRef.current?.revertChange() ?? false) : false),
      isDirty: () => dirtyRef.current,
      save: () => actions.current.save(),
      reload: () => reload(),
      overwrite: () => actions.current.overwrite(),
      modifiedText: () => draft.current ?? mergeRef.current?.getModified() ?? base.current.text,
      markStale: () => setStale(true)
    }
  }
  const reload = async () => {
    try {
      await actions.current.reload()
    } catch (error) {
      context.toast('Reload failed', messageOf(error))
    }
  }
  useEffect(() => {
    bind?.(handleRef.current)
    return () => bind?.(null)
  }, [bind])

  const changes = overflow ? 0 : view.changes
  const current = overflow ? null : view.current
  useEffect(() => {
    onState?.({ changes, current, dirty, stale, tooLarge: overflow !== null })
  }, [changes, current, dirty, stale, overflow, onState])

  return (
    <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      {stale && (
        <StaleBar variant={variant} onReload={() => void reload()} onOverwrite={() => void actions.current.overwrite()} />
      )}
      {overflow ? (
        <div className="ui-stack" role="region" aria-label="This diff is too large to display safely." style={{ padding: 'var(--ui-space-12)' }}>
          <TooLargeNotice tooLarge={overflow} />
          <p>This draft crossed the safe display limit, but it can still be saved.</p>
          <Button variant="primary" disabled={!dirty} onClick={() => void save(false)}>
            Save
          </Button>
        </div>
      ) : (
        <div data-diff-editor ref={hostRef} style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }} />
      )}
    </div>
  )
}
