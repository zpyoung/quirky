import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { OwnerHostIdentity, PluginContext, PluginStore, RegisteredOwnerHost, Worktree } from '@quirky/protocol'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { createProcessRunner, type OwnedProcessRunner, type ProcessSpawner, type SpawnedProcess } from '../../../packages/process/src/api'
import { environmentRecipeHash, matchesRetainedVmWorkspaceOrigin, migrateVmEnvironments, registerVmEnvironments, runVmProcessBounded, vmRecipeSearchPath } from '../src/daemon/vm'
import type { VmEnvironment, VmEnvironmentRecipe } from '../src/vm-types'

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
let remoteMirror: typeof mirror
let remoteMirrorVisible: boolean
let failNextRotatedAttach: boolean
let disposeVm: (() => Promise<void>) | undefined
let processRunner: OwnedProcessRunner | undefined

let previousHome: string | undefined
let previousQuirkyHome: string | undefined
let previousLima: string | undefined
let previousPath: string | undefined
let previousTestLimaReady: string | undefined
let previousTestLimaTerminated: string | undefined

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
  const startCountPath = join(home, 'lima-start-count')
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
    "  start) name=\"$2\"; dir=\"$QUIRKY_TEST_LIMA_ROOT/$name\"; count_file=\"$QUIRKY_TEST_LIMA_START_COUNT\"; count=0; if [ -f \"$count_file\" ]; then count=$(cat \"$count_file\"); fi; count=$((count+1)); printf '%s' \"$count\" > \"$count_file\"; if [ \"$count\" -eq 2 ]; then printf '{\"hostId\":\"guest-host-stable\",\"generation\":\"activation-8\"}' > \"$QUIRKY_TEST_GUEST_IDENTITY\"; fi; mkdir -p \"$dir\"; printf '{\"name\":\"%s\",\"status\":\"Running\",\"dir\":\"%s\"}\\n' \"$name\" \"$dir\" > \"$QUIRKY_TEST_LIMA_STATE\";;",
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
  previousTestLimaReady = process.env.QUIRKY_TEST_LIMA_READY
  previousTestLimaTerminated = process.env.QUIRKY_TEST_LIMA_TERMINATED
  process.env.HOME = home
  process.env.QUIRKY_HOME = home
  process.env.QUIRKY_LIMACTL = limaPath
  process.env.PATH = `${binDir}:${previousPath ?? ''}`
  process.env.QUIRKY_TEST_LIMA_STATE = statePath
  process.env.QUIRKY_TEST_LIMA_LOG = logPath
  process.env.QUIRKY_TEST_GUEST_IDENTITY = identityPath
  process.env.QUIRKY_TEST_LIMA_ROOT = limaRoot
  process.env.QUIRKY_TEST_LIMA_START_COUNT = startCountPath
  envRecipe = { ...recipe, create: createScript({ pairingCode: 'owner-cli-offer', workspaceSelector: 'wt_guest_01' }) }
  remoteMirror = mirror
  remoteMirrorVisible = true
  failNextRotatedAttach = false
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
  const currentGuestIdentity = (): OwnerHostIdentity => JSON.parse(readFileSync(identityPath, 'utf8')) as OwnerHostIdentity
  const currentMirror = (connected: boolean) => {
    const identity = currentGuestIdentity()
    const rotated = identity.generation !== guestIdentity.generation
    return {
      ...mirror,
      id: rotated ? 'mirror_guest_02' : mirror.id,
      identity,
      connected,
      fingerprint: rotated ? 'remote-fingerprint-02' : mirror.fingerprint
    }
  }
  processRunner = createProcessRunner({ owner: `quirky.worktree-test-${home}` })
  const context = {
    pluginId: 'quirky.worktree', dir: home, dataDir, home, process: processRunner!,
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
        const identity = currentGuestIdentity()
        if (remoteMirror.identity.hostId !== identity.hostId || remoteMirror.identity.generation !== identity.generation) {
          remoteMirror = { ...remoteMirror, connected: false }
        }
        registeredHost = { ...registeredHost, identity }
        return registeredHost
      }
      if (method === 'quirky.cli/runtimeCall') {
        if (params.method === 'quirky.worktree/show') return { runtime: registeredHost.runtime, result: worktree }
        const identity = currentGuestIdentity()
        registeredHost = { ...registeredHost, identity }
        return { runtime: registeredHost.runtime, result: identity }
      }
      if (method === 'quirky.worktree/remoteAttach') {
        if (failNextRotatedAttach && currentGuestIdentity().generation === 'activation-8') {
          failNextRotatedAttach = false
          throw new Error('simulated attachment interruption')
        }
        remoteMirror = currentMirror(true)
        remoteMirrorVisible = true
        return remoteMirror
      }
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
        if (!remoteMirrorVisible) return { workspaces: [] }
        const identity = currentGuestIdentity()
        const connected = readFileSync(statePath, 'utf8').includes('Running') &&
          remoteMirror.identity.hostId === identity.hostId && remoteMirror.identity.generation === identity.generation
        return { workspaces: [{ ...remoteMirror, connected }] }
      }
      if (method === 'quirky.worktree/remoteRefresh') {
        if (!readFileSync(statePath, 'utf8').includes('Running')) throw new Error('guest owner unreachable while Lima is stopped')
        return { workspaces: [currentMirror(true)] }
      }
      if (method === 'quirky.worktree/remoteHostForget') {
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual([])
        expect(params.expectedHost).toEqual(currentGuestIdentity())
        expect(params.expectedRuntime).toMatchObject({ id: savedRuntime.id, endpoint: savedRuntime.endpoint, grantId: savedRuntime.grantId })
        expect(params.yes).toBe(true)
        hostRegistered = false
        remoteMirrorVisible = false
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
  await processRunner?.dispose()
  processRunner = undefined
  db?.close()
  for (const [key, value] of Object.entries({
    HOME: previousHome,
    QUIRKY_HOME: previousQuirkyHome,
    QUIRKY_LIMACTL: previousLima,
    PATH: previousPath,
    QUIRKY_TEST_LIMA_READY: previousTestLimaReady,
    QUIRKY_TEST_LIMA_TERMINATED: previousTestLimaTerminated
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env.QUIRKY_TEST_LIMA_STATE
  delete process.env.QUIRKY_TEST_LIMA_LOG
  delete process.env.QUIRKY_TEST_GUEST_IDENTITY
  delete process.env.QUIRKY_TEST_LIMA_ROOT
  delete process.env.QUIRKY_TEST_LIMA_START_COUNT
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

function vmFromResult(result: unknown): VmEnvironment {
  return result as VmEnvironment
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}
function processResult(options: {
  pid?: number | null
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  exit?: Record<string, unknown>
  onStop?: () => void
} = {}): SpawnedProcess {
  const exit = options.exit ?? { exitCode: 0, signal: null, durationMs: 1 }
  return {
    pid: options.pid === undefined ? 123 : options.pid,
    stdout: options.stdout ?? byteStream(),
    stderr: options.stderr ?? byteStream(),
    stderrTail: () => '',
    write: async () => false,
    closeInput: async () => {},
    exited: Promise.resolve(exit),
    stop: async () => {
      options.onStop?.()
      return exit
    }
  } as unknown as SpawnedProcess
}

function processRecorder(child = processResult()): {
  spawner: ProcessSpawner
  calls: Array<{ argv: readonly string[]; options: Record<string, unknown> }>
} {
  const calls: Array<{ argv: readonly string[]; options: Record<string, unknown> }> = []
  const spawner = {
    spawn(argv: readonly string[], options: Record<string, unknown>) {
      calls.push({ argv, options })
      return child
    }
  } as unknown as ProcessSpawner
  return { spawner, calls }
}

test('runs bounded VM commands through the process runner with merged environment and group grace', async () => {
  const recorder = processRecorder()
  await runVmProcessBounded(recorder.spawner, '/bin/bash', ['-c', 's'], {
    cwd: '/r',
    timeoutMs: 1000,
    env: { A: '1' }
  })
  expect(recorder.calls).toEqual([{
    argv: ['/bin/bash', '-c', 's'],
    options: {
      cwd: '/r',
      env: { ...process.env, A: '1' },
      timeoutMs: 1000,
      killGraceMs: 5000,
      stderr: 'pipe',
      groupGrace: true
    }
  }])
})

test('uses the default VM command deadline when none is supplied', async () => {
  const recorder = processRecorder()
  await runVmProcessBounded(recorder.spawner, '/bin/bash', ['-c', 'true'])
  expect(recorder.calls).toHaveLength(1)
  expect(recorder.calls[0]?.options.timeoutMs).toBe(900_000)
})

test('keeps only the first combined 64 KiB of stdout and stderr without stopping the process', async () => {
  const { promise: stdoutAtLimit, resolve: releaseStdoutAtLimit } = Promise.withResolvers<void>()
  let stdoutReads = 0
  let stderrRead = false
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stdoutReads === 0) {
        controller.enqueue(new Uint8Array(65_536).fill(0x61))
        stdoutReads++
      } else if (stdoutReads === 1) {
        controller.enqueue(new Uint8Array([0x62]))
        stdoutReads++
        releaseStdoutAtLimit()
      } else {
        controller.close()
      }
    }
  }, { highWaterMark: 0 })
  const stderr = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!stderrRead) {
        await stdoutAtLimit
        controller.enqueue(new Uint8Array([0x63]))
        stderrRead = true
      } else {
        controller.close()
      }
    }
  }, { highWaterMark: 0 })
  let stopCalls = 0
  const recorder = processRecorder(processResult({ stdout, stderr, onStop: () => { stopCalls++ } }))
  const result = await runVmProcessBounded(recorder.spawner, '/bin/bash', ['-c', 's'])
  expect(result.stdout).toBe('a'.repeat(65_536))
  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  expect(stopCalls).toBe(0)
})

test('keeps stdout and stderr in order under a combined output cap', async () => {
  const script = [
    `printf "%s" "${'a'.repeat(40_000)}"`,
    'sleep 0.3',
    `printf "%s" "${'b'.repeat(40_000)}" >&2`,
    'sleep 0.3',
    `printf "%s" "${'c'.repeat(40_000)}"`
  ].join('\n')
  const result = await runVmProcessBounded(processRunner!, '/bin/bash', ['-c', script])
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  expect(result.stdout).toBe('a'.repeat(40_000))
  expect(result.stderr).toBe('b'.repeat(25_536))
})

test('counts raw stderr bytes before decoding the combined output cap', async () => {
  const oneOver = new Uint8Array(3 + 65_533 + 1)
  oneOver.set([0xef, 0xbb, 0xbf])
  oneOver.fill(0x65, 3, 3 + 65_533)
  oneOver[oneOver.length - 1] = 0x65
  const first = await runVmProcessBounded(
    processRecorder(processResult({ stderr: byteStream(oneOver) })).spawner,
    '/bin/bash',
    ['-c', 's']
  )
  expect(first.stderr).toBe(`\uFEFF${'e'.repeat(65_533)}`)

  const invalid = new Uint8Array(3 + 65_532 + 2)
  invalid.set([0xef, 0xbb, 0xbf])
  invalid.fill(0x65, 3, 3 + 65_532)
  invalid.set([0xff, 0x7a], 3 + 65_532)
  const second = await runVmProcessBounded(
    processRecorder(processResult({ stderr: byteStream(invalid) })).spawner,
    '/bin/bash',
    ['-c', 's']
  )
  expect(second.stderr).toBe(`\uFEFF${'e'.repeat(65_532)}�`)
})

test('preserves VM descendant cleanup after the leader exits naturally', async () => {
  const marker = join(home, 'child-cleaned')
  const ready = join(home, 'child-ready')
  const script = `(trap 'printf cleaned > "$QUIRKY_VM_TEST_MARKER"; exit 0' TERM; : > "$QUIRKY_VM_TEST_READY"; while :; do :; done) >/dev/null 2>&1 & while [ ! -e "$QUIRKY_VM_TEST_READY" ]; do :; done; exit 0`
  const result = await runVmProcessBounded(processRunner!, '/bin/bash', ['-c', script], {
    timeoutMs: 10_000,
    env: { QUIRKY_VM_TEST_MARKER: marker, QUIRKY_VM_TEST_READY: ready }
  })
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  expect(readFileSync(marker, 'utf8')).toBe('cleaned')
})

test('swallows VM stream failures and does not expose the process-group diagnostic', async () => {
  const failedStream = (partial: string) => {
    let read = false
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!read) {
          controller.enqueue(new TextEncoder().encode(partial))
          read = true
        } else {
          controller.error(new Error('stream failed'))
        }
      }
    }, { highWaterMark: 0 })
  }
  const recorder = processRecorder(processResult({
    stdout: failedStream('partial stdout'),
    stderr: failedStream('partial stderr'),
    exit: { exitCode: 0, signal: null, durationMs: 1, groupSurvived: true }
  }))
  const result = await runVmProcessBounded(recorder.spawner, '/bin/bash', ['-c', 's'])
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: 'partial stdout',
    stderr: 'partial stderr',
    timedOut: false
  })
  expect(result).not.toHaveProperty('groupSurvived')
})

test('reports the shared runner start error with its executable', async () => {
  const child = processResult({
    pid: null,
    exit: {
      exitCode: null,
      signal: null,
      durationMs: 1,
      spawnError: { code: 'ENOENT', message: 'command not found' }
    }
  })
  const recorder = processRecorder(child)
  await expect(runVmProcessBounded(recorder.spawner, '/tmp/missing-command', [])).rejects.toThrow(
    'Could not start /tmp/missing-command: command not found'
  )
})

test('stops and awaits an in-flight VM command during service deactivation', async () => {
  const ready = join(home, 'doctor-ready')
  const terminated = join(home, 'doctor-terminated')
  writeFileSync(limaPath, [
    '#!/bin/bash',
    'if [ "$1" = "--version" ]; then',
    '  printf "limactl version test\\n"',
    '  trap \'printf terminated > "$QUIRKY_TEST_LIMA_TERMINATED"; exit 0\' TERM',
    '  printf ready > "$QUIRKY_TEST_LIMA_READY"',
    '  while :; do sleep 0.01; done',
    'fi',
  ].join('\n'), { mode: 0o700 })
  chmodSync(limaPath, 0o700)
  process.env.QUIRKY_TEST_LIMA_READY = ready
  process.env.QUIRKY_TEST_LIMA_TERMINATED = terminated
  store.run(
    `INSERT INTO vm_environments
      (id, repo_id, repo_name, repo_path, recipe_id, recipe_name, recipe_hash, recipe_json,
       instance_id, backend_executable, state, backend_state, operation_id, operation_kind,
       operation_state, operation_started_at, operation_updated_at, runtime_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'deactivation-row', 'repo_local', 'local-project', repoPath, recipe.id, recipe.name, 'hash', '{}',
    'vm-deactivation', limaPath, 'creating', 'unknown', 'operation-deactivation', 'create',
    'running', Date.now(), Date.now(), 'VM deactivation', Date.now(), Date.now()
  )

  const doctor = method('vmDoctor')({})
  await waitForFile(ready)
  await disposeVm!()
  await doctor

  expect(readFileSync(terminated, 'utf8')).toBe('terminated')
  expect(store.get<{ state: string; operation_state: string }>(
    'SELECT state, operation_state FROM vm_environments WHERE id = ?', 'deactivation-row'
  )).toEqual({ state: 'interrupted', operation_state: 'interrupted' })
  await expect(method('vmDoctor')({})).rejects.toThrow('VM lifecycle stopped during plugin deactivation')
})

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename?.toString() === basename(path) && existsSync(path)) {
      watcher.close()
      resolve()
    }
  })
  if (existsSync(path)) {
    watcher.close()
    resolve()
  }
  return promise
}

test('terminates a spawned descendant with its bounded process group', async () => {
  // This uses real OS signals: fake timers cannot exercise detached process-group ownership.
  const marker = join(home, 'child-terminated')
  const script = `(trap 'printf terminated > "$QUIRKY_VM_TEST_MARKER"; exit 0' TERM; while :; do :; done) & wait`
  const result = await runVmProcessBounded(processRunner!, '/bin/bash', ['-c', script], {
    timeoutMs: 1000,
    env: { QUIRKY_VM_TEST_MARKER: marker }
  })
  expect(result.timedOut).toBe(true)
  expect(readFileSync(marker, 'utf8')).toBe('terminated')
})

test('does not search the repository cwd when the inherited VM script PATH is absent', async () => {
  const backendDir = join(home, 'trusted-backend-bin')
  const inheritedDir = join(home, 'trusted-inherited-bin')
  const maliciousExecutable = join(repoPath, 'quirky-path-probe')
  const trustedExecutable = join(inheritedDir, 'quirky-path-probe')
  const poisonMarker = join(home, 'poison-executed')
  const backendExecutable = join(backendDir, 'limactl')
  mkdirSync(backendDir, { recursive: true, mode: 0o700 })
  mkdirSync(inheritedDir, { recursive: true, mode: 0o700 })
  writeFileSync(maliciousExecutable, '#!/bin/bash\nprintf poison > "$QUIRKY_PATH_POISON_MARKER"\n', { mode: 0o700 })
  chmodSync(maliciousExecutable, 0o700)
  writeFileSync(trustedExecutable, '#!/bin/bash\nprintf trustedvalue\n', { mode: 0o700 })
  chmodSync(trustedExecutable, 0o700)

  const missingInheritedPath = await runVmProcessBounded(processRunner!, '/bin/bash', ['-c', 'quirky-path-probe'], {
    cwd: repoPath,
    timeoutMs: 1000,
    env: {
      PATH: vmRecipeSearchPath(backendExecutable, undefined),
      QUIRKY_PATH_POISON_MARKER: poisonMarker
    }
  })
  expect(missingInheritedPath.exitCode).toBe(127)
  expect(existsSync(poisonMarker)).toBe(false)

  const trustedInheritedPath = await runVmProcessBounded(processRunner!, '/bin/bash', ['-c', 'quirky-path-probe'], {
    cwd: repoPath,
    timeoutMs: 1000,
    env: {
      PATH: vmRecipeSearchPath(backendExecutable, inheritedDir),
      QUIRKY_PATH_POISON_MARKER: poisonMarker
    }
  })
  expect(trustedInheritedPath.exitCode).toBe(0)
  expect(trustedInheritedPath.stdout.trim()).toBe('trustedvalue')
  expect(existsSync(poisonMarker)).toBe(false)
})


test('recognizes a retained VM workspace origin across owner generations without authorizing replacements', () => {
  const retained = {
    hostId: 'registered-guest-host',
    identity: { hostId: 'guest-host-stable', generation: 'activation-7' },
    worktree: { id: worktree.id, instanceId: worktree.instanceId }
  }
  const current = {
    hostId: 'registered-guest-host',
    identity: { hostId: 'guest-host-stable', generation: 'activation-8' },
    worktree: { id: worktree.id, instanceId: worktree.instanceId }
  }
  expect(matchesRetainedVmWorkspaceOrigin(retained, current)).toBe(true)
  expect(matchesRetainedVmWorkspaceOrigin(retained, { ...current, hostId: 'replacement-registration' })).toBe(false)
  expect(matchesRetainedVmWorkspaceOrigin(retained, { ...current, identity: { ...current.identity, hostId: 'replacement-guest' } })).toBe(false)
  expect(matchesRetainedVmWorkspaceOrigin(retained, { ...current, worktree: { ...current.worktree, id: 'replacement-worktree' } })).toBe(false)
  expect(matchesRetainedVmWorkspaceOrigin(retained, { ...current, worktree: { ...current.worktree, instanceId: 'replacement-instance' } })).toBe(false)
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

test.skipIf(process.platform !== 'darwin')('reattaches the exact guest workspace after generation rotation and recovers an interrupted attach without replaying create', async () => {
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

  failNextRotatedAttach = true
  await expect(method('vmResume')({ vm: created.id, instanceId: created.instanceId })).rejects.toThrow(/simulated attachment interruption/)
  const interrupted = vmFromResult(method('vmShow')({ vm: created.id }))
  expect(interrupted.state).toBe('failed')
  expect(interrupted.ownerHost).toMatchObject({ identity: { hostId: guestIdentity.hostId, generation: 'activation-8' } })
  expect(interrupted.remoteWorkspace).toMatchObject({
    id: mirror.id,
    identity: { hostId: guestIdentity.hostId, generation: 'activation-7' },
    connected: false,
    worktree: { id: worktree.id, instanceId: worktree.instanceId }
  })

  const resumed = vmFromResult(await method('vmResume')({ vm: created.id, instanceId: created.instanceId }))
  expect(resumed.state).toBe('running')
  expect(resumed.remoteWorkspace).toMatchObject({
    id: 'mirror_guest_02',
    hostId: registeredHost.id,
    identity: { hostId: guestIdentity.hostId, generation: 'activation-8' },
    worktree: { id: worktree.id, instanceId: worktree.instanceId },
    connected: true,
    fingerprint: 'remote-fingerprint-02'
  })
  expect(resumed.remoteWorkspace?.id).not.toBe(mirror.id)
  expect(readFileSync(join(home, 'lima-start-count'), 'utf8')).toBe('2')
  expect(calls.filter((call) => call.method === 'quirky.cli/runtimeAdd')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'quirky.worktree/remoteAttach')).toHaveLength(3)
  expect(calls.filter((call) => call.method === 'quirky.worktree/remoteAttach').map((call) => call.params.worktree))
    .toEqual([worktree.id, worktree.id, worktree.id])
  await method('vmDestroy')({ vm: created.id, instanceId: created.instanceId })
  expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual([])
  expect(calls.some((call) => call.method === 'quirky.worktree/remoteHostForget' && call.params.detach === true)).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.cli/runtimeRemove' && call.params.selector === 'runtime-vm-01')).toBe(true)
})

test.skipIf(process.platform !== 'darwin')('reattaches the retained VM workspace after local host and mirror detachment', async () => {
  const created = vmFromResult(await method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) }))
  hostRegistered = false
  remoteMirrorVisible = false

  const resumed = vmFromResult(await method('vmResume')({ vm: created.id, instanceId: created.instanceId }))
  expect(resumed.state).toBe('running')
  expect(resumed.remoteWorkspace).toMatchObject({
    id: 'mirror_guest_02',
    hostId: registeredHost.id,
    identity: { hostId: guestIdentity.hostId, generation: 'activation-8' },
    worktree: { id: worktree.id, instanceId: worktree.instanceId },
    connected: true,
    fingerprint: 'remote-fingerprint-02'
  })
  expect(calls.filter((call) => call.method === 'quirky.worktree/remoteList')).toHaveLength(0)
  expect(calls.filter((call) => call.method === 'quirky.worktree/remoteAttach').map((call) => call.params.worktree))
    .toEqual([worktree.id, worktree.id])
})

test.skipIf(process.platform !== 'darwin')('reattaches an already-running VM workspace with its same-generation mirror', async () => {
  const created = vmFromResult(await method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) }))
  writeFileSync(join(home, 'lima-start-count'), '2', { mode: 0o600 })

  const resumed = vmFromResult(await method('vmResume')({ vm: created.id, instanceId: created.instanceId }))
  expect(resumed.state).toBe('running')
  expect(resumed.remoteWorkspace).toEqual(mirror)
  expect(resumed.ownerHost).toMatchObject({ identity: guestIdentity, connected: true })
  expect(readFileSync(identityPath, 'utf8')).toBe(JSON.stringify(guestIdentity))
  expect(calls.filter((call) => call.method === 'quirky.worktree/remoteList')).toHaveLength(0)
  expect(readFileSync(join(home, 'lima-start-count'), 'utf8')).toBe('3')
})
test.skipIf(process.platform !== 'darwin')('refuses lifecycle scripts against a Lima VM recreated under the same name', async () => {
  const created = vmFromResult(await method('vmCreate')({ repo: 'repo_local', recipe: envRecipe.id, trustHash: environmentRecipeHash(envRecipe) }))
  const observed = JSON.parse(readFileSync(statePath, 'utf8')) as { name: string; status: string; dir: string }
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
  const instance = JSON.parse(readFileSync(statePath, 'utf8')) as { dir: string }
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
  const instance = JSON.parse(readFileSync(statePath, 'utf8')) as { dir: string }
  rmSync(instance!.dir, { recursive: true, force: true })
  writeFileSync(statePath, '[]\n')
  registeredHost = { ...registeredHost, identity: { hostId: 'replacement-host', generation: 'replacement-generation' } }

  await expect(method('vmDestroy')({ vm: created.id, instanceId: created.instanceId })).rejects.toThrow(/identity|replaced/i)
  expect(calls.some((call) => call.method === 'quirky.worktree/remoteHostForget')).toBe(false)
  expect(calls.some((call) => call.method === 'quirky.cli/runtimeRemove')).toBe(false)
})

test('remote and VM screens use design-system components with no inline styles or bare form markup', () => {
  const src = join(import.meta.dir, '..', 'src')
  const offenders: string[] = []
  for (const file of ['RemoteWorkspace.tsx', 'RemoteWorkspacesSection.tsx', 'VmEnvironments.tsx', 'VmRecipeSelector.tsx']) {
    const source = readFileSync(join(src, file), 'utf8')
    if (source.includes('style={')) offenders.push(`${file}: inline style`)
    if (source.includes('className="form"') || source.includes('className="form-group"')) offenders.push(`${file}: bare form class`)
    if (/<(button|select|input)[\s>]/.test(source)) offenders.push(`${file}: native control`)
  }
  expect(offenders).toEqual([])
})
