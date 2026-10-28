export const SETUP_DISMISSED_KEY = 'quirky.orchestration.setupDismissed'
export const SETUP_STATUS_CHANGED_EVENT = 'quirky.orchestration.skill-status-changed'

export const ORCHESTRATION_EXAMPLES = [
  {
    title: 'Hand off an active task',
    prompt: 'Use /orchestration to hand off the active implementation task to a supervised worker. Keep the current session available for review, validate the result, and report any remaining work.'
  },
  {
    title: 'Hand off to another worktree',
    prompt: 'Use /orchestration to delegate this change to a worker in a separate worktree. Keep the current worktree untouched, ask for the exact files changed, and validate before accepting the report.'
  },
  {
    title: 'Run a phased workflow',
    prompt: 'Use /orchestration to plan this work as dependent phases. Start a phase only after its prerequisite Task is complete, review each worker_done report, and keep the coordinator responsible for integration.'
  },
  {
    title: 'Run independent work in parallel',
    prompt: 'Use /orchestration to split this work into independent Tasks and start the full worker wave before waiting. Track every Dispatch, review each report, and do not end while any worker is reclaimable.'
  },
  {
    title: 'Split a large change into smaller PRs',
    prompt: 'Use /orchestration to divide this large change into reviewable, dependency-aware Tasks that can become smaller PRs. Have workers report their branches, changes, and validation; keep final sequencing and merge decisions with the coordinator.'
  }
] as const

export type LatestRequestGuard = {
  next(): number
  isCurrent(token: number): boolean
  stop(): void
}

/** Ignore any async result that started before a newer request or after the view was unmounted. */
export function createLatestRequestGuard(): LatestRequestGuard {
  let generation = 0
  let stopped = false
  return {
    next() {
      generation += 1
      return generation
    },
    isCurrent(token) {
      return !stopped && token === generation
    },
    stop() {
      stopped = true
      generation += 1
    }
  }
}

export function isSetupDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SETUP_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissSetup(): void {
  try {
    globalThis.localStorage?.setItem(SETUP_DISMISSED_KEY, '1')
  } catch {
    // Keep the mounted overlay dismissible even when browser storage is unavailable.
  }
}

export function announceSetupStatusChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SETUP_STATUS_CHANGED_EVENT))
}
