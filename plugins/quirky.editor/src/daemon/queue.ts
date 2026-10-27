export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort()
    const releases: (() => void)[] = []
    const tails: { key: string; tail: Promise<void> }[] = []
    for (const key of ordered) {
      const previous = this.tails.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => { release = resolve })
      const tail = previous.then(() => current)
      this.tails.set(key, tail)
      await previous
      releases.push(release)
      tails.push({ key, tail })
    }

    try {
      return await work()
    } finally {
      for (const release of releases.reverse()) release()
      for (const { key, tail } of tails) {
        void tail.then(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key)
        })
      }
    }
  }
}
