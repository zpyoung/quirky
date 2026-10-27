import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitDiff } from '@quirky/protocol'
import { reuseGitDiff } from '../diffRefresh'
import { fetchDiff, isEditable, messageOf, POLL_MS, useRefreshTriggers } from './data'
import { DiffPane, type PaneHandle, type PaneState } from './DiffPane'
import { ErrorNotice } from './Fallbacks'
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
  const [menuOpen, setMenuOpen] = useState(false)
  const paneRef = useRef<PaneHandle | null>(null)
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
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const sideLabel = settings.sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'
  const chip = SOURCE_CHIP[source]
  return (
    <div className="qgv-file">
      <header className="qgv-bar">
        <span className="qgv-title" title={path}>
          <span className="qgv-path">{path}</span>
          <span className="qgv-sub"> (diff)</span>
        </span>
        {chip && <span className="qgv-chip">{chip}</span>}
        <span className="qgv-spacer" />
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
        <button type="button" aria-label="Close" title="Close" onClick={close}>
          ✕
        </button>
      </header>
      <div className="qgv-body">
        {error !== null && loaded === null ? (
          <ErrorNotice message={error} />
        ) : loaded === null ? (
          <p className="qgv-muted qgv-pad">Loading diff...</p>
        ) : (
          <DiffPane
            key={loaded.revision}
            context={context}
            worktree={input.worktree}
            diff={loaded.diff}
            editable={editable}
            settings={settings}
            variant="file"
            onState={onState}
            bind={onPaneHandle}
            onSaved={onSaved}
            onReload={onReload}
          />
        )}
      </div>
    </div>
  )
}
