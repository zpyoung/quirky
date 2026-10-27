import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import type { GitConflictKind, GitOperation } from '@quirky/protocol'
import { conflictBlocks, conflictDecorations, type ConflictBlock } from './conflict-markers'
import { messageOf, POLL_MS, reasonOf, useRefreshTriggers } from './data'
import { StaleBar } from './DiffPane'
import { ErrorNotice } from './Fallbacks'
import { lineBreakExtension, shellTheme, syntaxExtensions } from './theme'
import type { ModeProps } from './types'

type ConflictFileResult = {
  path: string
  kind: GitConflictKind
  state: 'unresolved' | 'resolved_locally'
  content: string | null
  hash: string | null
  operation: GitOperation
}

const KIND_LABEL: Record<GitConflictKind, string> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  both_deleted: 'Both deleted',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them'
}

/**
 * One conflicted file in an editable editor: marker lines tinted and labelled, a banner with the
 * conflict's kind, an N / M counter with wrap-around Previous / Next conflict, and Mod+S to save
 * with the disk precondition.
 */
export function ConflictFile({ context, input, settings, report, bind, close }: ModeProps) {
  const path = input.path ?? ''
  const worktree = input.worktree
  const [file, setFile] = useState<{ result: ConflictFileResult; revision: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<ConflictBlock[]>([])
  const [current, setCurrent] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const fileRef = useRef<typeof file>(null)
  const base = useRef<{ text: string; hash: string | null }>({ text: '', hash: null })
  const carried = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const currentRef = useRef<number | null>(null)
  const blocksRef = useRef<ConflictBlock[]>([])
  const inFlight = useRef(false)

  const load = async (): Promise<ConflictFileResult> =>
    (await context.call('quirky.git/conflictFile', { worktree, path })) as ConflictFileResult

  const replace = (result: ConflictFileResult) => {
    base.current = { text: result.content ?? '', hash: result.hash }
    dirtyRef.current = false
    setDirty(false)
    setStale(false)
    const next = { result, revision: (fileRef.current?.revision ?? 0) + 1 }
    fileRef.current = next
    setFile(next)
  }

  const refresh = async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const fresh = await load()
      const previous = fileRef.current
      if (!previous) {
        replace(fresh)
        setError(null)
      } else if (fresh.hash !== base.current.hash) {
        if (dirtyRef.current) setStale(true)
        else replace(fresh)
      } else if (fresh.state !== previous.result.state || fresh.kind !== previous.result.kind) {
        const next = { ...previous, result: fresh }
        fileRef.current = next
        setFile(next)
      }
    } catch (e) {
      if (!fileRef.current) setError(messageOf(e))
    } finally {
      inFlight.current = false
    }
  }

  useEffect(() => {
    void refresh()
  }, [])
  useRefreshTriggers(context, () => void refresh(), POLL_MS)

  const publish = (view: EditorView) => {
    const found = conflictBlocks(view.state.sliceDoc())
    blocksRef.current = found
    setBlocks(found)
    const line = view.state.doc.lineAt(view.state.selection.main.head).number
    const inside = found.findIndex((block) => block.start <= line && line <= block.end)
    const next = inside !== -1 ? inside + 1 : found.length === 0 ? null : Math.min(currentRef.current ?? 1, found.length)
    currentRef.current = next
    setCurrent(next)
  }

  const goTo = (n: number) => {
    const view = viewRef.current
    const block = blocksRef.current[n - 1]
    if (!view || !block) return
    const at = view.state.doc.line(block.start).from
    view.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 24 }),
      userEvent: 'select.byConflict'
    })
    currentRef.current = n
    setCurrent(n)
  }

  const step = (direction: 1 | -1) => {
    const count = blocksRef.current.length
    if (count === 0) return
    const from = currentRef.current ?? (direction > 0 ? 0 : 1)
    goTo(((from - 1 + direction + count) % count) + 1)
  }

  const save = async (force: boolean) => {
    const view = viewRef.current
    if (!view || !dirtyRef.current) return
    const content = view.state.sliceDoc()
    try {
      const result = (await context.call('quirky.git/save', {
        worktree,
        path,
        content,
        ...(!force && base.current.hash !== null ? { expected: base.current.hash } : {})
      })) as { hash: string }
      base.current = { text: content, hash: result.hash }
      dirtyRef.current = view.state.sliceDoc() !== content
      setDirty(dirtyRef.current)
      setStale(false)
    } catch (e) {
      if (reasonOf(e) === 'changed-on-disk') setStale(true)
      else context.toast('Save failed', messageOf(e))
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const reload = async () => {
    try {
      replace(await load())
    } catch (e) {
      context.toast('Reload failed', messageOf(e))
    }
  }

  const editable = file !== null && file.result.content !== null
  useEffect(() => {
    const host = hostRef.current
    if (!host || !file || file.result.content === null) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: carried.current ?? base.current.text,
        extensions: [
          lineNumbers(),
          shellTheme,
          syntaxExtensions(path, host),
          lineBreakExtension(base.current.text),
          conflictDecorations(),
          ...(settings.wrap ? [EditorView.lineWrapping] : []),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                void saveRef.current(false)
                return true
              }
            }
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              dirtyRef.current = update.state.sliceDoc() !== base.current.text
              setDirty(dirtyRef.current)
            }
            if (update.docChanged || update.selectionSet) publish(update.view)
          })
        ]
      })
    })
    carried.current = null
    viewRef.current = view
    publish(view)
    if (blocksRef.current.length > 0) {
      currentRef.current = 1
      goTo(1)
    }
    return () => {
      carried.current = dirtyRef.current ? view.state.sliceDoc() : null
      viewRef.current = null
      view.destroy()
    }
  }, [file?.revision, file?.result.content === null, settings.wrap])

  bind({
    nextConflict: () => step(1),
    previousConflict: () => step(-1),
    save: () => save(false),
    reloadFromDisk: reload,
    overwrite: () => save(true)
  })

  const stateKey = JSON.stringify([blocks.length, current, dirty, stale])
  useEffect(() => {
    report({
      mode: 'conflict-file',
      source: null,
      path,
      area: null,
      commit: null,
      changes: 0,
      currentChange: null,
      dirty,
      stale,
      tooLarge: false,
      conflicts: blocks.length,
      currentConflict: current
    })
  }, [stateKey, path, report])

  const result = file?.result
  const kindHint = result && (result.kind === 'deleted_by_us' || result.kind === 'deleted_by_them')
  return (
    <div className="qgv-file">
      <header className="qgv-bar">
        <span className="qgv-title" title={path}>
          <span className="qgv-path">{path}</span>
          <span className="qgv-sub"> (conflict)</span>
        </span>
        <span className="qgv-spacer" />
        {editable && (
          <>
            <span className="qgv-counter">{blocks.length === 0 ? '0 / 0' : `${current ?? 1} / ${blocks.length}`}</span>
            <button
              type="button"
              aria-label="Previous conflict"
              title="Previous conflict"
              disabled={blocks.length === 0}
              onClick={() => step(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Next conflict"
              title="Next conflict"
              disabled={blocks.length === 0}
              onClick={() => step(1)}
            >
              ↓
            </button>
          </>
        )}
        <button type="button" aria-label="Close" title="Close" onClick={close}>
          ✕
        </button>
      </header>
      {result && (
        <div className="qgv-banner">
          <strong>
            {result.state === 'unresolved' ? 'Unresolved conflict' : 'Resolved locally conflict'} · {KIND_LABEL[result.kind]}
          </strong>
          {result.state === 'resolved_locally' && (
            <span className="qgv-muted">Session-local continuity state. Git is no longer reporting this file as unmerged.</span>
          )}
          {kindHint && <span>Decide whether to keep the file or accept deletion</span>}
        </div>
      )}
      {stale && <StaleBar variant="file" onReload={() => void reload()} onOverwrite={() => void save(true)} />}
      <div className="qgv-body">
        {error !== null && !file ? (
          <ErrorNotice message={error} subject="conflict file" />
        ) : !file ? (
          <p className="qgv-muted qgv-pad">Loading diff...</p>
        ) : result?.content === null ? (
          <p className="qgv-muted qgv-pad">No working-tree file is available to edit for this conflict.</p>
        ) : (
          <div className="qgv-host" ref={hostRef} />
        )}
      </div>
    </div>
  )
}
