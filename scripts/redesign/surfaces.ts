#!/usr/bin/env bun
/**
 * Resolves a feature name to the built-in plugins and UI surfaces that implement it, so the
 * redesign skill knows what to capture and score. Prints one `SurfaceResolution` JSON object on
 * stdout. Exit 0 when exactly one plugin matches, 1 when several tie or none match, 2 without a
 * query. Reads built-in manifests only; no plugin code runs.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPlugins } from '../../packages/daemon/src/plugins/discover'
import { RULES } from '../../packages/daemon/src/plugins/tool-layout'
import { parseContributionId, type PluginManifest } from '@quirky/protocol'
import type { Surface, SurfaceCandidate, SurfaceResolution } from './contracts'

const SURFACE_KINDS = ['panel', 'view', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section', 'setting', 'command', 'menu-item']
const SCOREABLE_KINDS = new Set(['panel', 'view', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section'])
const NONE_CANDIDATES = 5
const DEFAULT_PLUGINS_DIR = join(import.meta.dir, '../../plugins')

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function words(text: string): Set<string> {
  const normalized = normalize(text)
  return new Set(normalized === '' ? [] : normalized.split(' '))
}

/** Score for one searchable title: 3 when it equals the query, 2 when it holds every query word, 1 on any shared word. */
function titleScore(title: string, query: string, queryWords: Set<string>): number {
  if (normalize(title) === query) return 3
  const titleWords = words(title)
  const shared = [...queryWords].filter((word) => titleWords.has(word)).length
  if (shared === queryWords.size) return 2
  return shared > 0 ? 1 : 0
}

function surfacesOf(manifest: PluginManifest): Surface[] {
  const surfaces: Surface[] = []
  for (const kind of SURFACE_KINDS) {
    for (const entry of manifest.contributes?.[kind] ?? []) {
      surfaces.push({
        id: `${kind}:${manifest.id}/${entry.id}`,
        kind,
        title: typeof entry.title === 'string' ? entry.title : entry.id,
        scoreable: SCOREABLE_KINDS.has(kind)
      })
    }
  }
  return surfaces
}

/**
 * Scores every built-in plugin against `query` and classifies the result. A host tool title hit
 * (for example "Changes") credits the plugin owning that tool and folds the plugins contributing
 * its aliases into `alsoPlugins`, so an aliased plugin never competes with its owner.
 */
export function resolveSurfaces(query: string, pluginsDir: string = DEFAULT_PLUGINS_DIR): SurfaceResolution {
  const normalizedQuery = normalize(query)
  const queryWords = words(query)
  const manifests = new Map<string, PluginManifest>()
  const installed = join(tmpdir(), `redesign-no-installed-plugins-${process.pid}`)
  for (const plugin of discoverPlugins({ builtin: pluginsDir, installed })) {
    if (plugin.manifest) manifests.set(plugin.manifest.id, plugin.manifest)
  }

  const scores = new Map<string, number>()
  const alsoPlugins = new Map<string, Set<string>>()
  const aliasSurfaces = new Map<string, Surface[]>()
  const credited = new Set<string>()

  for (const [id, manifest] of manifests) {
    const segment = id.slice(id.lastIndexOf('.') + 1)
    const titles = surfacesOf(manifest).map((surface) => surface.title)
    let best = Math.max(
      normalize(segment) === normalizedQuery || normalize(manifest.name) === normalizedQuery ? 3 : 0,
      ...titles.map((title) => Math.min(titleScore(title, normalizedQuery, queryWords), 2))
    )
    if (best < 1) {
      const fieldWords = new Set([...words(segment), ...words(manifest.name), ...titles.flatMap((title) => [...words(title)])])
      if ([...queryWords].some((word) => fieldWords.has(word))) best = 1
    }
    scores.set(id, best)
  }

  for (const rule of RULES) {
    const owner = parseContributionId(rule.id)?.namespace
    const ownerManifest = owner ? manifests.get(owner) : undefined
    const hit = titleScore(rule.title, normalizedQuery, queryWords)
    if (!owner || !ownerManifest || hit === 0) continue
    scores.set(owner, Math.max(scores.get(owner) ?? 0, hit))
    for (const alias of rule.aliases ?? []) {
      const aliasId = parseContributionId(alias)
      const aliasManifest = aliasId ? manifests.get(aliasId.namespace) : undefined
      if (!aliasId || !aliasManifest) continue
      const surface = surfacesOf(aliasManifest).find((candidate) => candidate.id === alias)
      if (surface) aliasSurfaces.set(owner, [...(aliasSurfaces.get(owner) ?? []), surface])
      if (aliasId.namespace === owner) continue
      alsoPlugins.set(owner, (alsoPlugins.get(owner) ?? new Set()).add(aliasId.namespace))
      credited.add(aliasId.namespace)
    }
  }

  const ranked: SurfaceCandidate[] = [...manifests.values()]
    .filter((manifest) => !credited.has(manifest.id))
    .map((manifest) => {
      const own = surfacesOf(manifest)
      const extra = (aliasSurfaces.get(manifest.id) ?? []).filter((surface) => !own.some((existing) => existing.id === surface.id))
      return {
        pluginId: manifest.id,
        pluginName: manifest.name,
        score: scores.get(manifest.id) ?? 0,
        alsoPlugins: [...(alsoPlugins.get(manifest.id) ?? [])].sort(),
        surfaces: [...own, ...extra]
      }
    })
    .sort((a, b) => b.score - a.score || (a.pluginId < b.pluginId ? -1 : 1))

  const top = ranked[0]?.score ?? 0
  const leaders = ranked.filter((candidate) => candidate.score === top).length
  if (top >= 2) {
    return { query, status: leaders === 1 ? 'one' : 'many', candidates: ranked.filter((candidate) => candidate.score >= 1) }
  }
  return { query, status: 'none', candidates: ranked.slice(0, NONE_CANDIDATES) }
}

if (import.meta.main) {
  const query = process.argv.slice(2).join(' ').trim()
  if (normalize(query) === '') {
    const message = 'usage: surfaces.ts <feature name words...>'
    process.stderr.write(`${message}\n`)
    process.stdout.write(`${JSON.stringify({ error: message })}\n`)
    process.exit(2)
  }
  const resolution = resolveSurfaces(query)
  process.stdout.write(`${JSON.stringify(resolution)}\n`)
  process.exit(resolution.status === 'one' ? 0 : 1)
}
