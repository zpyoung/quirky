import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, EmptyState, IconButton, ListRow, Menu, SectionHeader } from '@quirky/ui'
import type { GitCompare, GitDiff, GitStatus } from '@quirky/protocol'

import { reuseGitDiff } from '../diffRefresh'
import { useNotesBinding } from '../notes/binding'
import { NotesPreview } from '../notes/NotesPreview'
import { SendMenu } from '../notes/SendMenu'
import { useNotes, type Note } from '../notes/useNotes'
import {
  changeSections,
  combinedTitle,
  EAGER_SECTIONS,
  entrySignature,
  loadMode,
  statusSections,
  uncommittedAreas,
  type SectionEntry
} from './entries'
import { fetchDiff, isEditable, messageOf, POLL_MS, useRefreshTriggers } from './data'
import { DiffPane, type PaneHandle, type PaneState } from './DiffPane'
import { ErrorNotice } from './Fallbacks'
import { SectionLoader } from './loader'
import type { ModeProps } from './types'

type SectionState = { status: 'idle' | 'loading' | 'loaded' | 'error'; diff?: GitDiff; error?: string; revision: number }

type Data = {
  entries: SectionEntry[]
  excluded: number
  compare: GitCompare | null
  commit: string | null
}

const IDLE: PaneState = { changes: 0, current: null, dirty: false, stale: false, tooLarge: false }

/**
 * A combined diff: every file of one area, the branch, or one commit as its own section under a
 * toolbar. The first six sections load at once; the rest load as they come within a viewport of
 * the scroll position, one at a time. Large or unsized sections wait for "Load diff".
 */
export function CombinedDiff({ context, input, settings, setSetting, report, bind, close }: ModeProps) {
  const worktree = input.worktree
  const area = input.area ?? 'unstaged'
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sections, setSections] = useState<Record<string, SectionState>>({})
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [paneStates, setPaneStates] = useState<Record<string, PaneState>>({})
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const notes = useNotes(context, worktree)

  const dataRef = useRef<Data | null>(null)
  const sectionsRef = useRef<Record<string, SectionState>>({})
  const paneStatesRef = useRef<Record<string, PaneState>>({})
  const handles = useRef(new Map<string, PaneHandle>())
  const activeRef = useRef<string | null>(null)
  const collapsedRef = useRef<ReadonlySet<string>>(collapsed)
  const signature = useRef<string | null>(null)
  const inFlight = useRef(false)
  const treeTargets = useRef(new Map<string, HTMLElement>())

  const commitSections = (next: Record<string, SectionState>) => {
    sectionsRef.current = next
    setSections(next)
  }
  const patchSection = (key: string, patch: Partial<SectionState>) => {
    const current = sectionsRef.current[key]
    if (current) commitSections({ ...sectionsRef.current, [key]: { ...current, ...patch } })
  }

  const diffFor = (entry: SectionEntry): Promise<GitDiff> =>
    fetchDiff(context, worktree, { path: entry.path, source: entry.source, oldPath: entry.oldPath, commit: entry.commit })

  const run = async (key: string): Promise<void> => {
    const entry = dataRef.current?.entries.find((e) => e.key === key)
    const state = sectionsRef.current[key]
    if (!entry || !state || state.status === 'loaded') return
    patchSection(key, { status: 'loading' })
    try {
      const diff = await diffFor(entry)
      patchSection(key, { status: 'loaded', diff, error: undefined, revision: (sectionsRef.current[key]?.revision ?? 0) + 1 })
    } catch (e) {
      patchSection(key, { status: 'error', error: messageOf(e) })
    }
  }
  const runRef = useRef(run)
  runRef.current = run
  const loader = useRef<SectionLoader | null>(null)
  if (loader.current === null) loader.current = new SectionLoader((key) => runRef.current(key))

  const reloadSection = async (key: string): Promise<void> => {
    const entry = dataRef.current?.entries.find((e) => e.key === key)
    if (!entry) return
    const diff = await diffFor(entry)
    patchSection(key, { status: 'loaded', diff, error: undefined, revision: (sectionsRef.current[key]?.revision ?? 0) + 1 })
  }

  /**
   * Refetches a loaded section and compares its content with what is shown, because the status
   * counts cannot tell a rewrite that keeps them. Clean sections take the new diff; sections
   * with edits are flagged stale and keep their draft.
   */
  const revalidateSection = async (key: string): Promise<void> => {
    const entry = dataRef.current?.entries.find((e) => e.key === key)
    const shown = sectionsRef.current[key]
    if (!entry || shown?.status !== 'loaded' || !shown.diff) return
    const fresh = reuseGitDiff(shown.diff, await diffFor(entry))
    const now = sectionsRef.current[key]
    if (fresh === shown.diff || now?.status !== 'loaded' || now.diff !== shown.diff) return
    if (paneStatesRef.current[key]?.dirty) handles.current.get(key)?.markStale()
    else patchSection(key, { diff: fresh, revision: now.revision + 1 })
  }

  const fetchData = async (full: boolean): Promise<Data> => {
    if (input.commit !== undefined) {
      const result = (await context.call('quirky.git/commitFiles', { worktree, commit: input.commit })) as {
        commit: string
        entries: Parameters<typeof changeSections>[0]
      }
      return { entries: changeSections(result.entries, 'commit', result.commit), excluded: 0, compare: null, commit: result.commit }
    }
    const areas = uncommittedAreas(area)
    let uncommitted: { entries: SectionEntry[]; excluded: number } = { entries: [], excluded: 0 }
    if (areas.length > 0) {
      uncommitted = statusSections((await context.call('quirky.git/status', { worktree })) as GitStatus, areas)
    }
    let compare: GitCompare | null = null
    if (area === 'branch' || area === 'all') {
      compare =
        full || !dataRef.current?.compare
          ? ((await context.call('quirky.git/compare', { worktree })) as GitCompare)
          : dataRef.current.compare
    }
    const branch = compare?.status === 'ready' ? changeSections(compare.entries, 'branch') : []
    return { entries: [...uncommitted.entries, ...branch], excluded: uncommitted.excluded, compare, commit: null }
  }

  const refresh = async (full: boolean): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const next = await fetchData(full)
      const nextSignature = `${next.entries.map(entrySignature).join('\n')}#${next.excluded}#${next.compare?.status}#${next.compare?.base}`
      if (nextSignature !== signature.current) {
        signature.current = nextSignature
        dataRef.current = next
        setData(next)
        setError(null)

        const kept: Record<string, SectionState> = {}
        for (const entry of next.entries) kept[entry.key] = sectionsRef.current[entry.key] ?? { status: 'idle', revision: 0 }
        commitSections(kept)
        for (const key of [...handles.current.keys()]) if (!kept[key]) handles.current.delete(key)

        next.entries.slice(0, EAGER_SECTIONS).forEach((entry) => {
          if (kept[entry.key].status === 'idle' && loadMode(entry) === 'auto') void loader.current?.request(entry.key)
        })
      }
      // a commit's files never change under it
      if (input.commit === undefined) {
        const loaded = next.entries.filter((e) => sectionsRef.current[e.key]?.status === 'loaded')
        await Promise.all(loaded.map((e) => revalidateSection(e.key).catch(() => undefined)))
      }
    } catch (e) {
      if (dataRef.current === null) setError(messageOf(e))
    } finally {
      inFlight.current = false
    }
  }

  useEffect(() => {
    void refresh(true)
  }, [])
  useRefreshTriggers(context, () => void refresh(true), null)
  useEffect(() => {
    const timer = setInterval(() => void refresh(false), POLL_MS)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => () => loader.current?.clear(), [])

  useEffect(() => {
    if (typeof IntersectionObserver !== 'undefined' || !data) return
    for (const entry of data.entries) if (loadMode(entry) === 'auto') void loader.current?.request(entry.key)
  }, [data])

  const loadNow = useCallback((key: string) => loader.current!.request(key, true), [])
  const onVisible = useCallback((key: string) => {
    const entry = dataRef.current?.entries.find((e) => e.key === key)
    if (entry && loadMode(entry) === 'auto') void loader.current?.request(key)
  }, [])

  const onPaneState = useCallback((key: string, state: PaneState) => {
    const current = paneStatesRef.current[key]
    if (current && JSON.stringify(current) === JSON.stringify(state)) return
    paneStatesRef.current = { ...paneStatesRef.current, [key]: state }
    setPaneStates(paneStatesRef.current)
  }, [])
  const onPaneHandle = useCallback((key: string, handle: PaneHandle | null) => {
    if (handle) handles.current.set(key, handle)
    else handles.current.delete(key)
  }, [])
  const activate = useCallback((key: string) => {
    activeRef.current = key
    setActiveKey(key)
  }, [])

  const entries = data?.entries ?? []
  const allCollapsed = entries.length > 0 && entries.every((e) => collapsed.has(e.key))
  const setAllCollapsed = (value: boolean) => {
    const next: ReadonlySet<string> = value ? new Set(dataRef.current?.entries.map((e) => e.key)) : new Set()
    collapsedRef.current = next
    setCollapsed(next)
  }
  const toggleSection = useCallback((key: string) => {
    const next = new Set(collapsedRef.current)
    if (!next.delete(key)) next.add(key)
    collapsedRef.current = next
    setCollapsed(next)
  }, [])

  const navigate = (direction: 1 | -1) => {
    const keys = (dataRef.current?.entries ?? []).map((e) => e.key).filter((k) => (handles.current.get(k)?.changeCount() ?? 0) > 0)
    if (keys.length === 0) return
    const at = Math.max(0, keys.indexOf(activeRef.current ?? ''))
    activate(keys[at])
    const pane = handles.current.get(keys[at])!
    const current = pane.currentChange()
    const count = pane.changeCount()
    if (direction > 0) {
      if (current === null) pane.goToChange(1)
      else if (current < count) pane.goToChange(current + 1)
      else {
        const next = keys[(at + 1) % keys.length]
        activate(next)
        handles.current.get(next)!.goToChange(1)
      }
    } else if (current === null) pane.goToChange(count)
    else if (current > 1) pane.goToChange(current - 1)
    else {
      const previous = keys[(at - 1 + keys.length) % keys.length]
      activate(previous)
      const target = handles.current.get(previous)!
      target.goToChange(target.changeCount())
    }
  }

  const eachPane = async (wanted: (state: PaneState) => boolean, act: (handle: PaneHandle) => Promise<void>) => {
    for (const [key, handle] of [...handles.current]) {
      if (wanted(paneStatesRef.current[key] ?? IDLE)) await act(handle)
    }
  }

  bind({
    nextChange: () => navigate(1),
    previousChange: () => navigate(-1),
    revertChange: () => void handles.current.get(activeRef.current ?? '')?.revertChange(),
    save: async () => {
      for (const handle of handles.current.values()) {
        if (handle.isDirty()) await handle.save()
      }
    },
    isDirty: () => {
      for (const handle of handles.current.values()) {
        if (handle.isDirty()) return true
      }
      return false
    },
    reloadFromDisk: () => eachPane((s) => s.stale, (h) => h.reload()),
    overwrite: () => eachPane((s) => s.stale, (h) => h.overwrite()),
    collapseAll: (value) => setAllCollapsed(value ?? !allCollapsed),
    loadDiff: async (path) => {
      const matches = dataRef.current?.entries.filter((e) => e.path === path) ?? []
      if (matches.length === 0) throw new Error(`No section for ${path}.`)
      await Promise.all(matches.map((e) => loadNow(e.key)))
    }
  })

  const states = entries.map((e) => paneStates[e.key] ?? IDLE)
  const active = (activeKey ? paneStates[activeKey] : undefined) ?? states.find((s) => s.changes > 0)
  const loadedPaths = entries.filter((e) => sections[e.key]?.status === 'loaded').map((e) => e.path)
  const summary = JSON.stringify([
    states.map((s) => [s.changes, s.dirty, s.stale, s.tooLarge]),
    active?.current ?? null,
    loadedPaths,
    entries.length,
    allCollapsed
  ])
  useEffect(() => {
    report({
      mode: 'combined',
      source: null,
      path: null,
      area: input.commit ? null : area,
      commit: data?.commit ?? input.commit ?? null,
      changes: states.reduce((sum, s) => sum + s.changes, 0),
      currentChange: active?.current ?? null,
      dirty: states.some((s) => s.dirty),
      stale: states.some((s) => s.stale),
      tooLarge: states.some((s) => s.tooLarge),
      sections: entries.length,
      loadedSections: loadedPaths,
      collapsed: allCollapsed
    })
  }, [summary, area, input.commit, data?.commit, report])

  const title = combinedTitle(input, data?.compare ?? null, data?.commit ?? null)
  const notEmptyReason = area === 'branch' && data?.compare && data.compare.status !== 'ready' ? data.compare.message : null
  const showConflicts = (data?.excluded ?? 0) > 0 && (area === 'unstaged' || area === 'all')
  const count = entries.length

  return (
    <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <SectionHeader
        title={<span style={{ textTransform: 'none' }}>{title}</span>}
        titleTooltip={title}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', padding: 'var(--ui-space-8)' }}
        actions={
          <div className="ui-cluster" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 'var(--ui-space-4)', width: 'max-content' }}>
            {data && <Badge label={`${count} changed file${count === 1 ? '' : 's'}`}>{`${count} changed file${count === 1 ? '' : 's'}`}</Badge>}
            {notes.length > 0 && (
              <>
                <NotesPreview context={context} worktree={worktree} notes={notes} />
                <SendMenu
                  context={context}
                  worktree={worktree}
                  scopes={[{ id: 'all', label: 'All unsent notes', notes, params: { scope: 'all' } }]}
                >
                  Send
                </SendMenu>
              </>
            )}
            {input.commit === undefined && (
              <Button onClick={() => void context.executeCommand('command:quirky.git/open-changes', { worktree, area: area === 'branch' ? 'all' : 'branch' })}>
                {area === 'branch' ? 'Open All Changes' : 'Open Branch Diff'}
              </Button>
            )}
            <Button onClick={() => setAllCollapsed(!allCollapsed)}>
              {allCollapsed ? 'Expand All' : 'Collapse All'}
            </Button>
            <IconButton
              label={settings.sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
              title={settings.sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
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
                  },
                  {
                    id: 'file-tree',
                    label: 'Show file tree',
                    checked: settings.fileTree,
                    onAction: () => setSetting('combinedDiffFileTree', settings.fileTree ? 'hidden' : 'shown')
                  }
                ]}
              />
            </div>
            <IconButton label="Close" title="Close" onClick={close}>×</IconButton>
          </div>
        }
      />
      <div className="ui-cluster" style={{ alignItems: 'stretch', flexWrap: 'nowrap', flex: 1, minHeight: 0, minWidth: 0 }}>
        {settings.fileTree && (
          <nav aria-label="Files" className="ui-stack" style={{ flex: '0 0 20%', minHeight: 0, overflow: 'auto', padding: 'var(--ui-space-8)' }}>
            {entries.map((entry) => (
              <div key={entry.key} data-path={entry.path}>
                <ListRow
                  title={<span title={entry.path} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.path}</span>}
                  selected={activeKey === entry.key}
                  onClick={() => {
                    activate(entry.key)
                    treeTargets.current.get(entry.key)?.scrollIntoView?.({ block: 'start' })
                    onVisible(entry.key)
                  }}
                />
              </div>
            ))}
          </nav>
        )}
        <div className="ui-stack" ref={setScrollEl} style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}>
          {error !== null && data === null && <ErrorNotice message={error} />}
          {data === null && error === null && <p className="ui-text-muted" style={{ padding: 'var(--ui-space-8)' }}>Loading diff...</p>}
          {showConflicts && (
            <section className="ui-stack" role="region" aria-label="Conflicted files are reviewed separately" style={{ padding: 'var(--ui-space-12)' }}>
              <Badge tone="needs-you">Conflicted files are reviewed separately</Badge>
              <p>This diff view excludes unresolved conflicts because the normal two-way diff pipeline is not conflict-safe.</p>
              <p>{data!.excluded} unresolved conflicts were excluded from this diff view.</p>
              <Button onClick={() => void context.executeCommand('command:quirky.git/review-conflicts', { worktree })}>Review conflicts</Button>
            </section>
          )}
          {notEmptyReason && <p className="ui-text-muted" style={{ padding: 'var(--ui-space-8)' }}>{notEmptyReason}</p>}
          {data !== null && count === 0 && !notEmptyReason && <EmptyState message="No changes to display" />}
          {entries.map((entry) => (
            <Section
              key={entry.key}
              context={context}
              worktree={worktree}
              notes={notes}
              entry={entry}
              state={sections[entry.key] ?? { status: 'idle', revision: 0 }}
              dirty={paneStates[entry.key]?.dirty === true}
              collapsed={collapsed.has(entry.key)}
              root={scrollEl}
              settings={settings}
              treeTargets={treeTargets.current}
              onToggle={toggleSection}
              onLoad={loadNow}
              onVisible={onVisible}
              onPaneState={onPaneState}
              onPaneHandle={onPaneHandle}
              onActivate={activate}
              onSaved={(key, content, hash) => {
                const diff = sectionsRef.current[key]?.diff
                if (diff) patchSection(key, { diff: { ...diff, modified: content, modifiedHash: hash } })
              }}
              onReload={reloadSection}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

type SectionProps = {
  context: ModeProps['context']
  worktree: string
  notes: readonly Note[]
  entry: SectionEntry
  state: SectionState
  dirty: boolean
  collapsed: boolean
  root: HTMLElement | null
  settings: ModeProps['settings']
  treeTargets: Map<string, HTMLElement>
  onToggle(key: string): void
  onLoad(key: string): Promise<void>
  onVisible(key: string): void
  onPaneState(key: string, state: PaneState): void
  onPaneHandle(key: string, handle: PaneHandle | null): void
  onActivate(key: string): void
  onSaved(key: string, content: string, hash: string): void
  onReload(key: string): Promise<void>
}

function Section(props: SectionProps) {
  const { context, worktree, notes, entry, state, dirty, collapsed, root, settings, treeTargets, onToggle, onLoad, onVisible } = props
  const { key } = entry
  const binding = useNotesBinding(context, worktree, notes)
  const fileNotes = notes.filter((note) => note.path === entry.path)
  const element = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = element.current
    if (!el || !root || typeof IntersectionObserver === 'undefined') return
    treeTargets.set(key, el)
    const observer = new IntersectionObserver(
      (hits) => {
        if (hits.some((hit) => hit.isIntersecting)) onVisible(key)
      },
      { root, rootMargin: '100% 0%' }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      treeTargets.delete(key)
    }
  }, [root, key, onVisible, treeTargets])

  const onPaneState = useCallback((paneState: PaneState) => props.onPaneState(key, paneState), [props.onPaneState, key])
  const onPaneHandle = useCallback((handle: PaneHandle | null) => props.onPaneHandle(key, handle), [props.onPaneHandle, key])
  const onSaved = useCallback((content: string, hash: string) => props.onSaved(key, content, hash), [props.onSaved, key])
  const onReload = useCallback(() => props.onReload(key), [props.onReload, key])

  const mode = loadMode(entry)
  const known = entry.added !== null && entry.removed !== null
  return (
    <section data-path={entry.path} ref={element} onPointerDown={() => props.onActivate(key)} className="ui-stack">
      <header className="ui-cluster" style={{ position: 'sticky', top: 0, zIndex: 5, flexWrap: 'nowrap', minWidth: 0 }}>
        <IconButton
          label={`${collapsed ? 'Expand' : 'Collapse'} ${entry.path}`}
          aria-expanded={!collapsed}
          onClick={() => onToggle(key)}
        >
          {collapsed ? '▸' : '▾'}
        </IconButton>
        <ListRow
          title={<span title={entry.path}>{entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}</span>}
          description={
            known && (
              <span className="ui-cluster" style={{ flexWrap: 'nowrap' }}>
                <Badge tone="working" label={`Added ${entry.added} line${entry.added === 1 ? '' : 's'}`}>+{entry.added}</Badge>
                <Badge tone="failing" label={`Removed ${entry.removed} line${entry.removed === 1 ? '' : 's'}`}>-{entry.removed}</Badge>
              </span>
            )
          }
          trailing={
            <div className="ui-cluster">
              {dirty && <Badge tone="needs-you" label="Unsaved changes">M</Badge>}
              {fileNotes.length > 0 && (
                <SendMenu
                  context={context}
                  worktree={worktree}
                  scopes={[
                    { id: 'file', label: 'This file', notes: fileNotes, params: { scope: 'file', path: entry.path } },
                    { id: 'all', label: 'All unsent notes', notes, params: { scope: 'all' } }
                  ]}
                />
              )}
              <Button onClick={() => void navigator.clipboard?.writeText(entry.path)}>Copy path</Button>
              <Button
                onClick={() =>
                  void context.executeCommand('command:quirky.git/open-diff', {
                    worktree,
                    source: entry.source,
                    path: entry.path,
                    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
                    ...(entry.commit ? { commit: entry.commit } : {})
                  })
                }
              >
                Open diff
              </Button>
            </div>
          }
        />
      </header>
      <div hidden={collapsed} className="ui-stack" style={{ minWidth: 0 }}>
        {state.status === 'error' ? (
          <>
            <ErrorNotice message={state.error ?? 'Unable to load diff.'} />
            <Button onClick={() => void onLoad(key)}>Retry</Button>
          </>
        ) : state.status === 'loaded' && state.diff ? (
          <DiffPane
            key={state.revision}
            context={context}
            worktree={worktree}
            path={entry.path}
            diff={state.diff}
            editable={isEditable(entry.source, state.diff)}
            settings={settings}
            variant="section"
            onState={onPaneState}
            bind={onPaneHandle}
            onSaved={onSaved}
            onReload={onReload}
            onFocus={() => props.onActivate(key)}
            notes={binding}
          />
        ) : state.status === 'idle' && mode !== 'auto' ? (
          <section className="ui-stack" style={{ padding: 'var(--ui-space-12)' }}>
            <p>{known ? 'Large diffs are not rendered by default.' : "This diff's size isn't known yet, so it loads on request."}</p>
            <Button onClick={() => void onLoad(key)}>Load diff</Button>
          </section>
        ) : (
          <p className="ui-text-muted" style={{ padding: 'var(--ui-space-8)' }}>Loading diff...</p>
        )}
      </div>
    </section>
  )
}
