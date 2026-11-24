import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginMarketplace,
  PluginMarketplaceGitSource
} from '../../shared/plugins/plugin-marketplace'
import type { PluginMarketplaceFetchResult } from './plugin-marketplace-fetch'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-service-'))
  roots.push(root)
  return root
}

function source(url = 'https://github.com/community/plugins.git'): PluginMarketplaceGitSource {
  return { kind: 'git', url, ref: 'main' }
}

function marketplace(
  name = 'Community',
  pluginKey = 'community.notes',
  pluginUrl = 'https://github.com/community/notes.git'
): PluginMarketplace {
  return {
    name,
    owner: name.toLowerCase(),
    plugins: [
      {
        id: pluginKey,
        source: { kind: 'git', url: pluginUrl, ref: 'v1' },
        description: 'Notes for active worktrees.',
        categories: ['productivity']
      }
    ]
  }
}

function fetched(value = marketplace(), commit = 'a'.repeat(40)): PluginMarketplaceFetchResult {
  return { marketplaceCommit: commit, marketplace: value }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginMarketplaceService', () => {
  it('fetches before registration, then serves browse data from the local snapshot', async () => {
    const fetcher = vi
      .fn<
        (registration: PluginMarketplaceRegisteredSource) => Promise<PluginMarketplaceFetchResult>
      >()
      .mockResolvedValue(fetched())
    const service = new PluginMarketplaceService({ pluginsDataDir: await tempRoot(), fetcher })

    const added = await service.addSource(source())

    expect(added).toMatchObject({ marketplace: { name: 'Community' }, stale: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(service.listPlugins()).resolves.toEqual([
      expect.objectContaining({
        marketplaceSourceId: added.id,
        pluginKey: 'community.notes',
        official: false,
        bundled: false
      })
    ])
    await service.listSources()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps and labels the last valid snapshot when a refresh is offline', async () => {
    const fetcher = vi
      .fn<
        (registration: PluginMarketplaceRegisteredSource) => Promise<PluginMarketplaceFetchResult>
      >()
      .mockResolvedValueOnce(fetched())
      .mockRejectedValueOnce(new Error('offline'))
    const service = new PluginMarketplaceService({ pluginsDataDir: await tempRoot(), fetcher })
    const added = await service.addSource(source())

    await expect(service.refreshSource(added.id)).resolves.toMatchObject({
      marketplace: { name: 'Community', resolvedCommit: 'a'.repeat(40) },
      stale: true,
      error: 'offline'
    })
    await expect(service.listPlugins()).resolves.toEqual([
      expect.objectContaining({ pluginKey: 'community.notes' })
    ])
  })

  it('atomically replaces the cache only after a valid refreshed index', async () => {
    const fetcher = vi
      .fn<
        (registration: PluginMarketplaceRegisteredSource) => Promise<PluginMarketplaceFetchResult>
      >()
      .mockResolvedValueOnce(fetched())
      .mockResolvedValueOnce(fetched(marketplace('Updated'), 'b'.repeat(40)))
    const root = await tempRoot()
    const service = new PluginMarketplaceService({ pluginsDataDir: root, fetcher })
    const added = await service.addSource(source())

    await expect(service.refreshSource(added.id)).resolves.toMatchObject({
      marketplace: { name: 'Updated', resolvedCommit: 'b'.repeat(40) },
      stale: false
    })
    await expect(
      new PluginMarketplaceService({ pluginsDataDir: root, fetcher }).listPlugins()
    ).resolves.toEqual([expect.objectContaining({ marketplaceName: 'Updated' })])
  })

  it('does not persist a source whose first fetch fails', async () => {
    const service = new PluginMarketplaceService({
      pluginsDataDir: await tempRoot(),
      fetcher: async () => {
        throw new Error('authentication failed')
      }
    })

    await expect(service.addSource(source())).rejects.toThrow('authentication failed')
    await expect(service.listSources()).resolves.toEqual([])
  })

  it('rejects reserved identities outside the official organization', async () => {
    const service = new PluginMarketplaceService({
      pluginsDataDir: await tempRoot(),
      fetcher: async () =>
        fetched(
          marketplace('Attack', 'community.orca-secrets', 'https://github.com/attacker/x.git')
        )
    })

    await expect(service.addSource(source())).rejects.toThrow(
      'reserved plugin identity community.orca-secrets'
    )
    await expect(service.listSources()).resolves.toEqual([])
  })

  it('derives the Official badge only from the canonical marketplace and source organization', async () => {
    const officialMarketplace: PluginMarketplace = {
      name: 'Orca Plugins',
      owner: 'stablyai',
      plugins: [
        {
          id: 'stablyai.orca-shortcuts',
          source: {
            kind: 'git',
            url: 'git@github.com:stablyai/orca-shortcuts.git',
            ref: 'main'
          },
          categories: ['keybindings']
        }
      ]
    }
    const service = new PluginMarketplaceService({
      pluginsDataDir: await tempRoot(),
      fetcher: async () => fetched(officialMarketplace)
    })

    await service.addSource(source('https://github.com/stablyai/orca-plugins.git'))

    await expect(service.listPlugins()).resolves.toEqual([
      expect.objectContaining({ pluginKey: 'stablyai.orca-shortcuts', official: true })
    ])
  })

  it('hides listings whose contribution kind this build no longer supports', async () => {
    const mixed: PluginMarketplace = {
      name: 'Community',
      owner: 'community',
      plugins: [
        {
          id: 'community.midnight',
          source: { kind: 'git', url: 'https://github.com/community/midnight.git', ref: 'v1' },
          categories: ['themes', 'official']
        },
        {
          id: 'community.recipes',
          source: { kind: 'git', url: 'https://github.com/community/recipes.git', ref: 'v1' },
          categories: ['vm-recipes']
        }
      ]
    }
    const service = new PluginMarketplaceService({
      pluginsDataDir: await tempRoot(),
      fetcher: async () => fetched(mixed)
    })

    const added = await service.addSource(source())

    // The theme pack is filtered out; only the supported recipe listing remains.
    await expect(service.listPlugins()).resolves.toEqual([
      expect.objectContaining({ pluginKey: 'community.recipes' })
    ])

    // Preview and install resolve by key, so an unsupported pack must be
    // unreachable that way too — otherwise the dead install just moves later.
    await expect(service.findPlugin(added.id, 'community.midnight')).resolves.toBeNull()
    await expect(service.findPlugin(added.id, 'community.recipes')).resolves.toEqual(
      expect.objectContaining({ pluginKey: 'community.recipes' })
    )
  })

  it('removes source metadata and browse listings together', async () => {
    const service = new PluginMarketplaceService({
      pluginsDataDir: await tempRoot(),
      fetcher: async () => fetched()
    })
    const added = await service.addSource(source())

    await expect(service.removeSource(added.id)).resolves.toBe(true)
    await expect(service.listSources()).resolves.toEqual([])
    await expect(service.listPlugins()).resolves.toEqual([])
  })
})
