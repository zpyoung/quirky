import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OwnerHostIdentity, PluginContext, PluginStore, RegisteredOwnerHost, Worktree } from '@quirky/protocol'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { environmentRecipeHash, migrateVmEnvironments, registerVmEnvironments, runVmProcessBounded } from '../src/daemon/vm'
import type { VmEnvironmentRecipe } from '../src/vm-types'

const guestIdentity: OwnerHostIdentity = { hostId: 'guest-host-stable', generation: 'activation-7' }
const worktree = {
  id: 'wt_guest_01', repoId: 'repo_guest', path: '/guest/workspaces/app', branch: 'main', head: 'a'.repeat(40),
  isMain: false, name: 'app', kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false,
  unread: false, parentId: null, createdAt: 1, createdBy: 'api', baseRef: 'main', keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: 1, instanceId: 'instance-guest-01'
} satisfies Worktree
const mirror = {
  id: 'mirror_guest_01', hostId: 'registered-guest-host', identity: guestIdentity, worktree,
  connected: true, fingerprint: 'remote-fingerprint-01'
}
const runtimeSummary = {
  id: 'runtime-vm-01', name: 'Quirky VM guest', endpoint: 'https://guest.invalid',
  pairedDeviceId: 'grant-vm-01', scope: 'owner-cli', grantId: 'grant-vm-01', createdAt: 1, lastUsedAt: null
}
const recipe: VmEnvironmentRecipe = {
  id: 'mac-dev', name: 'macOS development', create: '', checkoutMode: 'provisioned-root',
  suspend: 'limactl stop "$QUIRKY_VM_NAME"', resume: 'limactl start "$QUIRKY_VM_NAME"',
  destroy: 'limactl delete --force "$QUIRKY_VM_NAME"'
}

type Handler = (params: Record<string, unknown>) => unknown
let home: string
let dataDir: string
let repoPath: string
let limaRoot: string
let limaPath: string
let statePath: string
let logPath: string
let identityPath: string
let store: PluginStore
let db: Database
let methods: Map<string, Handler>
let calls: Array<{ method: string; params: Record<string, unknown> }>
let registeredHost: RegisteredOwnerHost
let hostRegistered: boolean
let envRecipe: VmEnvironmentRecipe
let savedRuntime: Record<string, unknown>
let disposeVm: (() => Promise<void>) | undefined
let previousHome: string | undefined
let previousQuirkyHome: string | undefined
let previousLima: string | undefined
let previousPath: string | undefined

beforeEach(() => {
  home = makeTempHome('quirky-vm-environments-')
  dataDir = join(home, 'plugin-data', 'quirky.worktree')
  repoPath = join(home, 'repo')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(repoPath, { recursive: true, mode: 0o700 })
  limaRoot = join(home, 'lima-instances')
  statePath = join(home, 'lima-state.json')
  logPath = join(home, 'lima.log')
  identityPath = join(home, 'guest-identity.json')
  writeFileSync(statePath, '[]\n', { mode: 0o600 })
  writeFileSync(logPath, '', { mode: 0o600 })
  writeFileSync(identityPath, JSON.stringify(guestIdentity), { mode: 0o600 })
  const binDir = join(home, 'bin')
  mkdirSync(binDir, { mode: 0o700 })
  limaPath = join(binDir, 'limactl')
  writeFileSync(limaPath, [
    '#!/bin/bash',
    'set -eu',
    "printf '%s\\n' \"$*\" >> \"$QUIRKY_TEST_LIMA_LOG\"",
    'case "$1" in',
    "  --version) echo 'limactl version 1.0.0';;",
    '  list) cat "$QUIRKY_TEST_LIMA_STATE";;',
    "  start) name=\"$2\"; dir=\"$QUIRKY_TEST_LIMA_ROOT/$name\"; mkdir -p \"$dir\"; printf '{\"name\":\"%s\",\"status\":\"Running\",\"dir\":\"%s\"}\\n' \"$name\" \"$dir\" > \"$QUIRKY_TEST_LIMA_STATE\";;",
    "  stop) name=\"$2\"; dir=\"$QUIRKY_TEST_LIMA_ROOT/$name\"; printf '{\"name\":\"%s\",\"status\":\"Stopped\",\"dir\":\"%s\"}\\n' \"$name\" \"$dir\" > \"$QUIRKY_TEST_LIMA_STATE\";;",
    '  delete) name="$3"; rm -rf "$QUIRKY_TEST_LIMA_ROOT/$name"; printf "[]" > "$QUIRKY_TEST_LIMA_STATE";;',
    '  shell) cat "$QUIRKY_TEST_GUEST_IDENTITY";;',
    '  *) echo "unexpected limactl arguments: $*" >&2; exit 64;;',
    'esac'
  ].join(String.fromCharCode(10)), { mode: 0o700 })
  chmodSync(limaPath, 0o700)
  previousHome = process.env.HOME
  previousQuirkyHome = process.env.QUIRKY_HOME
  previousLima = process.env.QUIRKY_LIMACTL
  previousPath = process.env.PATH
  process.env.HOME = home
  process.env.QUIRKY_HOME = home
  process.env.QUIRKY_LIMACTL = limaPath
  process.env.PATH = `${binDir}:${previousPath ?? ''}`
  process.env.QUIRKY_TEST_LIMA_STATE = statePath
  process.env.QUIRKY_TEST_LIMA_LOG = logPath
  process.env.QUIRKY_TEST_GUEST_IDENTITY = identityPath
  process.env.QUIRKY_TEST_LIMA_ROOT = limaRoot
  envRecipe = { ...recipe, create: createScript({ pairingCode: 'owner-cli-offer', workspaceSelector: 'wt_guest_01' }) }
  calls = []
  savedRuntime = { ...runtimeSummary }
  registeredHost = {
    id: 'registered-guest-host',
    runtime: { id: 'runtime-vm-01', name: 'VM guest', endpoint: 'https://guest.invalid', grantId: 'grant-vm-01' },
    identity: guestIdentity, connected: true, error: null, updatedAt: 1
  }
  hostRegistered = true
  methods = new Map()
  db = new Database(join(home, 'vm.sqlite'))
  store = {
    version: 0,
    run(sql, ...params) {
      const result = db.query(sql).run(...params)
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get(sql, ...params) { return db.query(sql).get(...params) as never },
    all(sql, ...params) { return db.query(sql).all(...params) as never },
    exec(sql) { db.exec(sql) },
    transaction(work) { return db.transaction(work)() }
  } as PluginStore
  migrateVmEnvironments(store)
  const context = {
    pluginId: 'quirky.worktree', dir: home, dataDir, home,
    log() {},
    provide(id: string, implementation: unknown) {
      const name = id.slice('method:quirky.worktree/'.length)
      methods.set(name, implementation as Handler)
    },
    error(_kind: string, message: string) { return Object.assign(new Error(message), { code: 'test-error' }) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.repo/show') {
        return { repo: { id: 'repo_local', name: 'local-project', path: repoPath, kind: 'git' }, hooks: { environmentRecipes: [envRecipe], environmentRecipeDiagnostics: [] } }
      }
      if (method === 'quirky.cli/runtimeAdd') {
        savedRuntime = { ...runtimeSummary, name: params.name }
        registeredHost = { ...registeredHost, runtime: { ...registeredHost.runtime, name: String(params.name) } }
        return savedRuntime
      }
      if (method === 'quirky.worktree/remoteHostRegister') {
        hostRegistered = true
        return registeredHost
      }
      if (method === 'quirky.cli/runtimeCall') {
        const result = params.method === 'quirky.worktree/show' ? worktree : guestIdentity
        return { runtime: registeredHost.runtime, result }
      }
      if (method === 'quirky.worktree/remoteAttach') return mirror
      if (method === 'quirky.worktree/remoteHostStatus') {
        if (!hostRegistered) throw new Error('registered host not found')
        const connected = readFileSync(statePath, 'utf8').includes('Running')
        return { ...registeredHost, connected }
      }
      if (method === 'quirky.worktree/remoteHostList') {
        if (!hostRegistered) {
          return {
            hosts: [{
              id: 'unrelated-host',
              runtime: { id: 'unrelated-runtime', name: 'Other runtime', endpoint: 'https://other.invalid', grantId: 'other-grant' },
              identity: { hostId: 'other-stable-host', generation: 'other-generation' },
              connected: false, error: 'offline', updatedAt: 1
            }]
          }
        }
        const connected = readFileSync(statePath, 'utf8').includes('Running')
        return { hosts: [{ ...registeredHost, connected }] }
      }
      if (method === 'quirky.worktree/remoteList') {
        const connected = readFileSync(statePath, 'utf8').includes('Running')
        return { workspaces: [{ ...mirror, connected }] }
      }
      if (method === 'quirky.worktree/remoteRefresh') {
        if (!readFileSync(statePath, 'utf8').includes('Running')) throw new Error('guest owner unreachable while Lima is stopped')
        return { workspaces: [{ ...mirror, connected: true }] }
      }
      if (method === 'quirky.worktree/remoteHostForget') {
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual([])
        expect(params.expectedHost).toEqual(guestIdentity)
        expect(params.expectedRuntime).toMatchObject({ id: savedRuntime.id, endpoint: savedRuntime.endpoint, grantId: savedRuntime.grantId })
        expect(params.yes).toBe(true)
        hostRegistered = false
        return { ok: true, detached: 1 }
      }
      if (method === 'quirky.cli/runtimeList') return { runtimes: [savedRuntime] }
      if (method === 'quirky.cli/runtimeShow') return savedRuntime
      if (method === 'quirky.cli/runtimeRemove') {
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual([])
        return savedRuntime
      }
      throw new Error(`unexpected public API call: ${method}`)
    }
  } as unknown as PluginContext
  disposeVm = registerVmEnvironments(context, store)
})

afterEach(async () => {
  await disposeVm?.()
  disposeVm = undefined
  db?.close()
  for (const [key, value] of Object.entries({ HOME: previousHome, QUIRKY_HOME: previousQuirkyHome, QUIRKY_LIMACTL: previousLima, PATH: previousPath })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env.QUIRKY_TEST_LIMA_STATE
  delete process.env.QUIRKY_TEST_LIMA_LOG
  delete process.env.QUIRKY_TEST_GUEST_IDENTITY
  delete process.env.QUIRKY_TEST_LIMA_ROOT
  rmSync(home, { recursive: true, force: true })
})

function createScript(result: unknown): string {
  const json = JSON.stringify(result)
  return `limactl start "$QUIRKY_VM_NAME"\nprintf '%s' '${json.replaceAll("'", "'\\''")}' > "$QUIRKY_VM_OUTPUT_PATH"`
}

function method(name: string): Handler {
  const handler = methods.get(name)
  if (!handler) throw new Error(`missing VM method ${name}`)
  return handler
}

function vmFromResult(result: unknown): { id: string; instanceId: string; state: string; remoteWorkspace?: unknown } {
  return result as { id: string; instanceId: string; state: string; remoteWorkspace?: unknown }
}
test('terminates a spawned descendant with its bounded process group', async () => {
  // This uses real OS signals: fake timers cannot exercise detached process-group ownership.
  const marker = join(home, 'child-terminated')
  const script = `(trap 'printf terminated > "$QUIRKY_VM_TEST_MARKER"; exit 0' TERM; while :; do :; done) & wait`
  const result = await runVmProcessBounded('/bin/bash', ['-c', script], {
    timeoutMs: 1000,
    env: { QUIRKY_VM_TEST_MARKER: marker }
  })
  expect(result.timedOut).toBe(true)
  expect(readFileSync(marker, 'utf8')).toBe('terminated')
})


test('rejects create consent when any full-lifecycle script changes before provisioning', async () => {
  const approved = environmentRecipeHash(envRecipe)
  envRecipe = { ...envRecipe, suspend: 'limactl stop --force "$QUIRKY_VM_NAME"' }
  expect(environmentRecipeHash(envRecipe)).not.toBe(approved)
  await expect(method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: approved })).rejects.toThrow(/hash|trust/i)
  expect(calls.some((call) => call.method === 'quirky.cli/runtimeAdd')).toBe(false)
  expect(readFileSync(logPath, 'utf8')).toBe('')
})

test.skipIf(process.platform !== 'darwin')('records a failed VM when trusted provisioning returns malformed private JSON', async () => {
  envRecipe = { ...envRecipe, create: createScript('{malformed') }
  await expect(method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) })).rejects.toThrow(/JSON|provision|result/i)
  const listing = method('vmList')({}) as { environments: Array<{ state: string; backendState: string; error: string | null }> }
  expect(listing.environments).toHaveLength(1)
  expect(listing.environments[0]).toMatchObject({ state: 'failed', backendState: 'running' })
  expect(listing.environments[0]?.error).toBeTruthy()
  expect(readFileSync(statePath, 'utf8')).toContain('Running')
})

test('reports a missing Lima executable without falling back to another backend', async () => {
  process.env.QUIRKY_LIMACTL = join(home, 'missing-limactl')
  const doctor = await method('vmDoctor')({}) as { supported: boolean; backend: { name: string; executable: string | null; available: boolean; error: string | null } }
  expect(doctor).toMatchObject({ supported: false, backend: { name: 'lima', executable: null, available: false } })
  await expect(method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) })).rejects.toThrow(/limactl|Lima/i)
  expect(readFileSync(logPath, 'utf8')).toBe('')
})

test.skipIf(process.platform !== 'darwin')('runs trusted scripts through an isolated Lima boundary and rejects a stale VM instance fence', async () => {
  const created = vmFromResult(await method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) }))
  expect(created.state).toBe('running')
  expect(created.remoteWorkspace).toEqual(mirror)
  const beforeStaleRequest = readFileSync(logPath, 'utf8')
  await expect(method('vmSuspend')({ vm: created.id, instanceId: 'stale-instance' })).rejects.toThrow(/instance|stale/i)
  expect(readFileSync(logPath, 'utf8')).toBe(beforeStaleRequest)
  const suspended = vmFromResult(await method('vmSuspend')({ vm: created.id, instanceId: created.instanceId }))
  expect(suspended.state).toBe('stopped')
  expect(suspended.remoteWorkspace).toMatchObject({
    id: mirror.id,
    connected: false,
    worktree: { id: worktree.id, instanceId: worktree.instanceId }
  })
  const resumed = vmFromResult(await method('vmResume')({ vm: created.id, instanceId: created.instanceId }))
  expect(resumed.state).toBe('running')
  expect(resumed.remoteWorkspace).toEqual(mirror)
  await method('vmDestroy')({ vm: created.id, instanceId: created.instanceId })
  expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual([])
  expect(calls.some((call) => call.method === 'quirky.worktree/remoteHostForget' && call.params.detach === true)).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.cli/runtimeRemove' && call.params.selector === 'runtime-vm-01')).toBe(true)
})
test.skipIf(process.platform !== 'darwin')('refuses lifecycle scripts against a Lima VM recreated under the same name', async () => {
  const created = vmFromResult(await method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) }))
  const [observed] = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ name: string; status: string; dir: string }>
  const displacedDirectory = join(home, 'displaced-lima-instance')
  renameSync(observed!.dir, displacedDirectory)
  mkdirSync(observed!.dir)
  writeFileSync(statePath, JSON.stringify([{ ...observed, status: 'Running' }]))

  await expect(method('vmSuspend')({ vm: created.id, instanceId: created.instanceId })).rejects.toThrow(/recreated|replacement/i)
  await expect(method('vmResume')({ vm: created.id, instanceId: created.instanceId })).rejects.toThrow(/recreated|replacement/i)
  await expect(method('vmDestroy')({ vm: created.id, instanceId: created.instanceId })).rejects.toThrow(/recreated|replacement/i)
  const lifecycleCommands = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.startsWith('start ') || line.startsWith('stop ') || line.startsWith('delete '))
  expect(lifecycleCommands).toEqual([`start ${created.instanceId}`])
})
test.skipIf(process.platform !== 'darwin')('exposes creating records and blocks lifecycle calls until create settles', async () => {
  const releaseFile = join(home, 'release-create')
  envRecipe = {
    ...envRecipe,
    create: `while [ ! -f '${releaseFile}' ]; do :; done\n${createScript({ pairingCode: 'owner-cli-offer', workspaceSelector: 'wt_guest_01' })}`
  }
  const creation = method('vmCreate')({
    repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe)
  }) as Promise<unknown>
  type PendingVm = { id: string; instanceId: string; state: string; operation: { id: string; kind: string; state: string } }
  let pending: PendingVm | undefined
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listing = method('vmList')({}) as { environments: PendingVm[] }
    pending = listing.environments[0]
    if (pending?.state === 'creating') break
    await Promise.resolve()
  }
  try {
    expect(pending).toMatchObject({ state: 'creating', operation: { kind: 'create', state: 'running' } })
    await expect(method('vmDestroy')({ vm: pending!.id, instanceId: pending!.instanceId })).rejects.toThrow(/already performing create/i)
  } finally {
    writeFileSync(releaseFile, '')
  }
  const created = vmFromResult(await creation)
  expect(created.state).toBe('running')
  await method('vmDestroy')({ vm: created.id, instanceId: created.instanceId })
})
test.skipIf(process.platform !== 'darwin')('reconciles an already-forgotten host without touching another host registration', async () => {
  const created = vmFromResult(await method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) }))
  const [instance] = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ dir: string }>
  rmSync(instance!.dir, { recursive: true, force: true })
  writeFileSync(statePath, '[]\n')
  hostRegistered = false

  const destroyed = vmFromResult(await method('vmDestroy')({ vm: created.id, instanceId: created.instanceId }))
  expect(destroyed.state).toBe('destroyed')
  expect(calls.some((call) => call.method === 'quirky.worktree/remoteHostList')).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.worktree/remoteHostForget')).toBe(false)
  expect(calls.some((call) => call.method === 'quirky.cli/runtimeRemove' && call.params.selector === savedRuntime.id)).toBe(true)
})

test.skipIf(process.platform !== 'darwin')('refuses retirement when the registered host identity was replaced', async () => {
  const created = vmFromResult(await method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) }))
  const [instance] = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ dir: string }>
  rmSync(instance!.dir, { recursive: true, force: true })
  writeFileSync(statePath, '[]\n')
  registeredHost = { ...registeredHost, identity: { hostId: 'replacement-host', generation: 'replacement-generation' } }

  await expect(method('vmDestroy')({ vm: created.id, instanceId: created.instanceId })).rejects.toThrow(/identity|replaced/i)
  expect(calls.some((call) => call.method === 'quirky.worktree/remoteHostForget')).toBe(false)
  expect(calls.some((call) => call.method === 'quirky.cli/runtimeRemove')).toBe(false)
})
