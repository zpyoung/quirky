import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitDiff } from '@quirky/protocol'
import { reuseGitDiff } from '../diffRefresh'
import { useNotesBinding } from '../notes/binding'
import { NotesPillContent } from '../notes/NotesPill'
import { SendMenu } from '../notes/SendMenu'
import { useNotes } from '../notes/useNotes'
import { fetchDiff, isEditable, messageOf, POLL_MS, useRefreshTriggers } from './data'
import { DiffPane, type PaneHandle, type PaneState } from './DiffPane'
import { ErrorNotice } from './Fallbacks'
import { openHostedDiff } from './hosted-tabs'
import type { ModeProps } from './types'

const IDLE: PaneState = { changes: 0, current: null, dirty: false, stale: false, tooLarge: false }

const SOURCE_CHIP = { staged: 'Staged', branch: 'Branch', commit: 'Commit', unstaged: null } as const

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
  const [menuOpen, setMenuOpen] = useState(false)
  const paneRef = useRef<PaneHandle | null>(null)
  const allNotes = useNotes(context, input.worktree)
  const binding = useNotesBinding(context, input.worktree, allNotes, input.noteId)
  const fileNotes = allNotes.filter((note) => note.path === path)
  const paneState = useRef<PaneState>(IDLE)
  const loadedRef = useRef<Loaded | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const fresh = await fetchDiff(context, input.worktree, { path, source, oldPath: input.oldPath, commit: input.commit })
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
  }, [context, input.worktree, input.oldPath, input.commit, path, source])

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
    const fresh = await fetchDiff(context, input.worktree, { path, source, oldPath: input.oldPath, commit: input.commit })
    const replaced = { diff: fresh, revision: (loadedRef.current?.revision ?? 0) + 1 }
    loadedRef.current = replaced
    setLoaded(replaced)
  }, [context, input.worktree, input.oldPath, input.commit, path, source])

  const editable = loaded ? isEditable(source, loaded.diff) : false

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
      source,
      path,
      area: null,
      commit: input.commit ?? null,
      changes: state.changes,
      currentChange: state.current,
      dirty: state.dirty,
      stale: state.stale,
      tooLarge: state.tooLarge
    })
  }, [stateKey, source, path, input.commit, report])
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

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const sideLabel = settings.sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'
  const chip = SOURCE_CHIP[source]
  const switchDisplay = () => {
    if (!markdown) return
    const display = showMarkdownPreview ? 'source' : 'preview'
    void openHostedDiff(context, { ...input, display }).catch((error: unknown) =>
      context.toast('Could not switch Markdown diff view', messageOf(error))
    )
  }
  return (
    <div className="qgv-file">
      <header className="qgv-bar">
        <span className="qgv-title" title={path}>
          <span className="qgv-path">{path}</span>
          <span className="qgv-sub"> (diff)</span>
        </span>
        {chip && <span className="qgv-chip">{chip}</span>}
        <span className="qgv-spacer" />
        {fileNotes.length > 0 && (
          <SendMenu
            context={context}
            worktree={input.worktree}
            className="qgv-note-pill"
            ariaLabel="Send AI notes to an agent"
            scopes={[
              { id: 'file', label: 'This file', notes: fileNotes, params: { scope: 'file', path } },
              { id: 'all', label: 'All unsent notes', notes: allNotes, params: { scope: 'all' } }
            ]}
          >
            <NotesPillContent count={fileNotes.length} />
          </SendMenu>
        )}
        {!showMarkdownPreview && (
          <>
            <button
              type="button"
              aria-label="Previous change"
              title="Previous change"
              disabled={state.changes === 0}
              onClick={() => void paneRef.current?.previousChange()}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Next change"
              title="Next change"
              disabled={state.changes === 0}
              onClick={() => void paneRef.current?.nextChange()}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={sideLabel}
              title={sideLabel}
              onClick={() => setSetting('diffDefaultView', settings.sideBySide ? 'inline' : 'side-by-side')}
            >
              {settings.sideBySide ? '▤' : '▥'}
            </button>
            <span className="qgv-menu-anchor">
              <button
                type="button"
                aria-label="More actions"
                title="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="qgv-menu" role="menu">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={settings.wrap}
                    onClick={() => {
                      setSetting('diffWordWrap', !settings.wrap)
                      setMenuOpen(false)
                    }}
                  >
                    <span className="qgv-check">{settings.wrap ? '✓' : ''}</span>Word Wrap
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={settings.showWhitespace}
                    onClick={() => {
                      setSetting('diffShowWhitespace', !settings.showWhitespace)
                      setMenuOpen(false)
                    }}
                  >
                    <span className="qgv-check">{settings.showWhitespace ? '✓' : ''}</span>Show Whitespace
                  </button>
                </div>
              )}
            </span>
          </>
        )}
        {markdown && (
          <button
            type="button"
            aria-label={showMarkdownPreview ? 'Show Source' : 'Preview Modified Markdown'}
            title={showMarkdownPreview ? 'Show both diff sides' : 'Preview only modified Markdown'}
            onClick={switchDisplay}
          >
            {showMarkdownPreview ? 'Source' : 'Preview'}
          </button>
        )}
        <button type="button" aria-label="Close" title="Close" onClick={close}>
          ✕
        </button>
      </header>
      <div className="qgv-body">
        {showMarkdownPreview && (
          <div className="qgv-markdown-preview-panel">
            <p className="qgv-markdown-preview-notice">
              Showing only the modified Markdown side. Switch to Source to compare both sides.
            </p>
            {loaded === null ? (
              error !== null ? <ErrorNotice message={error} /> : <p className="qgv-muted qgv-pad">Loading modified Markdown...</p>
            ) : previewError !== null ? (
              <ErrorNotice message={`Markdown preview unavailable: ${previewError}. Open Source to compare the file.`} />
            ) : previewHtml === null ? (
              <p className="qgv-muted qgv-pad">Rendering modified Markdown...</p>
            ) : (
              <div
                className="qgv-markdown-preview markdown-body"
                style={{ padding: '16px 24px', overflow: 'auto', lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            )}
          </div>
        )}
        <div className="qgv-source-diff" hidden={showMarkdownPreview}>
          {error !== null && loaded === null ? (
            <ErrorNotice message={error} />
          ) : loaded === null ? (
            <p className="qgv-muted qgv-pad">Loading diff...</p>
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
