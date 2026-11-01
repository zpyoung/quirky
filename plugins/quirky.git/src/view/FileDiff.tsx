import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconButton, Menu, SectionHeader } from '@quirky/ui'
import type { GitDiff, GitStatus } from '@quirky/protocol'

import { reuseGitDiff } from '../diffRefresh'
import { useNotesBinding } from '../notes/binding'
import { SendMenu } from '../notes/SendMenu'
import { useNotes } from '../notes/useNotes'
import { fetchDiff, isEditable, messageOf, POLL_MS, useRefreshTriggers } from './data'
import { DiffPane, type PaneHandle, type PaneState } from './DiffPane'
import { ErrorNotice } from './Fallbacks'
import { openHostedDiff } from './hosted-tabs'
import type { ModeProps } from './types'

const IDLE: PaneState = { changes: 0, current: null, dirty: false, stale: false, tooLarge: false }

const SOURCE_LABELS = { staged: 'Staged', branch: 'Branch', commit: 'Commit', unstaged: null } as const

type Loaded = { diff: GitDiff; revision: number }

/**
 * One file's diff: the header with the path, change arrows, the inline / side-by-side switch, the
 * Word Wrap and Show Whitespace menu and Close, over the diff itself. It follows the file on
 * disk, unless there are unsaved edits, which it keeps and flags as stale instead.
 */
export function FileDiff({ context, input, settings, setSetting, report, bind, close }: ModeProps) {
  const path = input.path ?? ''
  const source = input.source ?? 'unstaged'
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pane, setPane] = useState<PaneState>(IDLE)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const paneRef = useRef<PaneHandle | null>(null)
  const allNotes = useNotes(context, input.worktree)
  const binding = useNotesBinding(context, input.worktree, allNotes, input.noteId)
  const fileNotes = allNotes.filter((note) => note.path === path)
  const paneState = useRef<PaneState>(IDLE)
  const loadedRef = useRef<Loaded | null>(null)
  const inFlight = useRef(false)

  const fetchCurrentDiff = useCallback(async () => {
    const requestedSource = source
    let effectiveSource = requestedSource
    let oldPath = input.oldPath
    if (requestedSource === 'staged' || requestedSource === 'unstaged') {
      const status = (await context.call('quirky.git/status', { worktree: input.worktree })) as GitStatus
      const hasConflict = status.entries.some((entry) => entry.path === path && entry.area === 'conflicts')
      if (!hasConflict) {
        const file = status.files.find((entry) => entry.path === path)
        const hasStaged = file !== undefined && !file.untracked && file.index !== ' '
        const hasUnstaged = file !== undefined && (file.worktree !== ' ' || file.untracked)
        if (requestedSource === 'staged' && !hasStaged && hasUnstaged) effectiveSource = 'unstaged'
        else if (requestedSource === 'unstaged' && !hasUnstaged && hasStaged) effectiveSource = 'staged'
        if (effectiveSource === 'staged') oldPath = file?.origPath
        else if (requestedSource === 'staged') oldPath = undefined
      }
    }
    return fetchDiff(context, input.worktree, {
      path,
      source: effectiveSource,
      oldPath,
      commit: input.commit
    })
  }, [context, input.worktree, input.oldPath, input.commit, path, source])

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const fresh = await fetchCurrentDiff()
      const previous = loadedRef.current
      const next = reuseGitDiff(previous?.diff ?? null, fresh)
      if (previous && next === previous.diff) return
      if (previous && paneState.current.dirty) {
        paneRef.current?.markStale()
        return
      }
      const replaced = { diff: next, revision: (previous?.revision ?? 0) + 1 }
      loadedRef.current = replaced
      setLoaded(replaced)
      setError(null)
    } catch (e) {
      if (!loadedRef.current) setError(messageOf(e))
    } finally {
      inFlight.current = false
    }
  }, [fetchCurrentDiff])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useRefreshTriggers(context, () => void refresh(), POLL_MS)

  const onState = useCallback((state: PaneState) => {
    paneState.current = state
    setPane(state)
  }, [])
  const onPaneHandle = useCallback((handle: PaneHandle | null) => {
    paneRef.current = handle
  }, [])
  const onSaved = useCallback((content: string, hash: string) => {
    const previous = loadedRef.current
    if (!previous) return
    loadedRef.current = { ...previous, diff: { ...previous.diff, modified: content, modifiedHash: hash } }
  }, [])
  const onReload = useCallback(async () => {
    const fresh = await fetchCurrentDiff()
    const replaced = { diff: fresh, revision: (loadedRef.current?.revision ?? 0) + 1 }
    loadedRef.current = replaced
    setLoaded(replaced)
  }, [fetchCurrentDiff])

  const effectiveSource = loaded?.diff.source ?? source
  const editable = loaded ? isEditable(effectiveSource, loaded.diff) : false

  bind({
    nextChange: () => void paneRef.current?.nextChange(),
    previousChange: () => void paneRef.current?.previousChange(),
    revertChange: () => void paneRef.current?.revertChange(),
    save: () => paneRef.current?.save() ?? Promise.resolve(),
    reloadFromDisk: () => paneRef.current?.reload() ?? Promise.resolve(),
    overwrite: () => paneRef.current?.overwrite() ?? Promise.resolve()
  })

  const state = loaded ? pane : IDLE
  const stateKey = JSON.stringify(state)
  const lowerPath = path.toLowerCase()
  const markdown = lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')
  const showMarkdownPreview = markdown && input.display === 'preview'
  useEffect(() => {
    report({
      mode: 'file',
      source: effectiveSource,
      path,
      area: null,
      commit: input.commit ?? null,
      changes: state.changes,
      currentChange: state.current,
      dirty: state.dirty,
      stale: state.stale,
      tooLarge: state.tooLarge
    })
  }, [stateKey, effectiveSource, path, input.commit, report])
  useEffect(() => {
    if (!showMarkdownPreview || !loaded) {
      setPreviewHtml(null)
      setPreviewError(null)
      return
    }
    const leaseId = crypto.randomUUID()
    let active = true
    const worktreeId = input.worktree
    const text = paneRef.current?.modifiedText() ?? loaded.diff.modified
    const release = () => {
      try {
        void context.call('quirky.editor/markdownPreview', { action: 'release', leaseId }).catch(() => {})
      } catch {}
    }
    setPreviewHtml(null)
    setPreviewError(null)
    void context.call('quirky.editor/markdownPreview', {
      action: 'render',
      leaseId,
      worktree: `id:${worktreeId}`,
      path,
      text
    }).then((value: unknown) => {
      if (!active) {
        release()
        return
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        release()
        setPreviewError('The Markdown preview renderer returned invalid content.')
        return
      }
      const response = value as Record<string, unknown>
      if (response.leaseId !== leaseId || response.worktreeId !== worktreeId || response.path !== path ||
        typeof response.html !== 'string') {
        release()
        setPreviewError('The Markdown preview renderer returned invalid content.')
        return
      }
      setPreviewHtml(response.html)
    }).catch((reason: unknown) => {
      release()
      if (active) setPreviewError(messageOf(reason))
    })
    return () => {
      active = false
      release()
    }
  }, [context, input.worktree, path, showMarkdownPreview, loaded?.revision, stateKey])


  const oldPath = loaded ? loaded.diff.oldPath : input.oldPath
  const title = `${oldPath ? `${oldPath} → ${path}` : path} (diff)`
  const sideLabel = settings.sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'
  const sourceLabel = SOURCE_LABELS[effectiveSource]
  const switchDisplay = () => {
    if (!markdown) return
    const display = showMarkdownPreview ? 'source' : 'preview'
    void openHostedDiff(context, { ...input, display }).catch((error: unknown) =>
      context.toast('Could not switch Markdown diff view', messageOf(error))
    )
  }
  return (
    <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <SectionHeader
        title={<span style={{ textTransform: 'none' }}>{title}</span>}
        titleTooltip={title}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', padding: 'var(--ui-space-8)' }}
        actions={
          <div className="ui-cluster" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 'var(--ui-space-4)', width: 'max-content' }}>
            {sourceLabel && <span className="ui-text-muted" data-diff-source={sourceLabel} style={{ whiteSpace: 'nowrap' }}>{sourceLabel}</span>}
            {fileNotes.length > 0 && (
              <SendMenu
                context={context}
                worktree={input.worktree}
                ariaLabel="Send AI notes to an agent"
                scopes={[
                  { id: 'file', label: 'This file', notes: fileNotes, params: { scope: 'file', path } },
                  { id: 'all', label: 'All unsent notes', notes: allNotes, params: { scope: 'all' } }
                ]}
              >
                <><span aria-hidden="true">✦</span>{' '}{fileNotes.length}</>
              </SendMenu>
            )}
            {!showMarkdownPreview && (
              <>
                <IconButton
                  label="Previous change"
                  title="Previous change"
                  disabled={state.changes === 0}
                  onClick={() => void paneRef.current?.previousChange()}
                >
                  ↑
                </IconButton>
                <IconButton
                  label="Next change"
                  title="Next change"
                  disabled={state.changes === 0}
                  onClick={() => void paneRef.current?.nextChange()}
                >
                  ↓
                </IconButton>
                <IconButton
                  label={sideLabel}
                  title={sideLabel}
                  onClick={() => setSetting('diffDefaultView', settings.sideBySide ? 'inline' : 'side-by-side')}
                >
                  {settings.sideBySide ? '▤' : '▥'}
                </IconButton>
                <div title="More actions">
                  <Menu
                    label="More actions"
                    trigger="⋯"
                    items={[
                      {
                        id: 'word-wrap',
                        label: 'Word Wrap',
                        checked: settings.wrap,
                        onAction: () => setSetting('diffWordWrap', !settings.wrap)
                      },
                      {
                        id: 'show-whitespace',
                        label: 'Show Whitespace',
                        checked: settings.showWhitespace,
                        onAction: () => setSetting('diffShowWhitespace', !settings.showWhitespace)
                      }
                    ]}
                  />
                </div>
              </>
            )}
            {markdown && (
              <Button
                aria-label={showMarkdownPreview ? 'Show Source' : 'Preview Modified Markdown'}
                title={showMarkdownPreview ? 'Show both diff sides' : 'Preview only modified Markdown'}
                onClick={switchDisplay}
              >
                {showMarkdownPreview ? 'Source' : 'Preview'}
              </Button>
            )}
            <IconButton label="Close" title="Close" onClick={close}>×</IconButton>
          </div>
        }
      />
      <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        {showMarkdownPreview && (
          <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}>
            <p className="ui-text-muted" data-markdown-preview-notice style={{ padding: 'var(--ui-space-8)' }}>
              Showing only the modified Markdown side. Switch to Source to compare both sides.
            </p>
            {loaded === null ? (
              error !== null ? <ErrorNotice message={error} /> : <p className="ui-text-muted" style={{ padding: 'var(--ui-space-8)' }}>Loading modified Markdown...</p>
            ) : previewError !== null ? (
              <ErrorNotice message={`Markdown preview unavailable: ${previewError}. Open Source to compare the file.`} />
            ) : previewHtml === null ? (
              <p className="ui-text-muted" style={{ padding: 'var(--ui-space-8)' }}>Rendering modified Markdown...</p>
            ) : (
              <div
                data-markdown-preview
                className="ui-stack"
                style={{ flex: 1, minWidth: 0, padding: 'var(--ui-space-16) var(--ui-space-24)' }}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            )}
          </div>
        )}
        <div hidden={showMarkdownPreview} className="ui-stack" style={{ display: showMarkdownPreview ? 'none' : undefined, flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}>
          {error !== null && loaded === null ? (
            <ErrorNotice message={error} />
          ) : loaded === null ? (
            <p className="ui-text-muted" style={{ padding: 'var(--ui-space-8)' }}>Loading diff...</p>
          ) : (
            <DiffPane
              key={loaded.revision}
              context={context}
              worktree={input.worktree}
              path={path}
              diff={loaded.diff}
              editable={editable}
              settings={settings}
              variant="file"
              onState={onState}
              bind={onPaneHandle}
              onSaved={onSaved}
              onReload={onReload}
              notes={binding}
            />
          )}
        </div>
      </div>
    </div>
  )
}
