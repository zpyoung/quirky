export type PaneAnnouncerOptions<S> = {
  read(pane: string): Promise<S>
  emit(pane: string, state: S): void
}

type Publication = { last?: string; reading: boolean; pending: boolean; generation: number }

/** Deduplicates pane publications and prevents overtaken reads from replacing newer state. */
export class PaneAnnouncer<S> {
  private readonly panes = new Map<string, Publication>()
  private stopped = false

  constructor(private readonly options: PaneAnnouncerOptions<S>) {}

  announce(pane: string): void {
    if (this.stopped || pane.length === 0) return
    const record = this.record(pane)
    if (record.reading) {
      record.pending = true
      return
    }
    void this.read(pane, record)
  }

  publishNow(pane: string, state: S): void {
    if (this.stopped || pane.length === 0) return
    const record = this.record(pane)
    record.generation++
    this.publish(pane, record, state)
    this.announce(pane)
  }

  retain(panes: ReadonlySet<string>): void {
    if (this.stopped) return
    for (const [pane, record] of this.panes) {
      if (panes.has(pane)) continue
      delete record.last
      record.generation++
      if (record.reading) record.pending = true
      else this.panes.delete(pane)
    }
  }

  stop(): void {
    this.stopped = true
    this.panes.clear()
  }

  private record(pane: string): Publication {
    let record = this.panes.get(pane)
    if (!record) {
      record = { reading: false, pending: false, generation: 0 }
      this.panes.set(pane, record)
    }
    return record
  }

  private publish(pane: string, record: Publication, state: S): void {
    const serialized = JSON.stringify(state)
    if (serialized === record.last) return
    record.last = serialized
    this.options.emit(pane, state)
  }

  private async read(pane: string, record: Publication): Promise<void> {
    record.reading = true
    record.pending = false
    const generation = record.generation
    try {
      const state = await this.options.read(pane)
      if (!this.stopped && generation === record.generation) this.publish(pane, record, state)
    } catch {
      delete record.last
      if (!record.pending) this.panes.delete(pane)
    } finally {
      record.reading = false
      if (!this.stopped && record.pending) void this.read(pane, record)
    }
  }
}
