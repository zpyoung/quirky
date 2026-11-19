import { readFileSync } from 'node:fs'
import { validateValue, type Schema } from '@quirky/protocol'
import type { AvatarApp } from '../src/contracts'
import type { FakeCalls } from './support'

type ManifestMethod = { id: string; params?: Schema; destructive?: boolean }
type PluginManifest = { id: string; contributes?: { method?: ManifestMethod[] } }

const manifests: Record<string, PluginManifest> = {
  'quirky.git': JSON.parse(readFileSync(new URL('../../quirky.git/quirky-plugin.json', import.meta.url), 'utf8')) as PluginManifest,
  'quirky.hosting': JSON.parse(readFileSync(new URL('../../quirky.hosting/quirky-plugin.json', import.meta.url), 'utf8')) as PluginManifest,
  'quirky.checks': JSON.parse(readFileSync(new URL('../../quirky.checks/quirky-plugin.json', import.meta.url), 'utf8')) as PluginManifest
}

/** Wraps shipping-related fakes with the same parameter and destructive-call checks as the plugin manifests. */
export function manifestChecked(fakes: FakeCalls): { fakes: FakeCalls; violations: string[] } {
  const violations: string[] = []
  const checked: FakeCalls = {}
  for (const [method, fake] of Object.entries(fakes)) {
    const separator = method.lastIndexOf('/')
    const pluginId = method.slice(0, separator)
    const manifest = manifests[pluginId]
    if (manifest === undefined) {
      checked[method] = fake
      continue
    }

    const methodId = method.slice(separator + 1)
    const declaration = manifest.contributes?.method?.find((entry) => entry.id === methodId)
    checked[method] = (params) => {
      const reject = (message: string): never => {
        violations.push(message)
        throw new Error(message)
      }
      if (declaration === undefined) return reject(`${method}: not in the manifest`)
      const schemaParams = { ...params }
      delete schemaParams.yes
      delete schemaParams.confirmation
      const invalid = validateValue(declaration.params ?? { type: 'object' }, schemaParams)
      if (invalid !== null) return reject(`${method}: ${invalid}`)
      if (declaration.destructive && params.yes !== true) return reject(`${method}: destructive without yes: true`)
      return fake(params)
    }
  }
  return { fakes: checked, violations }
}

/** A branch-sensitive fake for the hosting lookup used by shipping. */
export function forBranchFake(options: { branch: string; review: Record<string, unknown> }): (params: Record<string, unknown>) => unknown {
  return (params) => params.branch === options.branch || params.number === options.review.number
    ? { kind: 'found', review: options.review, fetchedAt: 0 }
    : { kind: 'no-review', fetchedAt: 0 }
}

export function readyPushTarget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ready: true,
    remote: 'origin',
    branch: 'feature',
    localBranch: 'feature',
    localHead: 'a'.repeat(40),
    fork: false,
    repository: { host: 'github.com', owner: 'o', repo: 'r' },
    ...overrides
  }
}

/** The stdout of `git ls-remote --symref <remote> HEAD refs/heads/<branch>`. */
export function lsRemote(options: { defaultBranch?: string | null; branch?: string; sha?: string | null }): string {
  const lines: string[] = []
  const defaultBranch = options.defaultBranch === undefined ? 'main' : options.defaultBranch
  if (defaultBranch !== null) {
    lines.push(`ref: refs/heads/${defaultBranch}\tHEAD`, `${'b'.repeat(40)}\tHEAD`)
  }
  if (options.branch !== undefined && options.sha !== null) {
    lines.push(`${options.sha ?? 'b'.repeat(40)}\trefs/heads/${options.branch}`)
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

export function handOff(app: AvatarApp, worktreeId = 'wt-1', at = 1): void {
  app.store.handoffs.put({ worktreeId, state: 'working', sessionId: null, active: true, handedOffAt: at, takenBackAt: null })
}

/** Mirrors take-back's store transaction: cancel queued actions, then deactivate the hand-off. */
export function takeBack(app: AvatarApp, worktreeId = 'wt-1'): number {
  return app.store.transaction(() => {
    const row = app.store.handoffs.get(worktreeId)
    if (row === null) return 0
    const cancelled = app.services.shipping.cancelOutbox(worktreeId)
    app.store.handoffs.put({ ...row, active: false, takenBackAt: app.now() })
    return cancelled
  })
}
