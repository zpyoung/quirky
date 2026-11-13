export const DEFAULT_MAX_RUNNING_HANDLERS = 1024

export type RunningOptions = {
  /** Ensures the warning is present without duplicating it. */
  warn(pluginId: string, message: string): void
  unwarn(pluginId: string, message: string): void
  log?(message: string): void
}

type WarningEpisode = {
  pluginId: string
  message: string
  limit: number
  refused: number
}

export class RunningHandlers {
  private readonly counts = new Map<string, number>()
  private readonly warningEpisodes = new Map<string, WarningEpisode>()

  constructor(private readonly options?: RunningOptions) {}

  count(contributionId: string): number {
    return this.counts.get(contributionId) ?? 0
  }

  /** Takes a slot or refuses at the limit, clearing its warning once the count reaches half. */
  enter(contributionId: string, pluginId: string, limit: number): (() => void) | null {
    const previousCount = this.count(contributionId)
    if (previousCount >= limit) {
      let episode = this.warningEpisodes.get(contributionId)
      if (episode) {
        episode.refused++
      } else {
        const message = `${contributionId} has reached its limit of ${limit} running handlers; calls over the limit are refused`
        episode = { pluginId, message, limit, refused: 1 }
        this.warningEpisodes.set(contributionId, episode)
        const method = contributionId.startsWith('method:') ? contributionId.slice('method:'.length) : contributionId
        this.options?.log?.(`method ${method} in ${pluginId} has reached its limit of ${limit} running handlers; refusing calls over the limit`)
      }
      this.options?.warn(pluginId, episode.message)
      return null
    }

    this.counts.set(contributionId, previousCount + 1)
    let released = false
    return () => {
      if (released) return
      released = true

      const currentCount = this.count(contributionId) - 1
      if (currentCount === 0) this.counts.delete(contributionId)
      else this.counts.set(contributionId, currentCount)

      const episode = this.warningEpisodes.get(contributionId)
      if (episode && currentCount <= Math.floor(episode.limit / 2)) {
        this.warningEpisodes.delete(contributionId)
        this.options?.unwarn(episode.pluginId, episode.message)
        const method = contributionId.startsWith('method:') ? contributionId.slice('method:'.length) : contributionId
        this.options?.log?.(`method ${method} in ${episode.pluginId} is under its limit again; ${episode.refused} calls were refused`)
      }
    }
  }
}
