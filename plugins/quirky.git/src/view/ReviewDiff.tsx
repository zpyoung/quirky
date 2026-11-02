import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, IconButton, Menu, ScopeChip, SectionHeader } from '@quirky/ui'
import type { GitChange, GitDiff } from '@quirky/protocol'

import { reuseGitDiff } from '../diffRefresh'
import { useNotes } from '../notes/useNotes'
import { useSettings } from '../panel/data'
import { shortOid } from '../panel/format'
import { registerReviewView } from '../review/open'
import { reviewOrder, nextToReview } from '../review/order'
import { onSelectedPath, selectPath } from '../review/selection'
import { setReviewMark, useReview } from '../review/useReview'
import { fetchDiff, messageOf, useRefreshTriggers } from './data'
import type { PaneHandle, PaneState } from './DiffPane'
import { EAGER_SECTIONS } from './entries'
import { ErrorNotice } from './Fallbacks'
import { SectionLoader } from './loader'
import { ReviewCard, type CardData } from './ReviewCard'
import {
  bodyAgainst,
  cardFor,
  isCollapsed,
  itemFromChange,
  itemFromFile,
  layoutFor,
  loadModeOf,
  orderChanges,
  reconcileCards,
  type CardUi,
  type DiffLayout,
  type ReviewItem
} from './review-layout'
import type { ModeProps } from './types'

const IDLE: PaneState = { changes: 0, current: null, dirty: false, stale: false, tooLarge: false }
const NO_ITEMS: readonly ReviewItem[] = []

type CommitFiles = { scope: string; commit: string; entries: GitChange[] }

/** The disk-side hash `setReviewMark` checks: null when the diff shows the file deleted, undefined when the diff carries none. */
const diskHashOf = (diff: GitDiff): string | null | undefined => (diff.modifiedDeleted === true ? null : diff.modifiedHash)

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The worktree's one Review tab: a card per changed file, from the merge base to the disk, in the
 * panel's order, each with its review mark. A commit scope swaps the cards for that commit's files
 * and drops the review controls. The tab registers a `ReviewViewHandle` so `openReview` can steer a
 * mounted tab; it lays diffs out by its own width unless the header toggle says otherwise.
 */
export function ReviewDiff({ context, input, settings, setSetting, report, bind }: ModeProps) {
  const worktree = input.worktree
  const { model, error, refresh } = useReview(context, worktree)
  const [panelSettings] = useSettings(context)
  const viewMode = panelSettings.viewMode
  const notes = useNotes(context, worktree)

  const [scope, setScopeState] = useState<string | null>(input.commit ?? null)
  const [commitData, setCommitData] = useState<CommitFiles | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [ui, setUi] = useState<Record<string, CardUi>>({})
  const [sections, setSections] = useState<Record<string, CardData>>({})
  const [paneStates, setPaneStates] = useState<Record<string, PaneState>>({})
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [override, setOverride] = useState<DiffLayout | null>(null)
  const [revealTick, setRevealTick] = useState(0)
  const [noteTarget, setNoteTarget] = useState<{ path: string; noteId: string } | null>(
    input.reveal !== undefined && input.noteId !== undefined ? { path: input.reveal, noteId: input.noteId } : null
  )
  const [marking, setMarking] = useState<ReadonlySet<string>>(new Set())

  const sectionsRef = useRef<Record<string, CardData>>({})
  const paneStatesRef = useRef<Record<string, PaneState>>({})
  const uiRef = useRef(ui)
  uiRef.current = ui
  const handles = useRef(new Map<string, PaneHandle>())
  const cardElements = useRef(new Map<string, HTMLElement>())
  const activeRef = useRef<string | null>(null)
  const revalidating = useRef(new Set<string>())
  const skippedCollapsed = useRef(new Set<string>())
  const pendingNav = useRef<{ key: string; go: (pane: PaneHandle) => void } | null>(null)
  const pendingReveal = useRef<string | null>(input.reveal ?? null)
  const scrollRef = useRef<HTMLElement | null>(null)
  scrollRef.current = scrollEl

  useEffect(() => {
    if (scope === null) {
      setCommitData(null)
      setCommitError(null)
      return
    }
    let current = true
    setCommitError(null)
    context.call('quirky.git/commitFiles', { worktree, commit: scope }).then(
      (result) => {
        const { commit, entries } = result as { commit: string; entries: GitChange[] }
        if (current) setCommitData({ scope, commit, entries })
      },
      (e: unknown) => {
        if (current) setCommitError(messageOf(e))
      }
    )
    return () => {
      current = false
    }
  }, [context, worktree, scope])

  const files = model?.files
  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const note of notes) counts.set(note.path, (counts.get(note.path) ?? 0) + 1)
    return counts
  }, [notes])
  const items = useMemo<readonly ReviewItem[]>(() => {
    if (scope !== null) {
      if (commitData?.scope !== scope) return NO_ITEMS
      return orderChanges(commitData.entries, viewMode).map((change) => itemFromChange(change, commitData.commit, noteCounts.get(change.path) ?? 0))
    }
    return files === undefined ? NO_ITEMS : reviewOrder(files, viewMode).map(itemFromFile)
  }, [scope, commitData, files, viewMode, noteCounts])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const filesRef = useRef(files)
  filesRef.current = files
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode

  const viewOf = (item: ReviewItem): CardUi => cardFor(ui[item.key], item.mark)
  const viewOfRef = (item: ReviewItem): CardUi => cardFor(uiRef.current[item.key], item.mark)

  const commitSections = (next: Record<string, CardData>) => {
    sectionsRef.current = next
    setSections(next)
  }
  const patchSection = (key: string, patch: Partial<CardData>) => {
    const current = sectionsRef.current[key]
    if (current) commitSections({ ...sectionsRef.current, [key]: { ...current, ...patch } })
  }

  const diffFor = (item: ReviewItem, against: 'base' | 'reviewed') =>
    scope !== null && commitData
      ? fetchDiff(context, worktree, { path: item.path, source: 'commit', oldPath: item.oldPath, commit: commitData.commit })
      : fetchDiff(context, worktree, { path: item.path, source: 'review', oldPath: item.oldPath, against })

  const run = async (key: string): Promise<void> => {
    const first = itemsRef.current.find((i) => i.key === key)
    const state = sectionsRef.current[key]
    if (!first || !state || state.status === 'loaded') return
    patchSection(key, { status: 'loading' })
    // the card's side can change while a load is in flight, so a reply for the other side is dropped and the load repeats
    for (;;) {
      const item = itemsRef.current.find((i) => i.key === key) ?? first
      const against = bodyAgainst(viewOfRef(item))
      const stale = () => bodyAgainst(viewOfRef(itemsRef.current.find((i) => i.key === key) ?? item)) !== against
      try {
        const diff = await diffFor(item, against)
        if (stale()) continue
        patchSection(key, { status: 'loaded', diff, error: undefined, revision: (sectionsRef.current[key]?.revision ?? 0) + 1, against, signature: item.signature })
      } catch (e) {
        if (stale()) continue
        patchSection(key, { status: 'error', error: messageOf(e) })
      }
      return
    }
  }
  const runRef = useRef(run)
  runRef.current = run
  const loader = useRef<SectionLoader | null>(null)
  if (loader.current === null) loader.current = new SectionLoader((key) => runRef.current(key))
  useEffect(() => () => loader.current?.clear(), [])

  /**
   * Refetches a loaded card and keeps what is shown when the content is the same, so a refresh
   * that changes nothing never rebuilds the editor or loses its scroll position.
   */
  const revalidate = async (key: string): Promise<void> => {
    const item = itemsRef.current.find((i) => i.key === key)
    const shown = sectionsRef.current[key]
    if (!item || shown?.status !== 'loaded' || !shown.diff || revalidating.current.has(key)) return
    const against = bodyAgainst(viewOfRef(item))
    revalidating.current.add(key)
    try {
      const fresh = reuseGitDiff(shown.diff, await diffFor(item, against))
      const now = sectionsRef.current[key]
      if (now?.status !== 'loaded' || now.diff !== shown.diff) return
      patchSection(key, {
        against,
        signature: item.signature,
        ...(fresh === shown.diff ? {} : { diff: fresh, revision: now.revision + 1 })
      })
    } finally {
      revalidating.current.delete(key)
    }
    const latest = itemsRef.current.find((i) => i.key === key)
    const settled = sectionsRef.current[key]
    if (latest && settled?.status === 'loaded' && settled.against !== bodyAgainst(viewOfRef(latest))) await revalidate(key)
  }

  const onCardSaved = (key: string, content: string, hash: string) => {
    const diff = sectionsRef.current[key]?.diff
    if (diff) patchSection(key, { diff: { ...diff, modified: content, modifiedHash: hash } })
  }

  const reloadCard = async (key: string): Promise<void> => {
    const item = itemsRef.current.find((i) => i.key === key)
    if (!item) return
    const against = bodyAgainst(viewOfRef(item))
    const diff = await diffFor(item, against)
    patchSection(key, { status: 'loaded', diff, error: undefined, revision: (sectionsRef.current[key]?.revision ?? 0) + 1, against, signature: item.signature })
  }

  useEffect(() => {
    const kept: Record<string, CardData> = {}
    for (const item of items) {
      kept[item.key] = sectionsRef.current[item.key] ?? { status: 'idle', revision: 0, against: 'base', signature: item.signature }
    }
    const same = Object.keys(kept).length === Object.keys(sectionsRef.current).length && Object.keys(kept).every((k) => sectionsRef.current[k] === kept[k])
    if (!same) commitSections(kept)
    for (const key of [...handles.current.keys()]) if (!kept[key]) handles.current.delete(key)
    setUi((prev) => reconcileCards(prev, items))
  }, [items])

  useEffect(() => {
    const expanded = items.filter((item) => !isCollapsed(cardFor(ui[item.key], item.mark)))
    const eager = typeof IntersectionObserver === 'undefined' ? expanded : expanded.slice(0, EAGER_SECTIONS)
    for (const item of eager) {
      if (loadModeOf(item) === 'auto' && sectionsRef.current[item.key]?.status === 'idle') void loader.current?.request(item.key)
    }
    if (scope !== null) return
    for (const item of expanded) {
      const loaded = sectionsRef.current[item.key]
      if (loaded?.status !== 'loaded') continue
      const skipped = skippedCollapsed.current.delete(item.key)
      if (skipped || loaded.signature !== item.signature || loaded.against !== bodyAgainst(cardFor(ui[item.key], item.mark))) {
        void revalidate(item.key).catch((e: unknown) => {
          if (skipped) skippedCollapsed.current.add(item.key)
          // keeping the old side's diff would show it under the wrong label
          const now = sectionsRef.current[item.key]
          if (now?.status === 'loaded' && now.against !== bodyAgainst(viewOfRef(item))) patchSection(item.key, { status: 'error', error: messageOf(e) })
        })
      }
    }
  }, [items, ui, scope])

  useRefreshTriggers(
    context,
    () => {
      if (scope !== null) return
      for (const item of itemsRef.current) {
        // a folded card's disk content can change with its counts unchanged, so expanding it refetches
        if (isCollapsed(viewOfRef(item))) skippedCollapsed.current.add(item.key)
        else void revalidate(item.key).catch(() => undefined)
      }
    },
    null
  )

  const loadNow = useCallback((key: string) => void loader.current!.request(key, true), [])
  const onVisible = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key)
    if (item && loadModeOf(item) === 'auto' && !isCollapsed(cardFor(uiRef.current[key], item.mark))) void loader.current?.request(key)
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
  const register = useCallback((key: string, element: HTMLElement | null) => {
    if (element) cardElements.current.set(key, element)
    else cardElements.current.delete(key)
  }, [])

  const writeCard = useCallback((item: ReviewItem, patch: Partial<CardUi>) => {
    setUi((prev) => ({ ...prev, [item.key]: { ...cardFor(prev[item.key], item.mark), ...patch } }))
  }, [])
  const toggle = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key)
      if (item) writeCard(item, { collapsed: !isCollapsed(viewOfRef(item)) })
    },
    [writeCard]
  )
  const showFullDiff = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key)
      if (item) writeCard(item, { full: true })
    },
    [writeCard]
  )

  const allCollapsed = items.length > 0 && items.every((item) => isCollapsed(viewOf(item)))
  const setAllCollapsed = (collapsed: boolean) => {
    setUi((prev) => {
      const next = { ...prev }
      for (const item of itemsRef.current) next[item.key] = { ...cardFor(prev[item.key], item.mark), collapsed }
      return next
    })
  }

  const reveal = useCallback((path: string, noteId?: string) => {
    pendingReveal.current = path
    if (noteId !== undefined) setNoteTarget({ path, noteId })
    setRevealTick((tick) => tick + 1)
  }, [])

  useEffect(() => {
    const path = pendingReveal.current
    if (path === null) return
    const item = items.find((i) => i.path === path)
    const element = item && cardElements.current.get(item.key)
    if (!item || !element) return
    if (isCollapsed(cardFor(ui[item.key], item.mark))) {
      writeCard(item, { collapsed: false })
      return
    }
    pendingReveal.current = null
    activate(item.key)
    if (loadModeOf(item) === 'auto') loadNow(item.key)
    element.scrollIntoView?.({ block: 'start' })
  }, [revealTick, items, ui, writeCard, activate, loadNow])

  useEffect(() => {
    const scrollToTop = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    }
    const setScope = (commit: string | null) => {
      setScopeState((prev) => (prev === commit ? prev : commit))
    }
    const loadedHash = (path: string): string | null | undefined => {
      if (scopeRef.current !== null) return undefined
      const item = itemsRef.current.find((i) => i.path === path)
      const shown = item && sectionsRef.current[item.key]
      return shown && shown.status === 'loaded' && shown.diff ? diskHashOf(shown.diff) : undefined
    }
    return registerReviewView({ worktree, reveal, scrollToTop, setScope, loadedHash })
  }, [worktree, reveal])

  useEffect(
    () =>
      onSelectedPath(worktree, (path, origin) => {
        if (origin === 'panel' && path !== null && itemsRef.current.some((item) => item.path === path)) reveal(path)
      }),
    [worktree, reveal]
  )

  useEffect(() => {
    if (!scrollEl || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.width
      if (typeof next === 'number') setWidth(next)
    })
    observer.observe(scrollEl)
    return () => observer.disconnect()
  }, [scrollEl])

  const markItem = useCallback(
    async (item: ReviewItem) => {
      const path = item.path
      const reviewed = item.mark !== 'reviewed'
      setMarking((prev) => new Set(prev).add(path))
      try {
        const shown = sectionsRef.current[item.key]
        const expected = reviewed
          ? shown?.status === 'loaded' && shown.diff
            ? diskHashOf(shown.diff)
            : diskHashOf(await fetchDiff(context, worktree, { path, source: 'review', oldPath: item.oldPath, against: 'base' }))
          : undefined
        const result = await setReviewMark(context, { worktree, path, reviewed, ...(expected !== undefined ? { expected } : {}) })
        refresh()
        if (result === 'ok' && reviewed) {
          const next = nextToReview(reviewOrder(filesRef.current ?? [], viewModeRef.current), path)
          if (next !== null) {
            selectPath(worktree, next, 'review')
            reveal(next)
          }
        }
      } catch (e) {
        refresh()
        context.toast('Could not update the review mark', messageOf(e))
      } finally {
        setMarking((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [context, worktree, refresh, reveal]
  )

  const reach = (key: string, go: (pane: PaneHandle) => void) => {
    activate(key)
    const item = itemsRef.current.find((i) => i.key === key)
    if (item && isCollapsed(viewOfRef(item))) {
      pendingNav.current = { key, go }
      writeCard(item, { collapsed: false })
      return
    }
    const pane = handles.current.get(key)
    if (pane) go(pane)
  }

  useEffect(() => {
    const pending = pendingNav.current
    if (pending === null) return
    const item = items.find((i) => i.key === pending.key)
    if (!item) {
      pendingNav.current = null
      return
    }
    if (isCollapsed(cardFor(ui[item.key], item.mark))) return
    pendingNav.current = null
    const pane = handles.current.get(pending.key)
    if (pane) pending.go(pane)
  }, [items, ui])

  const navigate = (direction: 1 | -1) => {
    const keys = itemsRef.current.map((i) => i.key).filter((k) => (handles.current.get(k)?.changeCount() ?? 0) > 0)
    if (keys.length === 0) return
    const at = Math.max(0, keys.indexOf(activeRef.current ?? ''))
    const here = keys[at]
    const pane = handles.current.get(here)!
    const current = pane.currentChange()
    const count = pane.changeCount()
    if (direction > 0) {
      if (current === null) reach(here, (p) => p.goToChange(1))
      else if (current < count) reach(here, (p) => p.goToChange(current + 1))
      else reach(keys[(at + 1) % keys.length], (p) => p.goToChange(1))
    } else if (current === null) reach(here, (p) => p.goToChange(count))
    else if (current > 1) reach(here, (p) => p.goToChange(current - 1))
    else reach(keys[(at - 1 + keys.length) % keys.length], (p) => p.goToChange(p.changeCount()))
  }

  bind({
    nextChange: () => navigate(1),
    previousChange: () => navigate(-1),
    revertChange: () => {
      const keys = itemsRef.current.map((i) => i.key)
      const holdsCursor = (k: string) => handles.current.get(k)?.currentChange() != null
      const key = activeRef.current !== null && holdsCursor(activeRef.current) ? activeRef.current : keys.find(holdsCursor)
      if (key) handles.current.get(key)?.revertChange()
    },
    isDirty: () => false,
    collapseAll: (value) => setAllCollapsed(value ?? !allCollapsed),
    loadDiff: async (path) => {
      const matches = itemsRef.current.filter((i) => i.path === path)
      if (matches.length === 0) throw new Error(`No section for ${path}.`)
      await Promise.all(matches.map((i) => loader.current!.request(i.key, true)))
    }
  })

  const states = items.map((i) => paneStates[i.key] ?? IDLE)
  const active = (activeKey ? paneStates[activeKey] : undefined) ?? states.find((s) => s.changes > 0)
  const loadedPaths = items.filter((i) => sections[i.key]?.status === 'loaded').map((i) => i.path)
  const summary = JSON.stringify([states.map((s) => [s.changes, s.tooLarge]), active?.current ?? null, loadedPaths, items.length, allCollapsed])
  useEffect(() => {
    report({
      mode: 'review',
      source: null,
      path: null,
      area: null,
      commit: scope,
      changes: states.reduce((sum, s) => sum + s.changes, 0),
      currentChange: active?.current ?? null,
      dirty: false,
      stale: false,
      tooLarge: states.some((s) => s.tooLarge),
      sections: items.length,
      loadedSections: loadedPaths,
      collapsed: allCollapsed
    })
  }, [summary, scope, report])

  const layout = layoutFor(width, override)
  const paneSettings = useMemo(() => ({ ...settings, sideBySide: layout === 'side-by-side' }), [settings, layout])
  const scoped = scope !== null
  const sinceTitle = scoped
    ? plural(items.length, 'file')
    : model
      ? `${model.branch ?? 'HEAD'} vs ${model.base.name} · ${plural(model.counts.files, 'file')} · ${model.counts.reviewed} reviewed`
      : 'Review'
  const loadError = scoped ? commitError : model === null ? error : null
  const loading = scoped ? commitData?.scope !== scope && commitError === null : model === null && error === null
  const staleError = !scoped && model !== null ? error : null
  const notReady = !scoped && model && model.compare.status !== 'ready' ? (model.compare.message ?? null) : null

  return (
    <div className="git-review" data-review-tab>
      <SectionHeader
        title={
          <span className="git-review__heading">
            <span data-review-summary>{sinceTitle}</span>
            {scope !== null && <ScopeChip label={`Commit ${shortOid(commitData?.scope === scope ? commitData.commit : scope)}`} onRemove={() => setScopeState(null)} />}
          </span>
        }
        titleTooltip={sinceTitle}
        actions={
          <div className="git-review__actions">
            <Button onClick={() => setAllCollapsed(!allCollapsed)}>{allCollapsed ? 'Expand all' : 'Collapse all'}</Button>
            <IconButton
              label={layout === 'side-by-side' ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
              title={layout === 'side-by-side' ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
              onClick={() => setOverride(layout === 'side-by-side' ? 'inline' : 'side-by-side')}
            >
              {layout === 'side-by-side' ? '▤' : '▥'}
            </IconButton>
            <div title="More actions">
              <Menu
                label="More actions"
                trigger="⋯"
                items={[
                  { id: 'word-wrap', label: 'Word wrap', checked: settings.wrap, onAction: () => setSetting('diffWordWrap', !settings.wrap) },
                  {
                    id: 'show-whitespace',
                    label: 'Show whitespace',
                    checked: settings.showWhitespace,
                    onAction: () => setSetting('diffShowWhitespace', !settings.showWhitespace)
                  }
                ]}
              />
            </div>
          </div>
        }
      />
      <div className="git-review__scroll" data-review-scroll ref={setScrollEl}>
        {loadError !== null && items.length === 0 && <ErrorNotice message={loadError} subject="review" />}
        {staleError !== null && (
          <div role="alert" className="git-review__notice">
            Review may be out of date: {staleError} <Button onClick={refresh}>Retry</Button>
          </div>
        )}
        {loading && <p className="ui-text-muted git-review__notice">Loading diff...</p>}
        {notReady && <p className="ui-text-muted git-review__notice">{notReady}</p>}
        {!loading && loadError === null && items.length === 0 && (
          <EmptyState message={scoped ? 'No files in this commit' : `Nothing changed against ${model?.base.name ?? 'the base'}`} />
        )}
        {items.map((item) => {
          const view = viewOf(item)
          return (
            <ReviewCard
              key={item.key}
              context={context}
              worktree={worktree}
              item={item}
              data={sections[item.key] ?? { status: 'idle', revision: 0, against: 'base', signature: item.signature }}
              collapsed={isCollapsed(view)}
              full={view.full}
              scoped={scoped}
              active={activeKey === item.key}
              marking={marking.has(item.path)}
              root={scrollEl}
              settings={paneSettings}
              notes={notes}
              revealNote={noteTarget?.path === item.path ? noteTarget.noteId : undefined}
              register={register}
              onToggle={toggle}
              onMark={markItem}
              onFullDiff={showFullDiff}
              onLoad={loadNow}
              onVisible={onVisible}
              onActivate={activate}
              onPaneState={onPaneState}
              onPaneHandle={onPaneHandle}
              onReload={reloadCard}
              onSaved={onCardSaved}
            />
          )
        })}
      </div>
    </div>
  )
}
