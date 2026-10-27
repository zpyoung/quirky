export type CooldownOptions = {
  windowMs?: number
  maxKeys?: number
  now?: () => number
}

/**
 * Suppresses repeat banners per key (a worktree id, or `'global'` when there is none) for a fixed
 * window after the last delivery. Remembers at most `maxKeys` keys, dropping the oldest.
 */
export class Cooldown {
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly last = new Map<string, number>()

  constructor(opts: CooldownOptions = {}) {
    this.windowMs = opts.windowMs ?? 5000
    this.maxKeys = opts.maxKeys ?? 50
    this.now = opts.now ?? Date.now
  }

  /** True when `key` had a delivery less than the window ago. */
  check(key: string): boolean {
    const at = this.last.get(key)
    return at !== undefined && this.now() - at < this.windowMs
  }

  /** Records a delivery for `key` now. */
  reserve(key: string): void {
    this.last.delete(key)
    this.last.set(key, this.now())
    while (this.last.size > this.maxKeys) {
      const oldest = this.last.keys().next().value
      if (oldest === undefined) break
      this.last.delete(oldest)
    }
  }
}
