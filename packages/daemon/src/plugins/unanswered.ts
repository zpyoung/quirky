export const MAX_UNANSWERED_HANDLERS = 4

export type UnansweredOptions = {
  /** Ensures the warning is present without duplicating it. */
  warn(pluginId: string, message: string): void
  unwarn(pluginId: string, message: string): void
}

type WarningAction = { kind: 'warn' | 'unwarn'; pluginId: string; message: string }

function boundWarning(contributionId: string): string {
  return `${contributionId} has ${MAX_UNANSWERED_HANDLERS} or more handlers that never finished; it will not run again until fewer than ${MAX_UNANSWERED_HANDLERS} remain or the daemon restarts`
}

type HandlerWarning = { pluginId: string; message: string; active: boolean }

export class UnansweredHandlers {
  private readonly counts = new Map<string, number>()
  private readonly warningReferences = new Map<string, Map<string, number>>()
  private readonly boundRecipients = new Map<string, Set<string>>()
  private readonly handlerWarnings = new Map<string, Set<HandlerWarning>>()

  constructor(private readonly options?: UnansweredOptions) {}

  count(contributionId: string): number {
    return this.counts.get(contributionId) ?? 0
  }

  /** True at the bound, and then makes sure the plugin carries the bound warning. */
  blocked(contributionId: string, pluginId: string): boolean {
    if (this.count(contributionId) < MAX_UNANSWERED_HANDLERS) return false
    const actions: WarningAction[] = []
    this.ensureBoundWarning(contributionId, pluginId, actions)
    this.applyWarningActions(actions)
    return true
  }

  /** Retires revoked handlers' warnings without releasing their unanswered counts or bound warnings. */
  clearHandlerWarnings(contributionId: string): void {
    const warnings = this.handlerWarnings.get(contributionId)
    if (!warnings) return
    const actions: WarningAction[] = []
    for (const warning of warnings) this.releaseHandlerWarning(contributionId, warning, actions)
    this.applyWarningActions(actions)
  }

  /** Counts one handler and returns a release that is safe to call more than once. */
  add(contributionId: string, pluginId: string, warning?: string): () => void {
    const previous = this.count(contributionId)
    const current = previous + 1
    this.counts.set(contributionId, current)

    const actions: WarningAction[] = []
    let handlerWarning: HandlerWarning | undefined
    if (warning !== undefined) {
      handlerWarning = { pluginId, message: warning, active: true }
      let warnings = this.handlerWarnings.get(contributionId)
      if (!warnings) {
        warnings = new Set()
        this.handlerWarnings.set(contributionId, warnings)
      }
      warnings.add(handlerWarning)
      this.adjustWarning(pluginId, warning, 1, actions)
    }
    if (current >= MAX_UNANSWERED_HANDLERS) {
      this.ensureBoundWarning(contributionId, pluginId, actions)
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
      if (handlerWarning) this.releaseHandlerWarning(contributionId, handlerWarning, releaseActions)
      if (previousCount >= MAX_UNANSWERED_HANDLERS && currentCount < MAX_UNANSWERED_HANDLERS) {
        const recipients = this.boundRecipients.get(contributionId)
        this.boundRecipients.delete(contributionId)
        for (const recipient of recipients ?? []) {
          this.adjustWarning(recipient, boundWarning(contributionId), -1, releaseActions)
        }
      }
      this.applyWarningActions(releaseActions)
    }
  }

  private releaseHandlerWarning(contributionId: string, warning: HandlerWarning, actions: WarningAction[]): void {
    if (!warning.active) return
    warning.active = false
    const warnings = this.handlerWarnings.get(contributionId)
    warnings?.delete(warning)
    if (warnings?.size === 0) this.handlerWarnings.delete(contributionId)
    this.adjustWarning(warning.pluginId, warning.message, -1, actions)
  }

  private ensureBoundWarning(contributionId: string, pluginId: string, actions: WarningAction[]): void {
    let recipients = this.boundRecipients.get(contributionId)
    if (!recipients) {
      recipients = new Set()
      this.boundRecipients.set(contributionId, recipients)
    }
    if (recipients.has(pluginId)) {
      actions.push({ kind: 'warn', pluginId, message: boundWarning(contributionId) })
    } else {
      recipients.add(pluginId)
      this.adjustWarning(pluginId, boundWarning(contributionId), 1, actions)
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
      actions.push({ kind: 'warn', pluginId, message })
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
