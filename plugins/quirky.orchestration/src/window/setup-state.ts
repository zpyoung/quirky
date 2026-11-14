export const SETUP_DISMISSED_KEY = 'quirky.orchestration.setupDismissed'
export const ORCHESTRATION_INSTALL_COMMAND = 'quirky orchestration skill-install'

export const ORCHESTRATION_EXAMPLES = [
  {
    id: 'hand-off-active-task',
    title: 'Hand off an active task',
    prompt: 'Use /orchestration to hand off the active implementation task to a supervised worker. Keep the current session available for review, validate the result, and report any remaining work.'
  },
  {
    id: 'hand-off-to-worktree',
    title: 'Hand off to another worktree',
    prompt: 'Use /orchestration to delegate this change to a worker in a separate worktree. Keep the current worktree untouched, ask for the exact files changed, and validate before accepting the report.'
  },
  {
    id: 'phased-workflow',
    title: 'Run a phased workflow',
    prompt: 'Use /orchestration to plan this work as dependent phases. Start a phase only after its prerequisite Task is complete, review each worker_done report, and keep the coordinator responsible for integration.'
  },
  {
    id: 'parallel-work',
    title: 'Run independent work in parallel',
    prompt: 'Use /orchestration to split this work into independent Tasks and start the full worker wave before waiting. Track every Dispatch, review each report, and do not end while any worker is reclaimable.'
  },
  {
    id: 'split-large-change',
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

export type OrchestrationExampleId = (typeof ORCHESTRATION_EXAMPLES)[number]['id']

export type SetupSignal = { emit(): void; subscribe(listener: () => void): () => void }
export type SetupSignals = { statusChanged: SetupSignal; dismissed: SetupSignal }

function createSignal(): SetupSignal {
  const listeners = new Set<() => void>()
  return {
    emit() { for (const listener of [...listeners]) listener() },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}

export function createSetupSignals(): SetupSignals {
  return { statusChanged: createSignal(), dismissed: createSignal() }
}

export function examplePrompt(args: unknown): string {
  const id = typeof args === 'object' && args !== null && 'example' in args ? args.example : undefined
  const example = ORCHESTRATION_EXAMPLES.find((entry) => entry.id === id)
  if (!example) throw new Error(`Unknown orchestration example: ${String(id)}`)
  return example.prompt
}

export async function copyText(text: string): Promise<{ copied: true }> {
  if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard access is not available in this window.')
  await globalThis.navigator.clipboard.writeText(text)
  return { copied: true }
}
