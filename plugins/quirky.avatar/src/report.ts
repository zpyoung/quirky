import type {
  AvatarApp, AvatarBusEvent, AvatarWorktreeStatus, JournalEntry, NeedsYouItem, ReportModel, ReportNeed, ReportService, SwitchId, WorktreeState
} from './contracts'

const CHANGE_DEBOUNCE_MS = 250
const RECENT_HANDBACK_MS = 24 * 60 * 60 * 1000
const TOP_SKIPPED_CALLS = 10
const SWITCH_ORDER: readonly SwitchId[] = ['messaging', 'historyRewrite', 'deploys']

const ACTIVE_WORK_STATES: ReadonlySet<WorktreeState> = new Set(['checking', 'briefing', 'working', 'checking-done', 'in-review'])

const STATE_PHRASES: Record<WorktreeState, string> = {
  checking: 'Checking that the gate reaches the agent.',
  'gate-failed': 'The gate check failed, so the worker is waiting for a restart.',
  briefing: 'Briefing the worker.',
  working: 'Working.',
  'waiting-on-you': 'Waiting on you.',
  'checking-done': 'Running the done-when check.',
  'in-review': 'In review.',
  'merge-ready': 'Meets the merge bar.',
  merged: 'Merged.',
  'pr-ready': 'Pull request ready.',
  committed: 'Committed.',
  parked: 'Parked.',
  done: 'Done.'
}

/** True while a worktree in `state` has agent work in flight, which is when the Mac is held awake. */
export function isActiveWork(state: WorktreeState): boolean {
  return ACTIVE_WORK_STATES.has(state)
}

function sentence(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function wouldHaveBeenStopped(entry: JournalEntry): boolean {
  const outcome = entry.data.outcome
  return entry.data.wouldHaveStopped === true || outcome === 'deny' || outcome === 'held'
}

/**
 * Installs `ReportService` as `app.services.report`: the needs-you-first report, the pill and
 * panel status, and the sidebar status. It also emits `changed` after every bus event, coalesced
 * to one emit per 250 ms, so open views refresh without polling. Returns its disposer.
 */
export function register(app: AvatarApp): () => void {
  const names = new Map<string, { name: string; projectName: string }>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastEvent: AvatarBusEvent | null = null
  let disposed = false

  const nameOf = (worktreeId: string): string => names.get(worktreeId)?.name ?? worktreeId
  const projectOf = (worktreeId: string): string => names.get(worktreeId)?.projectName ?? ''

  async function refreshNames(): Promise<void> {
    try {
      for (const row of await app.services.handoff.eligibility()) names.set(row.worktreeId, { name: row.name, projectName: row.projectName ?? '' })
    } catch (error) {
      app.context.log(`avatar report could not refresh worktree names: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function openNeeds(): NeedsYouItem[] {
    return app.needs.list({ open: true }).sort((a, b) => a.createdAt - b.createdAt)
  }

  function status(): ReturnType<ReportService['status']> {
    return {
      handoffs: app.services.handoff.active().map((handoff) => ({
        worktreeId: handoff.worktreeId,
        name: nameOf(handoff.worktreeId),
        projectName: projectOf(handoff.worktreeId),
        state: handoff.state,
        level: handoff.mandate.level
      })),
      needsYouCount: openNeeds().length
    }
  }

  function sidebarStatus(): Record<string, AvatarWorktreeStatus> {
    const open = openNeeds()
    const result: Record<string, AvatarWorktreeStatus> = {}
    for (const handoff of app.services.handoff.active()) {
      result[handoff.worktreeId] = {
        state: handoff.state,
        level: handoff.mandate.level,
        needsYou: open.filter((need) => need.worktreeId === handoff.worktreeId).length
      }
    }
    return result
  }

  function report(): ReportModel {
    const now = app.now()
    const open = openNeeds()
    const active = app.services.handoff.active()
    const activeIds = new Set(active.map((handoff) => handoff.worktreeId))
    const handedBack = app.store.handoffs
      .list({ active: false })
      .filter((row) => !activeIds.has(row.worktreeId) && row.takenBackAt !== null && now - row.takenBackAt <= RECENT_HANDBACK_MS)
      .sort((a, b) => (b.takenBackAt ?? 0) - (a.takenBackAt ?? 0))

    const switchesOf = (worktreeId: string): SwitchId[] => {
      const switches = app.store.mandates.get(worktreeId)?.switches
      return switches === undefined ? [] : SWITCH_ORDER.filter((id) => switches[id])
    }

    const stories: ReportModel['stories'] = []
    for (const handoff of active) {
      const mine = open.filter((need) => need.worktreeId === handoff.worktreeId)
      const parkedStory = mine.map((need) => need.detail.story).find((story): story is string => typeof story === 'string' && story !== '')
      const phrase = handoff.state === 'parked' && parkedStory !== undefined ? parkedStory : STATE_PHRASES[handoff.state]
      const waiting = mine.length === 0 ? '' : `${mine.length} ${mine.length === 1 ? 'item needs' : 'items need'} you.`
      stories.push({
        worktreeId: handoff.worktreeId,
        name: nameOf(handoff.worktreeId),
        projectName: projectOf(handoff.worktreeId),
        switchesOn: SWITCH_ORDER.filter((id) => handoff.mandate.switches[id]),
        story: [sentence(handoff.mandate.goal), sentence(phrase), waiting].filter((part) => part !== '').join(' '),
        handedBackWith: []
      })
    }
    for (const row of handedBack) {
      const handedBackWith = app.needs
        .list({ worktreeId: row.worktreeId, open: false })
        .filter((need) => need.resolution === 'handed-back')
        .map((need) => need.title)
      const goal = app.store.mandates.get(row.worktreeId)?.goal
      stories.push({
        worktreeId: row.worktreeId,
        name: nameOf(row.worktreeId),
        projectName: projectOf(row.worktreeId),
        switchesOn: switchesOf(row.worktreeId),
        story: [goal === undefined ? '' : sentence(goal), 'Handed back to you. The avatar no longer decides for it.'].filter((part) => part !== '').join(' '),
        handedBackWith
      })
    }

    const since = Math.min(...active.map((handoff) => app.store.handoffs.get(handoff.worktreeId)?.handedOffAt ?? now), ...handedBack.map((row) => row.handedOffAt), now)
    const journal = stories.length === 0 ? [] : app.store.journalSince(0).filter((entry) => entry.at >= since)

    let allowed = 0
    let denied = 0
    let held = 0
    let guesses = 0
    const sleeps: ReportModel['summary']['sleeps'] = []
    const skipped: JournalEntry[] = []
    for (const entry of journal) {
      if (entry.kind === 'gate') {
        if (entry.data.outcome === 'allow') allowed += 1
        else if (entry.data.outcome === 'deny') denied += 1
        else if (entry.data.outcome === 'held') held += 1
      } else if (entry.kind === 'guess') guesses += 1
      else if (entry.kind === 'sleep') sleeps.push({ at: entry.at, durationMs: typeof entry.data.durationMs === 'number' ? entry.data.durationMs : 0 })
      else if (entry.kind === 'skipped-call' && entry.worktreeId !== null && activeIds.has(entry.worktreeId) && wouldHaveBeenStopped(entry)) skipped.push(entry)
    }

    return {
      needsYou: open.map((need): ReportNeed => ({ ...need, worktreeName: nameOf(need.worktreeId), projectName: projectOf(need.worktreeId) })),
      stories,
      summary: {
        decisions: allowed + denied + held + guesses,
        allowed,
        denied,
        held,
        guesses,
        sleeps,
        keptAwake: active.some((handoff) => isActiveWork(handoff.state))
      },
      topSkippedCalls: skipped.sort((a, b) => b.seq - a.seq).slice(0, TOP_SKIPPED_CALLS)
    }
  }

  app.services.report = { report, status, sidebarStatus }
  void refreshNames()

  const unsubscribe = app.on((event) => {
    if (event.type === 'handoffs-changed' || event.type === 'state-changed') void refreshNames()
    lastEvent = event
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void refreshNames().then(() => {
        if (disposed || lastEvent === null) return
        app.context.emit('changed', { type: lastEvent.type })
      })
    }, CHANGE_DEBOUNCE_MS)
  })

  return () => {
    disposed = true
    unsubscribe()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}
