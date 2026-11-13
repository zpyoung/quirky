import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MUTATING_METHOD_TIMEOUT_MS,
  MAX_JOB_DURATION_MS,
  parseDuration,
  pluginApiCompatibilityError
} from '@quirky/protocol'
import { NETWORK_TIMEOUT_MS } from '../../../git/src/remote'
import { VM_TIMEOUT_MS } from '../../../../plugins/quirky.worktree/src/daemon/vm'
import { checkKindEntry } from '../../src/plugins/kinds'
import { parseManifest } from '../../src/plugins/manifest'

type MethodEntry = Record<string, unknown> & {
  id: string
  readOnly?: unknown
  timeout?: unknown
  params?: {
    properties?: Record<string, { maximum?: unknown }>
  }
}

type BuiltinManifest = Record<string, unknown> & {
  id: string
  apiVersion: string
  contributes?: {
    method?: MethodEntry[]
  }
}

const declaredTimeouts = {
  'quirky.checks/run': '30m',
  'quirky.git/sync': '30m',
  'quirky.hosting/merge': '30m',
  'quirky.hosting/rerunChecks': '30m',
  'quirky.hosting/projectItemMutation': '30m',
  'quirky.reviews/createSubmit': '30m',
  'quirky.editor/markdown': '30m',
  'quirky.terminal-dock/send': '30m',
  'quirky.browser/importCookies': '30m',
  'quirky.browser/profileClone': '30m',
  'quirky.accounts/restart': '30m',
  'quirky.accounts/select': '30m',
  'quirky.session/sleepWorkspace': '30m',
  'quirky.session/wakeWorkspace': '30m',
  'quirky.loops/resume': '30m',
  'quirky.loops/stop': '30m',
  'quirky.loops/closeView': '30m',
  'quirky.worktree/vmCreate': '1h',
  'quirky.worktree/vmSuspend': '1h',
  'quirky.worktree/vmResume': '1h',
  'quirky.worktree/vmDestroy': '1h',
  'quirky.orchestration/ask': '1h',
  'quirky.orchestration/check': '1h',
  'quirky.orchestration/serviceCheck': '1h',
  'quirky.reviews/checksGitAction': '1h',
  'quirky.reviews/detailMerge': '1h',
  'quirky.reviews/detailRerunChecks': '1h',
  'quirky.tasks/row': '1h',
  'quirky.tasks/projectEdit': '1h',
  'quirky.worktree/create': '24h',
  'quirky.worktree/prefetchCreate': '24h',
  'quirky.worktree/remove': '24h',
  'quirky.worktree/cleanupRemove': '24h',
  'quirky.editor/notebook': '24h',
  'quirky.vault/deleteSession': '24h',
  'quirky.orchestration/workerStart': '24h',
  'quirky.orchestration/serviceWorkerStart': '24h',
  'quirky.orchestration/peerCall': '24h',
  'quirky.automations/run': '24h',
  'quirky.automations/dispatch': '24h',
  'quirky.automations/tick': '24h',
  'quirky.heimdall/reconcile': '24h',
  'quirky.heimdall/command': '24h',
  'quirky.heimdall/remoteCommand': '24h',
  'quirky.heimdall/ownerReady': '24h',
  'quirky.heimdall/enroll': '24h',
  'quirky.tasks/workspace': '24h',
  'quirky.handoff/start': '24h',
  'quirky.agent-status/send': '24h'
} as const

const pluginsDir = fileURLToPath(new URL('../../../../plugins/', import.meta.url))
const manifestFiles = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'quirky-plugin.json')))
  .map((entry) => {
    const dir = join(pluginsDir, entry.name)
    const text = readFileSync(join(dir, 'quirky-plugin.json'), 'utf8')
    return {
      dir,
      dirName: entry.name,
      text,
      manifest: JSON.parse(text) as BuiltinManifest
    }
  })
const manifestsById = new Map(manifestFiles.map((file) => [file.manifest.id, file]))


function manifestFor(pluginId: string) {
  const file = manifestsById.get(pluginId)
  if (!file) throw new Error(`Missing manifest for ${pluginId}`)
  return file
}

function methodFor(pluginId: string, methodId: string): MethodEntry {
  const method = manifestFor(pluginId).manifest.contributes?.method?.find((entry) => entry.id === methodId)
  if (!method) throw new Error(`Missing method ${pluginId}/${methodId}`)
  return method
}

function methodForQualifiedId(qualifiedId: string): MethodEntry {
  const slash = qualifiedId.indexOf('/')
  return methodFor(qualifiedId.slice(0, slash), qualifiedId.slice(slash + 1))
}

function timeoutMsFor(qualifiedId: string): number {
  const timeout = methodForQualifiedId(qualifiedId).timeout
  if (typeof timeout !== 'string') throw new Error(`Missing timeout for ${qualifiedId}`)
  const timeoutMs = parseDuration(timeout)
  if (timeoutMs === null) throw new Error(`Invalid timeout for ${qualifiedId}: ${timeout}`)
  return timeoutMs
}

function effectiveDeadlineMs(qualifiedId: string): number {
  const timeout = methodForQualifiedId(qualifiedId).timeout
  if (timeout === undefined) {
    return typeof defaultMutatingTimeoutMs === 'number' ? defaultMutatingTimeoutMs : 600_000
  }
  if (typeof timeout !== 'string') throw new Error(`Invalid timeout for ${qualifiedId}`)
  const timeoutMs = parseDuration(timeout)
  if (timeoutMs === null) throw new Error(`Invalid timeout for ${qualifiedId}: ${timeout}`)
  return timeoutMs
}

describe('built-in method deadlines', () => {
  test('K1: the declared mutating deadline map is exact', () => {
    const actual = Object.fromEntries(
      manifestFiles.flatMap(({ manifest }) =>
        (manifest.contributes?.method ?? [])
          .filter((method) => method.readOnly !== true && method.timeout !== undefined)
          .map((method) => [`${manifest.id}/${method.id}`, method.timeout])
      )
    )
    expect(actual).toEqual(declaredTimeouts)
  })

  test('K2: every declared timeout validates and exceeds the mutating default', () => {
    expect(DEFAULT_MUTATING_METHOD_TIMEOUT_MS).toBe(600_000)
    for (const qualifiedId of Object.keys(declaredTimeouts)) {
      const method = methodForQualifiedId(qualifiedId)
      const errors: string[] = []
      checkKindEntry('method', `method ${qualifiedId}`, method, errors)
      expect(errors).toEqual([])

      expect(typeof method.timeout).toBe('string')
      if (typeof method.timeout !== 'string') continue
      const timeoutMs = parseDuration(method.timeout)
      expect(timeoutMs).not.toBeNull()
      if (timeoutMs !== null) {
        expect(timeoutMs).toBeGreaterThan(DEFAULT_MUTATING_METHOD_TIMEOUT_MS)
      }
    }
  })

  test('K3: every manifest with a method timeout requires API 1.12 and parses', () => {
    const withMethodTimeouts = manifestFiles.filter(({ manifest }) =>
      manifest.contributes?.method?.some((method) => method.timeout !== undefined)
    )
    for (const file of withMethodTimeouts) {
      expect(pluginApiCompatibilityError(file.manifest.apiVersion, '1.11.0')).not.toBeNull()
      expect(pluginApiCompatibilityError(file.manifest.apiVersion)).toBeNull()
      expect(parseManifest(file.text, {
        dirName: file.dirName,
        dir: file.dir,
        source: 'builtin'
      }).ok).toBe(true)
    }
  })

  test('K4: deadlines cover schema, constant, and maximum-duration budgets', () => {
    const checksRunMaximum = methodFor('quirky.checks', 'run').params?.properties?.timeoutSeconds?.maximum
    expect(checksRunMaximum).toBe(600)
    if (typeof checksRunMaximum === 'number') {
      expect(checksRunMaximum * 1000 * 2).toBeLessThanOrEqual(timeoutMsFor('quirky.checks/run'))
    }

    for (const methodId of ['ask', 'check', 'serviceCheck']) {
      const maximum = methodFor('quirky.orchestration', methodId).params?.properties?.timeoutMs?.maximum
      expect(maximum).toBe(1_800_000)
      if (typeof maximum === 'number') {
        expect(maximum * 2).toBeLessThanOrEqual(timeoutMsFor(`quirky.orchestration/${methodId}`))
      }
    }

    for (const methodId of ['vmCreate', 'vmSuspend', 'vmResume', 'vmDestroy']) {
      expect(VM_TIMEOUT_MS * 2).toBeLessThanOrEqual(timeoutMsFor(`quirky.worktree/${methodId}`))
    }

    expect(NETWORK_TIMEOUT_MS * 4 * 2).toBeLessThanOrEqual(timeoutMsFor('quirky.git/sync'))

    for (const { manifest } of manifestFiles) {
      for (const method of manifest.contributes?.method ?? []) {
        if (method.timeout === '24h') {
          expect(parseDuration(method.timeout)).toBe(MAX_JOB_DURATION_MS)
        }
      }
    }
  })

  test.each([
    ['quirky.reviews/checksGitAction', 'quirky.git/sync'],
    ['quirky.reviews/detailMerge', 'quirky.hosting/merge'],
    ['quirky.tasks/row', 'quirky.hosting/merge'],
    ['quirky.reviews/detailRerunChecks', 'quirky.hosting/rerunChecks'],
    ['quirky.tasks/projectEdit', 'quirky.hosting/projectItemMutation'],
    ['quirky.worktree/create', 'quirky.worktree/vmCreate'],
    ['quirky.automations/run', 'quirky.worktree/create'],
    ['quirky.automations/dispatch', 'quirky.worktree/create'],
    ['quirky.automations/tick', 'quirky.worktree/create'],
    ['quirky.automations/run', 'quirky.checks/run'],
    ['quirky.handoff/start', 'quirky.worktree/create'],
    ['quirky.tasks/workspace', 'quirky.worktree/create'],
    ['quirky.orchestration/workerStart', 'quirky.worktree/create'],
    ['quirky.orchestration/serviceWorkerStart', 'quirky.worktree/create'],
    ['quirky.heimdall/reconcile', 'quirky.orchestration/serviceWorkerStart']
  ] as const)('K5: %s has at least the deadline of %s', (caller, callee) => {
    expect(effectiveDeadlineMs(caller)).toBeGreaterThanOrEqual(effectiveDeadlineMs(callee))
  })

  test.each([
    ['quirky.agent-status', { wait: '75s', waitOutput: '75s' }],
    ['quirky.ask', { wait: '75s' }],
    ['quirky.mobile', { notificationPoll: '40s' }]
  ] as const)('K6: %s retains its long-poll deadlines', (id, deadlines) => {
    for (const [name, timeout] of Object.entries(deadlines)) {
      const entry = methodFor(id, name)
      expect(entry.timeout).toBe(timeout)
      const errors: string[] = []
      checkKindEntry('method', `method ${id}/${name}`, entry, errors)
      expect(errors).toEqual([])
    }
  })

  test('K7: orchestration check declares its maximum wait', () => {
    expect(methodFor('quirky.orchestration', 'check').params?.properties?.timeoutMs?.maximum).toBe(1_800_000)
  })
})
