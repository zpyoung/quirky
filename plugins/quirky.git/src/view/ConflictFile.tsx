import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import type { GitConflictKind, GitOperation, GitStatus } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import { Badge, Button, EmptyState, IconButton, InlineError, NoticeLine, SectionHeader } from '@quirky/ui'
import { editorTheme } from '@quirky/ui/editor-theme'

import { conflictBlocks, conflictDecorations, type ConflictBlock } from './conflict-markers'
import { messageOf, POLL_MS, reasonOf, useRefreshTriggers } from './data'
import { StaleBar } from './DiffPane'
import { lineBreakExtension, syntaxExtensions } from './theme'
import { requestViewControl, useViewControl, viewControlGeneration, viewTarget } from './view-control'
import type { ModeProps } from './types'

type ConflictFileResult = {
  path: string
  kind: GitConflictKind
  state: 'unresolved' | 'resolved_locally'
  content: string | null
  hash: string | null
  operation: GitOperation
}

type ConflictDraft = {
  text: string
  base: { text: string; hash: string | null }
  result: ConflictFileResult
  stale: boolean
}

const drafts = new Map<string, ConflictDraft>()

const KIND_LABEL: Record<GitConflictKind, string> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  both_deleted: 'Both deleted',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them'
}

const isModifyDelete = (kind: GitConflictKind): boolean => kind === 'deleted_by_us' || kind === 'deleted_by_them'
const noControlData = (data: Record<string, unknown> | undefined): boolean =>
  data === undefined || Object.keys(data).length === 0

/**
 * One conflicted file in an editable editor: marker lines tinted and labelled, a banner with the
 * conflict's kind, an N / M counter with wrap-around Previous / Next conflict, and Mod+S to save
 * with the disk precondition.
 */
export function ConflictFile({ context, input, settings, report, bind, close }: ModeProps) {
  const path = input.path ?? ''
  const worktree = input.worktree
  const [controlGeneration] = useState(viewControlGeneration)
  const controlTarget = viewTarget('conflict-file', {
    worktree,
    ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
    path
  })
  const draftKey = input.tabId ? JSON.stringify([worktree, input.tabId, path]) : null
  const restored = useRef(draftKey ? drafts.get(draftKey) : undefined).current
  const [file, setFile] = useState<{ result: ConflictFileResult; revision: number } | null>(
    restored ? { result: restored.result, revision: 1 } : null
  )
  const [error, setError] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<ConflictBlock[]>([])
  const [current, setCurrent] = useState<number | null>(null)
  const [dirty, setDirty] = useState(restored !== undefined)
  const [stale, setStale] = useState(restored?.stale ?? false)
  const [operationEnded, setOperationEnded] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const actionInFlight = useRef(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const fileRef = useRef<typeof file>(file)
  const base = useRef<{ text: string; hash: string | null }>(restored?.base ?? { text: '', hash: null })
  const carried = useRef<string | null>(restored?.text ?? null)
  const dirtyRef = useRef(restored !== undefined)
  const staleRef = useRef(stale)
  staleRef.current = stale
  const currentRef = useRef<number | null>(null)
  const blocksRef = useRef<ConflictBlock[]>([])
  const inFlight = useRef(false)
  const reloadInFlight = useRef(false)
  const operationEndedRef = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const load = async (): Promise<ConflictFileResult> =>
    (await context.call('quirky.git/conflictFile', { worktree, path })) as ConflictFileResult

  const replace = (result: ConflictFileResult) => {
    if (!active.current) return
    base.current = { text: result.content ?? '', hash: result.hash }
    dirtyRef.current = false
    setDirty(false)
    setStale(false)
    if (draftKey) drafts.delete(draftKey)
    const next = { result, revision: (fileRef.current?.revision ?? 0) + 1 }
    fileRef.current = next
    setFile(next)
  }

  const refresh = async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const fresh = await load()
      if (!active.current) return
      operationEndedRef.current = false
      setOperationEnded(false)
      setError(null)
      const previous = fileRef.current
      if (!previous) {
        replace(fresh)
      } else if (fresh.hash !== base.current.hash) {
        if (dirtyRef.current) setStale(true)
        else replace(fresh)
      } else if (fresh.state !== previous.result.state || fresh.kind !== previous.result.kind) {
        const next = { ...previous, result: fresh }
        fileRef.current = next
        setFile(next)
      }
    } catch (e) {
      if (!active.current) return
      const isNotFound = (e as { code?: number } | null)?.code === RpcErrorCode.NotFound
      const previous = fileRef.current
      let status: GitStatus | null = null
      if (previous || isNotFound) {
        try {
          status = (await context.call('quirky.git/status', { worktree })) as GitStatus
          if (!active.current) return
        } catch {
          if (!active.current) return
          // Keep the original read failure if current Git state is unavailable.
        }
      }
      const entry = status?.entries.find((candidate) => candidate.area === 'conflicts' && candidate.path === path)
      if (isNotFound && status?.operation === 'none' && !entry) {
        operationEndedRef.current = true
        setOperationEnded(true)
        setError(null)
      } else {
        setError(messageOf(e))
        if (status && (status.operation !== 'none' || entry)) {
          operationEndedRef.current = false
          setOperationEnded(false)
        }
        if (previous && entry?.conflict?.state === 'resolved_locally') {
          const next = {
            ...previous,
            result: { ...previous.result, kind: entry.conflict.kind, state: 'resolved_locally' as const }
          }
          fileRef.current = next
          setFile(next)
          if (isNotFound) setError(null)
        }
      }
    } finally {
      inFlight.current = false
    }
  }

  useEffect(() => {
    void refresh()
  }, [])
  useRefreshTriggers(context, () => void refresh(), POLL_MS, worktree)

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
    if (operationEndedRef.current || fileRef.current?.result.state !== 'unresolved') return
    const count = blocksRef.current.length
    if (count === 0) return
    const from = currentRef.current ?? (direction > 0 ? 0 : 1)
    goTo(((from - 1 + direction + count) % count) + 1)
  }

  const save = async (force: boolean): Promise<boolean> => {
    if (!active.current) return false
    const view = viewRef.current
    if (!view || !dirtyRef.current) return true
    const content = view.state.sliceDoc()
    try {
      const result = (await context.call('quirky.git/save', {
        worktree,
        path,
        content,
        ...(!force && base.current.hash !== null ? { expected: base.current.hash } : {})
      })) as { hash: string }
      if (!active.current) return false
      base.current = { text: content, hash: result.hash }
      dirtyRef.current = view.state.sliceDoc() !== content
      setDirty(dirtyRef.current)
      setStale(false)
      if (draftKey && !dirtyRef.current) drafts.delete(draftKey)
      return true
    } catch (e) {
      if (!active.current) return false
      if (reasonOf(e) === 'changed-on-disk') setStale(true)
      else context.toast('Save failed', messageOf(e), { kind: 'error' })
      return false
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const reload = async () => {
    if (reloadInFlight.current) return
    reloadInFlight.current = true
    try {
      const fresh = await load()
      if (!active.current) return
      replace(fresh)
    } catch (e) {
      if (!active.current) return
      context.toast('Reload failed', messageOf(e), { kind: 'error' })
    } finally {
      reloadInFlight.current = false
    }
  }

  const keepFile = async () => {
    if (!active.current) return
    const current = fileRef.current?.result
    if (operationEndedRef.current || actionInFlight.current || current?.state !== 'unresolved' || !isModifyDelete(current.kind)) return
    if (current.content === null) {
      context.toast('Keep file unavailable', 'No working-tree file is available to keep.')
      return
    }
    actionInFlight.current = true
    setActionPending(true)
    try {
      if (!(await save(false))) return
      if (!active.current) return
      if (dirtyRef.current) {
        context.toast('Keep file failed', 'The editor changed while the file was being saved. Try Keep file again.', { kind: 'error' })
        return
      }
      const fresh = await load()
      if (!active.current) return
      if (fresh.state !== 'unresolved' || !isModifyDelete(fresh.kind)) {
        replace(fresh)
        return
      }
      if (fresh.content === null) {
        replace(fresh)
        context.toast('Keep file unavailable', 'The working-tree file no longer exists.')
        return
      }
      await context.call('quirky.git/stage', { worktree, paths: [path] })
      if (!active.current) return
      const resolved = await load()
      if (!active.current) return
      replace(resolved)
    } catch (e) {
      if (!active.current) return
      context.toast('Keep file failed', messageOf(e), { kind: 'error' })
    } finally {
      actionInFlight.current = false
      if (active.current) setActionPending(false)
    }
  }

  const acceptDeletion = async () => {
    if (!active.current) return
    const current = fileRef.current?.result
    if (operationEndedRef.current || actionInFlight.current || current?.state !== 'unresolved' || !isModifyDelete(current.kind)) return
    actionInFlight.current = true
    setActionPending(true)
    try {
      await context.call('quirky.git/acceptConflictDeletion', { worktree, path, expected: base.current.hash })
      if (!active.current) return
      const resolved = await load()
      if (!active.current) return
      replace(resolved)
    } catch (e) {
      if (!active.current) return
      if (reasonOf(e) === 'changed-on-disk') setStale(true)
      context.toast('Accept deletion failed', messageOf(e), { kind: 'error' })
    } finally {
      actionInFlight.current = false
      if (active.current) setActionPending(false)
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
          editorTheme,
          syntaxExtensions(path, host),
          lineBreakExtension(base.current.text),
          conflictDecorations(),
          EditorView.editable.of(!actionPending),
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
      if (draftKey) {
        if (dirtyRef.current && fileRef.current) {
          drafts.set(draftKey, { text: view.state.sliceDoc(), base: base.current, result: fileRef.current.result, stale: staleRef.current })
        } else {
          drafts.delete(draftKey)
        }
      }
      viewRef.current = null
      view.destroy()
    }
  }, [file?.revision, file?.result.content === null, settings.wrap, actionPending])

  bind({
    nextConflict: () => step(1),
    previousConflict: () => step(-1),
    save: async () => { await save(false) },
    isDirty: () => dirtyRef.current,
    reloadFromDisk: reload,
    overwrite: async () => { await save(true) }
  })

  const result = file?.result
  const resolved = operationEnded || result?.state === 'resolved_locally'
  const kindHint = result && isModifyDelete(result.kind)
  const conflictCount = resolved ? 0 : blocks.length
  const currentConflict = conflictCount === 0 ? null : current
  const stateKey = JSON.stringify([conflictCount, currentConflict, dirty, stale])
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
      conflicts: conflictCount,
      currentConflict
    })
  }, [stateKey, path, report])
  const controls: string[] = ['close']
  const canNavigate = editable && !resolved && result?.state === 'unresolved' && blocks.length > 0
  if (canNavigate) controls.push('previous-conflict', 'next-conflict')
  const canChooseDeletion = result?.state === 'unresolved' && kindHint === true && !operationEnded && !actionInFlight.current
  if (result && canChooseDeletion) {
    if (result.content !== null) controls.push('keep-file')
    controls.push('accept-deletion')
  }
  if (stale && !reloadInFlight.current) controls.push('reload')

  const postControl = (action: string) => {
    void requestViewControl(context, { target: controlTarget, generation: controlGeneration, action })
  }
  useViewControl(context, { target: controlTarget, generation: controlGeneration, actions: controls }, ({ action, data }) => {
    if (!noControlData(data)) return false
    switch (action) {
      case 'close':
        close()
        return true
      case 'previous-conflict':
      case 'next-conflict':
        if (!canNavigate) return false
        step(action === 'next-conflict' ? 1 : -1)
        return true
      case 'keep-file': {
        const current = fileRef.current?.result
        if (!canChooseDeletion || !current || current.state !== 'unresolved' || !isModifyDelete(current.kind) || current.content === null || actionInFlight.current) return false
        void keepFile()
        return true
      }
      case 'accept-deletion': {
        const current = fileRef.current?.result
        if (!canChooseDeletion || !current || current.state !== 'unresolved' || !isModifyDelete(current.kind) || actionInFlight.current) return false
        void acceptDeletion()
        return true
      }
      case 'reload':
        if (!stale || reloadInFlight.current) return false
        void reload()
        return true
      default:
        return false
    }
  })
  return (
    <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <SectionHeader
        title={resolved ? path : `${path} (conflict)`}
        actions={
          <div className="ui-cluster">
            {editable && !resolved && (
              <>
                <Badge label={blocks.length === 0 ? '0 conflicts' : `Conflict ${current ?? 1} of ${blocks.length}`}>{blocks.length === 0 ? '0 / 0' : `${current ?? 1} / ${blocks.length}`}</Badge>
                <IconButton label="Previous conflict" title="Previous conflict" disabled={blocks.length === 0} onClick={() => postControl('previous-conflict')}>
                  ↑
                </IconButton>
                <IconButton label="Next conflict" title="Next conflict" disabled={blocks.length === 0} onClick={() => postControl('next-conflict')}>
                  ↓
                </IconButton>
              </>
            )}
            <IconButton label="Close" title="Close" onClick={() => postControl('close')}>×</IconButton>
          </div>
        }
      />
      {(result || operationEnded) && (
        <div className="ui-stack" role="status" style={{ padding: 'var(--ui-space-8)' }}>
          {operationEnded ? (
            <Badge tone="accent">Git operation ended</Badge>
          ) : result?.state === 'resolved_locally' ? (
            <Badge tone="accent">Resolved</Badge>
          ) : result ? (
            <Badge tone="needs-you">Unresolved conflict · {KIND_LABEL[result.kind]}</Badge>
          ) : null}
          {result && kindHint && result.state === 'unresolved' && !operationEnded && (
            <div className="ui-cluster">
              <Button
                disabled={actionPending || result.content === null}
                title={result.content === null ? 'No working-tree file is available to keep.' : undefined}
                onClick={() => postControl('keep-file')}
              >
                Keep file
              </Button>
              <Button variant="destructive" disabled={actionPending} onClick={() => postControl('accept-deletion')}>
                Accept deletion
              </Button>
            </div>
          )}
        </div>
      )}
      {stale && <StaleBar variant="file" onReload={() => postControl('reload')} onOverwrite={() => void save(true)} />}
      {error !== null && (
        <InlineError
          message={`Error loading conflict file: ${error}`}
          action={{ label: 'Retry', onAction: () => void refresh() }}
        />
      )}
      <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}>
        {operationEnded && !file ? (
          <EmptyState message="No working-tree file is available." />
        ) : error !== null && !file ? null : !file ? (
          <div role="status"><NoticeLine>Loading diff...</NoticeLine></div>
        ) : result?.content === null ? (
          <EmptyState message={resolved ? 'The file is not present in the working tree.' : 'No working-tree file is available to edit for this conflict.'} />
        ) : (
          <div data-diff-editor ref={hostRef} style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }} />
        )}
      </div>
    </div>
  )
}
