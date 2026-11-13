export const MAX_UNANSWERED_HANDLERS = 4

export type UnansweredOptions = {
  warn(pluginId: string, message: string): void
  unwarn(pluginId: string, message: string): void
}

type WarningAction = { kind: 'warn' | 'unwarn'; pluginId: string; message: string }

function boundWarning(contributionId: string): string {
  return `${contributionId} has ${MAX_UNANSWERED_HANDLERS} or more handlers that never finished; it will not run again until fewer than ${MAX_UNANSWERED_HANDLERS} remain or the daemon restarts`
}

export class UnansweredHandlers {
  private readonly counts = new Map<string, number>()
  private readonly warningReferences = new Map<string, Map<string, number>>()

  constructor(private readonly options?: UnansweredOptions) {}

  count(contributionId: string): number {
    return this.counts.get(contributionId) ?? 0
  }

  /** True at the bound, and then makes sure the plugin carries the bound warning. */
  blocked(contributionId: string, pluginId: string): boolean {
    if (this.count(contributionId) < MAX_UNANSWERED_HANDLERS) return false
    this.options?.warn(pluginId, boundWarning(contributionId))
    return true
  }

  /** Counts one handler and returns a release that is safe to call more than once. */
  add(contributionId: string, pluginId: string, warning?: string): () => void {
    const previous = this.count(contributionId)
    const current = previous + 1
    this.counts.set(contributionId, current)

    const actions: WarningAction[] = []
    if (warning !== undefined) this.adjustWarning(pluginId, warning, 1, actions)
    if (previous < MAX_UNANSWERED_HANDLERS && current >= MAX_UNANSWERED_HANDLERS) {
      this.adjustWarning(pluginId, boundWarning(contributionId), 1, actions)
    }
    this.applyWarningActions(actions)

    let released = false
    return () => {
      if (released) return
      released = true

      const previousCount = this.count(contributionId)
      const currentCount = previousCount - 1
      if (currentCount === 0) this.counts.delete(contributionId)
      else this.counts.set(contributionId, currentCount)

      const releaseActions: WarningAction[] = []
      if (warning !== undefined) this.adjustWarning(pluginId, warning, -1, releaseActions)
      if (previousCount >= MAX_UNANSWERED_HANDLERS && currentCount < MAX_UNANSWERED_HANDLERS) {
        this.adjustWarning(pluginId, boundWarning(contributionId), -1, releaseActions)
      }
      this.applyWarningActions(releaseActions)
    }
  }

  private adjustWarning(pluginId: string, message: string, change: 1 | -1, actions: WarningAction[]): void {
    let messages = this.warningReferences.get(pluginId)
    const references = messages?.get(message) ?? 0
    if (change === 1) {
      if (messages === undefined) {
        messages = new Map()
        this.warningReferences.set(pluginId, messages)
      }
      messages.set(message, references + 1)
      if (references === 0) actions.push({ kind: 'warn', pluginId, message })
      return
    }

    if (references <= 1) {
      messages?.delete(message)
      if (messages?.size === 0) this.warningReferences.delete(pluginId)
      if (references === 1) actions.push({ kind: 'unwarn', pluginId, message })
      return
    }
    messages!.set(message, references - 1)
  }

  private applyWarningActions(actions: WarningAction[]): void {
    for (const action of actions) {
      if (action.kind === 'warn') this.options?.warn(action.pluginId, action.message)
      else this.options?.unwarn(action.pluginId, action.message)
    }
  }
}
