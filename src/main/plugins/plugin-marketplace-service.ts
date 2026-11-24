import {
  OFFICIAL_MARKETPLACE_OWNER,
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity,
  isMarketplaceListingSupported,
  pluginMarketplaceGitSourceSchema,
  type PluginMarketplaceEntry,
  type PluginMarketplaceGitSource
} from '../../shared/plugins/plugin-marketplace'
import {
  fetchPluginMarketplace,
  type PluginMarketplaceFetchResult
} from './plugin-marketplace-fetch'
import {
  marketplaceSourceId,
  PluginMarketplaceStore,
  type PluginMarketplaceCachedSnapshot,
  type PluginMarketplaceRegisteredSource
} from './plugin-marketplace-store'
import { validateMarketplaceProvenance } from './plugin-marketplace-provenance'
import { pluginMarketplaceErrorMessage } from './plugin-marketplace-error-message'
import type {
  PluginMarketplaceListing,
  PluginMarketplaceSourceState
} from './plugin-marketplace-projection'
export type {
  PluginMarketplaceListing,
  PluginMarketplaceSourceState
} from './plugin-marketplace-projection'

type MarketplaceFetcher = (
  source: PluginMarketplaceRegisteredSource
) => Promise<PluginMarketplaceFetchResult>

export class PluginMarketplaceService {
  private readonly store: PluginMarketplaceStore
  private readonly fetcher: MarketplaceFetcher
  private readonly refreshChains = new Map<string, Promise<PluginMarketplaceSourceState>>()
  private readonly sourceErrors = new Map<string, string>()

  constructor(options: {
    pluginsDataDir: string
    fetcher?: MarketplaceFetcher
    store?: PluginMarketplaceStore
  }) {
    this.store = options.store ?? new PluginMarketplaceStore(options.pluginsDataDir)
    this.fetcher = options.fetcher ?? fetchPluginMarketplace
  }

  async listSources(): Promise<PluginMarketplaceSourceState[]> {
    const sources = await this.store.listSources()
    return Promise.all(
      sources.map(async (source) => {
        try {
          const error = this.sourceErrors.get(source.id)
          return this.stateFromSnapshot(
            source,
            await this.store.readSnapshot(source.id),
            Boolean(error),
            error
          )
        } catch (error) {
          return this.stateFromSnapshot(source, null, true, pluginMarketplaceErrorMessage(error))
        }
      })
    )
  }

  async addSource(source: PluginMarketplaceGitSource): Promise<PluginMarketplaceSourceState> {
    const parsedSource = pluginMarketplaceGitSourceSchema.parse(source)
    const sourceId = marketplaceSourceId(parsedSource)
    const existing = (await this.store.listSources()).find((candidate) => candidate.id === sourceId)
    const candidate: PluginMarketplaceRegisteredSource = existing ?? {
      id: sourceId,
      source: parsedSource,
      addedAt: Date.now()
    }
    const fetched = await this.fetchAndValidate(candidate)
    const registered = existing ?? (await this.store.addSource(parsedSource, candidate.addedAt))
    try {
      const snapshot = await this.store.writeSnapshot({ source: registered, ...fetched })
      this.sourceErrors.delete(registered.id)
      return this.stateFromSnapshot(registered, snapshot, false)
    } catch (error) {
      if (!existing) {
        await this.store.removeSource(registered.id).catch(() => undefined)
      }
      throw error
    }
  }

  async removeSource(sourceId: string): Promise<boolean> {
    const removed = await this.store.removeSource(sourceId)
    if (removed) {
      this.sourceErrors.delete(sourceId)
    }
    return removed
  }

  async refreshSource(sourceId: string): Promise<PluginMarketplaceSourceState> {
    const previous = this.refreshChains.get(sourceId) ?? Promise.resolve(null)
    const refresh = previous.catch(() => null).then(() => this.performRefresh(sourceId))
    this.refreshChains.set(sourceId, refresh)
    try {
      return await refresh
    } finally {
      if (this.refreshChains.get(sourceId) === refresh) {
        this.refreshChains.delete(sourceId)
      }
    }
  }

  async refreshAll(): Promise<PluginMarketplaceSourceState[]> {
    const sources = await this.store.listSources()
    return Promise.all(sources.map((source) => this.refreshSource(source.id)))
  }

  async listPlugins(): Promise<PluginMarketplaceListing[]> {
    const states = await this.listSnapshots()
    return states
      .flatMap(({ source, snapshot }) =>
        snapshot.marketplace.plugins
          // Why: hide packs whose contribution kind this build no longer
          // supports (themes/icons/skills) so users never reach a dead install.
          .filter((entry) => isMarketplaceListingSupported(entry.categories))
          .map((entry) => this.listingFromEntry(source, snapshot, entry))
      )
      .sort((left, right) =>
        `${left.pluginKey}\0${left.marketplaceSourceId}`.localeCompare(
          `${right.pluginKey}\0${right.marketplaceSourceId}`
        )
      )
  }

  async findPlugin(
    marketplaceSourceId: string,
    pluginKey: string
  ): Promise<PluginMarketplaceListing | null> {
    const source = (await this.store.listSources()).find(
      (candidate) => candidate.id === marketplaceSourceId
    )
    if (!source) {
      return null
    }
    const snapshot = await this.store.readSnapshot(source.id)
    // Why: preview and install resolve listings through here, so an unsupported
    // pack must be unreachable by key too — hiding only the catalog card would
    // move the dead install one click later instead of removing it.
    const entry = snapshot?.marketplace.plugins.find(
      (plugin) => plugin.id === pluginKey && isMarketplaceListingSupported(plugin.categories)
    )
    return snapshot && entry ? this.listingFromEntry(source, snapshot, entry) : null
  }

  private async performRefresh(sourceId: string): Promise<PluginMarketplaceSourceState> {
    const source = (await this.store.listSources()).find((candidate) => candidate.id === sourceId)
    if (!source) {
      throw new Error(`unknown marketplace source: ${sourceId}`)
    }
    try {
      const fetched = await this.fetchAndValidate(source)
      const snapshot = await this.store.writeSnapshot({ source, ...fetched })
      this.sourceErrors.delete(source.id)
      return this.stateFromSnapshot(source, snapshot, false)
    } catch (error) {
      const cached = await this.store.readSnapshot(source.id).catch(() => null)
      if (!cached) {
        throw error
      }
      const message = pluginMarketplaceErrorMessage(error)
      this.sourceErrors.set(source.id, message)
      return this.stateFromSnapshot(source, cached, true, message)
    }
  }

  private async fetchAndValidate(
    source: PluginMarketplaceRegisteredSource
  ): Promise<PluginMarketplaceFetchResult> {
    const fetched = await this.fetcher(source)
    validateMarketplaceProvenance(source, fetched)
    return fetched
  }

  private async listSnapshots(): Promise<
    { source: PluginMarketplaceRegisteredSource; snapshot: PluginMarketplaceCachedSnapshot }[]
  > {
    const sources = await this.store.listSources()
    const snapshots = await Promise.all(
      sources.map(async (source) => ({
        source,
        snapshot: await this.store.readSnapshot(source.id)
      }))
    )
    return snapshots.filter(
      (
        candidate
      ): candidate is {
        source: PluginMarketplaceRegisteredSource
        snapshot: PluginMarketplaceCachedSnapshot
      } => candidate.snapshot !== null
    )
  }

  private listingFromEntry(
    source: PluginMarketplaceRegisteredSource,
    snapshot: PluginMarketplaceCachedSnapshot,
    entry: PluginMarketplaceEntry
  ): PluginMarketplaceListing {
    const official =
      isOfficialMarketplaceGitSource(source.source.url) &&
      snapshot.marketplace.owner.toLowerCase() === OFFICIAL_MARKETPLACE_OWNER &&
      isOfficialPluginIdentity(entry.id) &&
      isOfficialOrganizationGitSource(entry.source.url)
    return {
      marketplaceSourceId: source.id,
      marketplaceName: snapshot.marketplace.name,
      marketplaceOwner: snapshot.marketplace.owner,
      marketplaceCommit: snapshot.marketplaceCommit,
      pluginKey: entry.id,
      source: entry.source,
      ...(entry.description ? { description: entry.description } : {}),
      categories: entry.categories,
      official,
      bundled: false
    }
  }

  private stateFromSnapshot(
    source: PluginMarketplaceRegisteredSource,
    snapshot: PluginMarketplaceCachedSnapshot | null,
    stale: boolean,
    error?: string
  ): PluginMarketplaceSourceState {
    return {
      id: source.id,
      source: source.source,
      addedAt: source.addedAt,
      marketplace: snapshot
        ? {
            name: snapshot.marketplace.name,
            owner: snapshot.marketplace.owner,
            resolvedCommit: snapshot.marketplaceCommit,
            fetchedAt: snapshot.fetchedAt
          }
        : null,
      stale,
      official: isOfficialMarketplaceGitSource(source.source.url),
      ...(error ? { error } : {})
    }
  }
}
