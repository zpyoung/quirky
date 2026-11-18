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
  withHeld,
  type CardUi,
  type DiffLayout,
  type ReviewItem
} from './review-layout'
import type { ModeProps } from './types'

const IDLE: PaneState = { changes: 0, current: null, dirty: false, stale: false, tooLarge: false }
const NO_ITEMS: readonly ReviewItem[] = []

type CommitFiles = { scope: string; commit: string; entries: GitChange[] }

/**
 * What a card owes the disk. `wanted` grows with every event that may have changed the file and
 * `loaded` is the `wanted` the shown diff was requested at, so a card is current exactly when the
 * two are equal. `stamp` is the signature and side `wanted` last grew for.
 */
type CardVersion = { wanted: number; loaded: number; stamp: string }

/** The disk-side hash `setReviewMark` checks: null when the diff shows the file deleted, undefined when the diff carries none. */
const diskHashOf = (diff: GitDiff): string | null | undefined => (diff.modifiedDeleted === true ? null : diff.modifiedHash)

/** Whether `fresh` has a different disk side than `held`, as opposed to only a different original. */
const diskMoved = (held: GitDiff, fresh: GitDiff): boolean => held.modifiedHash !== fresh.modifiedHash || held.modifiedDeleted !== fresh.modifiedDeleted

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
  const versions = useRef(new Map<string, CardVersion>())
  const loops = useRef(new Map<string, Promise<void>>())
  const forced = useRef(new Set<string>())
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
  const modelItems = useMemo<readonly ReviewItem[]>(() => {
    if (scope !== null) {
      if (commitData?.scope !== scope) return NO_ITEMS
      return orderChanges(commitData.entries, viewMode).map((change) => itemFromChange(change, commitData.commit, noteCounts.get(change.path) ?? 0))
    }
    return files === undefined ? NO_ITEMS : reviewOrder(files, viewMode).map(itemFromFile)
  }, [scope, commitData, files, viewMode, noteCounts])
  // a card with unsaved edits stays, from its last item and where it last sat, after its file leaves the model
  const lastItems = useRef<{ scope: string | null; items: readonly ReviewItem[] }>({ scope, items: NO_ITEMS })
  const items = useMemo<readonly ReviewItem[]>(() => {
    const previous = lastItems.current
    let next = modelItems
    if (previous.scope === scope) {
      const listed = new Set(modelItems.map((item) => item.key))
      const held = previous.items.filter((item) => !listed.has(item.key) && (handles.current.get(item.key)?.isDirty() ?? paneStates[item.key]?.dirty === true))
      if (held.length > 0) next = withHeld(modelItems, previous.items, held)
    }
    if (next.length === previous.items.length && next.every((item, n) => item === previous.items[n])) next = previous.items
    lastItems.current = { scope, items: next }
    return next
  }, [modelItems, scope, paneStates])
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

  const commitRef = useRef(commitData)
  commitRef.current = commitData

  const diffFor = (item: ReviewItem, against: 'base' | 'reviewed') => {
    const commit = commitRef.current
    return scopeRef.current !== null && commit
      ? fetchDiff(context, worktree, { path: item.path, source: 'commit', oldPath: item.oldPath, commit: commit.commit })
      : fetchDiff(context, worktree, { path: item.path, source: 'review', oldPath: item.oldPath, against })
  }

  const versionOf = (item: ReviewItem): CardVersion => {
    let version = versions.current.get(item.key)
    if (!version) {
      version = { wanted: 1, loaded: 0, stamp: `${item.signature}|${bodyAgainst(viewOfRef(item))}` }
      versions.current.set(item.key, version)
    }
    return version
  }

  /**
   * The card's single read loop. While the shown diff is older than `wanted` and the card is open
   * (or the read was asked for by name) it reads, shows the result and records what it was read
   * at; an invalidation that lands mid-read only raises `wanted`, which the next check sees. A
   * failed read leaves `loaded` alone so any later expansion, refresh or Retry reads again. A card
   * with unsaved edits keeps its diff and pane: a read whose disk side moved marks the pane stale,
   * one that differs only in its original or fails changes nothing and leaves `loaded` behind, so
   * the card reads again once the draft is saved or dropped.
   */
  const readLoop = async (key: string): Promise<void> => {
    try {
      for (;;) {
        const item = itemsRef.current.find((i) => i.key === key)
        const section = sectionsRef.current[key]
        if (!item || !section) return
        const version = versionOf(item)
        if (section.status === 'loaded' && version.loaded >= version.wanted) return
        if (!forced.current.has(key) && isCollapsed(viewOfRef(item))) return
        const target = version.wanted
        const against = bodyAgainst(viewOfRef(item))
        const before = section.diff
        if (section.status === 'idle' || (section.status === 'error' && forced.current.has(key))) patchSection(key, { status: 'loading' })
        // the side or scope can change mid-read, so a reply for another one is dropped and the read repeats
        const superseded = () => {
          const latest = itemsRef.current.find((i) => i.key === key)
          return !latest || bodyAgainst(viewOfRef(latest)) !== against
        }
        let diff: GitDiff
        try {
          diff = await diffFor(item, against)
        } catch (e) {
          if (superseded() || versionOf(item).wanted > target) continue
          if (handles.current.get(key)?.isDirty()) return
          patchSection(key, { status: 'error', error: messageOf(e) })
          return
        }
        const latest = itemsRef.current.find((i) => i.key === key)
        const now = sectionsRef.current[key]
        if (!latest || !now || superseded() || now.diff !== before) continue
        if (now.status === 'loaded' && now.diff) {
          const reused = reuseGitDiff(now.diff, diff)
          const pane = handles.current.get(key)
          if (reused !== now.diff && pane?.isDirty()) {
            // only the compared side moved: nothing changed under the draft, so the read waits for it to be saved or dropped
            if (!diskMoved(now.diff, diff)) return
            pane.markStale()
          } else patchSection(key, { against, signature: latest.signature, ...(reused === now.diff ? {} : { diff: reused, revision: now.revision + 1 }) })
        } else {
          patchSection(key, { status: 'loaded', diff, error: undefined, revision: now.revision + 1, against, signature: latest.signature })
        }
        const done = versionOf(latest)
        done.loaded = Math.max(done.loaded, target)
      }
    } finally {
      loops.current.delete(key)
      forced.current.delete(key)
    }
  }

  /** Resolves once the card's loop has run out of work. `force` reads even if the card is folded. */
  const readCard = (key: string, force = false): Promise<void> => {
    if (force) forced.current.add(key)
    const running = loops.current.get(key)
    if (running) return running
    let done!: () => void
    const promise = new Promise<void>((resolve) => (done = resolve))
    loops.current.set(key, promise)
    void readLoop(key).finally(done)
    return promise
  }
  const readCardRef = useRef(readCard)
  readCardRef.current = readCard
  const loader = useRef<SectionLoader | null>(null)
  if (loader.current === null) loader.current = new SectionLoader((key) => readCardRef.current(key, true))
  useEffect(() => () => loader.current?.clear(), [])

  /** Reads an expanded card that has been requested before and is behind the disk; folded and never-requested cards wait. */
  const catchUp = (key: string) => {
    const item = itemsRef.current.find((i) => i.key === key)
    const section = sectionsRef.current[key]
    if (!item || !section || section.status === 'idle' || scopeRef.current !== null || isCollapsed(viewOfRef(item))) return
    const version = versionOf(item)
    if (section.status === 'loaded' && version.loaded >= version.wanted) return
    void readCard(key)
  }

  const onCardSaved = (key: string, content: string, hash: string) => {
    const diff = sectionsRef.current[key]?.diff
    if (diff) patchSection(key, { diff: { ...diff, modified: content, modifiedHash: hash } })
  }

  const reloadCard = async (key: string): Promise<void> => {
    const item = itemsRef.current.find((i) => i.key === key)
    if (!item) return
    const target = ++versionOf(item).wanted
    const against = bodyAgainst(viewOfRef(item))
    const diff = await diffFor(item, against)
    patchSection(key, { status: 'loaded', diff, error: undefined, revision: (sectionsRef.current[key]?.revision ?? 0) + 1, against, signature: item.signature })
    const version = versionOf(item)
    version.loaded = Math.max(version.loaded, target)
    catchUp(key)
  }

  useEffect(() => {
    const kept: Record<string, CardData> = {}
    for (const item of items) {
      kept[item.key] = sectionsRef.current[item.key] ?? { status: 'idle', revision: 0, against: 'base', signature: item.signature }
    }
    const same = Object.keys(kept).length === Object.keys(sectionsRef.current).length && Object.keys(kept).every((k) => sectionsRef.current[k] === kept[k])
    if (!same) commitSections(kept)
    for (const key of [...versions.current.keys()]) if (!kept[key]) versions.current.delete(key)
    for (const key of [...handles.current.keys()]) if (!kept[key]) handles.current.delete(key)
    const gone = Object.keys(paneStatesRef.current).filter((key) => !kept[key])
    if (gone.length > 0) {
      const remaining = { ...paneStatesRef.current }
      for (const key of gone) delete remaining[key]
      paneStatesRef.current = remaining
      setPaneStates(remaining)
    }
    setUi((prev) => reconcileCards(prev, items))
  }, [items])

  useEffect(() => {
    const listed = new Set(modelItems.map((item) => item.key))
    for (const item of items) if (!listed.has(item.key)) handles.current.get(item.key)?.markStale()
  }, [items, modelItems])

  useEffect(() => {
    const expanded = items.filter((item) => !isCollapsed(cardFor(ui[item.key], item.mark)))
    const eager = typeof IntersectionObserver === 'undefined' ? expanded : expanded.slice(0, EAGER_SECTIONS)
    for (const item of eager) {
      if (loadModeOf(item) === 'auto' && sectionsRef.current[item.key]?.status === 'idle') void loader.current?.request(item.key)
    }
    if (scope !== null) return
    for (const item of items) {
      const version = versionOf(item)
      const stamp = `${item.signature}|${bodyAgainst(cardFor(ui[item.key], item.mark))}`
      if (version.stamp !== stamp) {
        version.stamp = stamp
        version.wanted++
      }
    }
    for (const item of expanded) catchUp(item.key)
  }, [items, ui, scope])

  useRefreshTriggers(
    context,
    () => {
      if (scope !== null) return
      for (const item of itemsRef.current) {
        versionOf(item).wanted++
        catchUp(item.key)
      }
    },
    null,
    worktree
  )

  const loadNow = (key: string) => {
    const item = itemsRef.current.find((i) => i.key === key)
    if (item && sectionsRef.current[key]?.status === 'error') versionOf(item).wanted++
    void loader.current!.request(key, true)
  }
  const loadNowRef = useRef(loadNow)
  loadNowRef.current = loadNow
  const loadCard = useCallback((key: string) => loadNowRef.current(key), [])
  const onVisible = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key)
    if (item && loadModeOf(item) === 'auto' && !isCollapsed(cardFor(uiRef.current[key], item.mark))) void loader.current?.request(key)
  }, [])

  const catchUpRef = useRef(catchUp)
  catchUpRef.current = catchUp
  const onPaneState = useCallback((key: string, state: PaneState) => {
    const current = paneStatesRef.current[key]
    if (current && JSON.stringify(current) === JSON.stringify(state)) return
    paneStatesRef.current = { ...paneStatesRef.current, [key]: state }
    setPaneStates(paneStatesRef.current)
    if (current?.dirty && !state.dirty) catchUpRef.current(key)
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
    if (loadModeOf(item) === 'auto') loadCard(item.key)
    element.scrollIntoView?.({ block: 'start' })
  }, [revealTick, items, ui, writeCard, activate, loadCard])

  const askingScope = useRef(false)
  /** Shows `commit`'s files (or the worktree review for null), first asking whether to discard the unsaved edits it would drop. */
  const changeScope = async (commit: string | null): Promise<void> => {
    if (commit === scopeRef.current || askingScope.current) return
    const edited = itemsRef.current.filter((item) => handles.current.get(item.key)?.isDirty()).length
    if (edited > 0) {
      askingScope.current = true
      let discard = false
      try {
        discard = await context.confirm({
          title: `Discard unsaved edits in ${plural(edited, 'file')}?`,
          body: 'Showing another scope closes these cards, and their edits are lost.',
          confirmLabel: 'Discard'
        })
      } finally {
        askingScope.current = false
      }
      if (!discard) {
        pendingReveal.current = null
        return
      }
    }
    setScopeState(commit)
  }
  const changeScopeRef = useRef(changeScope)
  changeScopeRef.current = changeScope

  useEffect(() => {
    const scrollToTop = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    }
    const setScope = (commit: string | null) => void changeScopeRef.current(commit).catch(() => undefined)
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

  /** The pane holding a draft the disk has moved on from: the active card's when it is one, else the first. */
  const staleCard = (): PaneHandle | undefined => {
    const stale = (key: string) => paneStatesRef.current[key]?.stale === true
    const active = activeRef.current
    const key = active !== null && stale(active) ? active : itemsRef.current.find((item) => stale(item.key))?.key
    return key === undefined ? undefined : handles.current.get(key)
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
    isDirty: () => itemsRef.current.some((item) => handles.current.get(item.key)?.isDirty()),
    save: async () => {
      for (const item of itemsRef.current) {
        const pane = handles.current.get(item.key)
        if (!pane?.isDirty()) continue
        await pane.save()
        if (pane.isDirty()) return
      }
    },
    reloadFromDisk: () => staleCard()?.reload() ?? Promise.resolve(),
    overwrite: () => staleCard()?.overwrite() ?? Promise.resolve(),
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
  const summary = JSON.stringify([states.map((s) => [s.changes, s.tooLarge, s.dirty, s.stale]), active?.current ?? null, loadedPaths, items.length, allCollapsed])
  useEffect(() => {
    report({
      mode: 'review',
      source: null,
      path: null,
      area: null,
      commit: scope,
      changes: states.reduce((sum, s) => sum + s.changes, 0),
      currentChange: active?.current ?? null,
      dirty: states.some((s) => s.dirty),
      stale: states.some((s) => s.stale),
      tooLarge: states.some((s) => s.tooLarge),
      sections: items.length,
      loadedSections: loadedPaths,
      collapsed: allCollapsed
    })
  }, [summary, scope, report])

  const layout = layoutFor(width, override)
  const paneSettings = useMemo(() => ({ ...settings, sideBySide: layout === 'side-by-side' }), [settings, layout])
  const scoped = scope !== null
  const compared = model ? `${model.branch ?? 'HEAD'} vs ${model.base.name}` : null
  const sinceTitle = scoped
    ? [compared, plural(items.length, 'file')].filter(Boolean).join(' · ')
    : model
      ? `${compared} · ${plural(model.counts.files, 'file')} · ${model.counts.reviewed} reviewed`
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
            <span className="git-review__summary" data-review-summary title={sinceTitle}>
              {sinceTitle}
            </span>
            {scope !== null && <ScopeChip label={`Commit ${shortOid(commitData?.scope === scope ? commitData.commit : scope)}`} onRemove={() => void changeScope(null)} />}
          </span>
        }
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
              dirty={paneStates[item.key]?.dirty === true}
              root={scrollEl}
              settings={paneSettings}
              notes={notes}
              revealNote={noteTarget?.path === item.path ? noteTarget.noteId : undefined}
              register={register}
              onToggle={toggle}
              onMark={markItem}
              onFullDiff={showFullDiff}
              onLoad={loadCard}
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
