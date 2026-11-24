import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverLiveClaudePluginSkillSources } from './live-plugin-marketplace-sources'

const PLUGIN_ID = 'quirk@quirk-dev'

type Fixture = {
  root: string
  homeDir: string
  cwd: string
  cachePath: string
  liveDir: string
}

const created: string[] = []

async function writeJson(pathValue: string, value: unknown): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true })
  await writeFile(pathValue, JSON.stringify(value), 'utf8')
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'quirky-live-plugins-'))
  created.push(root)
  const homeDir = join(root, 'home')
  const cwd = join(root, 'workspace')
  const cachePath = join(homeDir, '.claude', 'plugins', 'cache', 'quirk-dev', 'quirk', '5.9.0')
  const liveDir = join(root, 'ProjectWorkspaces', 'quirk')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(cachePath, 'skills'), { recursive: true })
  await mkdir(join(liveDir, 'skills'), { recursive: true })
  await writeJson(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: cachePath }] }
  })
  await writeJson(join(homeDir, '.claude', 'settings.json'), {
    enabledPlugins: { [PLUGIN_ID]: true }
  })
  return { root, homeDir, cwd, cachePath, liveDir }
}

async function writeKnownMarketplaces(
  homeDir: string,
  entries: Record<string, unknown>
): Promise<void> {
  await writeJson(join(homeDir, '.claude', 'plugins', 'known_marketplaces.json'), entries)
}

async function writeMarketplaceManifest(installLocation: string, value: unknown): Promise<void> {
  await writeJson(join(installLocation, '.claude-plugin', 'marketplace.json'), value)
}

describe('live Claude plugin skill sources', () => {
  afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('scans the live marketplace directory instead of the frozen cache copy', async () => {
    const { homeDir, cwd, cachePath, liveDir } = await fixture()
    await writeKnownMarketplaces(homeDir, {
      'quirk-dev': {
        source: { source: 'directory', path: liveDir },
        installLocation: liveDir
      }
    })
    await writeMarketplaceManifest(liveDir, {
      name: 'quirk-dev',
      plugins: [{ name: 'quirk', source: './', version: '2026.7.31' }]
    })

    const roots = await discoverLiveClaudePluginSkillSources({ homeDir, cwd })

    expect(roots.map((root) => root.path)).toEqual([join(liveDir, 'skills')])
    expect(roots[0]).toMatchObject({
      label: 'Claude plugin quirk',
      pluginName: 'quirk',
      sourceKind: 'plugin',
      owner: 'claude'
    })
    expect(roots.map((root) => root.path)).not.toContain(join(cachePath, 'skills'))
  })

  it('rewrites the root even when the live directory has no skills folder yet', async () => {
    const { homeDir, cwd, liveDir } = await fixture()
    await rm(join(liveDir, 'skills'), { recursive: true, force: true })
    await writeKnownMarketplaces(homeDir, {
      'quirk-dev': { source: { source: 'directory' }, installLocation: liveDir }
    })
    await writeMarketplaceManifest(liveDir, { plugins: [{ name: 'quirk', source: './' }] })

    const roots = await discoverLiveClaudePluginSkillSources({ homeDir, cwd })

    expect(roots.map((root) => root.path)).toEqual([join(liveDir, 'skills')])
  })

  it('keeps the cached root when known_marketplaces.json is absent', async () => {
    const { homeDir, cwd, cachePath } = await fixture()

    const roots = await discoverLiveClaudePluginSkillSources({ homeDir, cwd })

    expect(roots.map((root) => root.path)).toEqual([join(cachePath, 'skills')])
  })

  it('keeps the cached root for a github-sourced marketplace', async () => {
    const { homeDir, cwd, cachePath, liveDir } = await fixture()
    await writeKnownMarketplaces(homeDir, {
      'quirk-dev': {
        source: { source: 'github', repo: 'zpyoung/quirk' },
        installLocation: liveDir
      }
    })
    await writeMarketplaceManifest(liveDir, { plugins: [{ name: 'quirk', source: './' }] })

    const roots = await discoverLiveClaudePluginSkillSources({ homeDir, cwd })

    expect(roots.map((root) => root.path)).toEqual([join(cachePath, 'skills')])
  })

  it('keeps the cached root when the marketplace manifest is missing', async () => {
    const { homeDir, cwd, cachePath, liveDir } = await fixture()
    await writeKnownMarketplaces(homeDir, {
      'quirk-dev': { source: { source: 'directory' }, installLocation: liveDir }
    })

    const roots = await discoverLiveClaudePluginSkillSources({ homeDir, cwd })

    expect(roots.map((root) => root.path)).toEqual([join(cachePath, 'skills')])
  })

  it('keeps the cached root when the marketplace metadata is malformed', async () => {
    const { homeDir, cwd, cachePath, liveDir } = await fixture()
    await mkdir(join(homeDir, '.claude', 'plugins'), { recursive: true })
    await writeFile(
      join(homeDir, '.claude', 'plugins', 'known_marketplaces.json'),
      '{ not json',
      'utf8'
    )
    await writeMarketplaceManifest(liveDir, { plugins: [{ name: 'quirk', source: './' }] })

    const roots = await discoverLiveClaudePluginSkillSources({ homeDir, cwd })

    expect(roots.map((root) => root.path)).toEqual([join(cachePath, 'skills')])
  })
})
