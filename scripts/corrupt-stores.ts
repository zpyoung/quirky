import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { PluginInfo } from '@quirky/protocol'
import { connectDaemon, readRuntime } from '../packages/protocol/src/node'
import type { QuirkyClient } from '../packages/protocol/src/client'
import type { OwnerGrantSummary } from '../plugins/quirky.mobile/src/daemon/owner-store'
import { createProcessScope } from './test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from './ui-review/fixtures'

export type CorruptionMode = 'garbage' | 'truncate' | 'shape' | 'healthy'
export type StoreKind = 'sqlite' | 'json'
export type StoreOutcome = 'quarantined' | 'rewritten' | 'untouched'
export type InventoriedStore = { path: string; kind: StoreKind }
export type JsonStoreSpec = { path: string; expect: 'quarantine' | 'rewrite'; checkAfter: 'restart' | 'third-start' }
export type PluginReportEntry = { id: string; state: string; reason: string }
export const REQUIRED_OWNERS = ['quirky.browser', 'quirky.mobile', 'quirky.accounts'] as const
export const JSON_STORES: readonly JsonStoreSpec[] = [
  { path: 'plugin-data/quirky.browser/browser-state.json', expect: 'quarantine', checkAfter: 'restart' },
  { path: 'plugin-data/quirky.mobile/owner-grants.json', expect: 'quarantine', checkAfter: 'restart' },
  { path: 'plugin-data/quirky.accounts/usage-credentials.json', expect: 'quarantine', checkAfter: 'restart' },
  { path: 'plugin-data/quirky.mobile/e2ee-keypair.json', expect: 'quarantine', checkAfter: 'third-start' },
  { path: 'plugin-data/quirky.mobile/devices.json', expect: 'quarantine', checkAfter: 'third-start' },
  { path: 'daemon-identity.json', expect: 'rewrite', checkAfter: 'restart' }
]
export const STAND_IN_NAMES: readonly string[] = [
  'security', 'claude', 'codex', 'gemini', 'agy', 'opencode', 'cursor-agent', 'grok', 'kimi',
  'copilot', 'qwen', 'omp', 'pi', 'orca', 'gh', 'glab', 'osascript', 'open', 'defaults', 'launchctl',
  'networksetup', 'scutil', 'socketfilterfw', 'pmset', 'ssh', 'curl', 'wget'
]

type StoreResult = InventoriedStore & {
  damaged: boolean
  damageChanged: boolean | null
  outcome: StoreOutcome | null
  check: { ok: boolean; detail: string } | null
  siblingBytesMatch?: boolean
}
export type SweepResult = {
  mode: CorruptionMode
  activeBefore: string[]
  firstStartReport: PluginReportEntry[]
  restartReport: PluginReportEntry[]
  thirdStartReport: PluginReportEntry[]
  stores: StoreResult[]
  unlistedJson: string[]
  mobileListenerHosts: (string | null)[]
  mobileStateErrors?: (string | null)[]
  ownerGrants: unknown
  seededOwnerGrant?: OwnerGrantSummary
  credentialStatus: unknown
  newCorruptOnThirdStart: string[]
  newCorruptAfterRestart?: string[]
  standIns: { selfTest: { security: boolean; egress: boolean }; calls: string[]; refusedEgress: string[] }
}

export function installSweepStandIns(root: string): { fakebin: string; preload: string; standInLog: string; egressLog: string } {
  const fakebin = join(root, 'fakebin')
  const preload = join(root, 'deny-egress.cjs')
  const standInLog = join(root, 'stand-ins.log')
  const egressLog = join(root, 'egress.log')
  mkdirSync(fakebin, { recursive: true, mode: 0o700 })
  for (const file of [standInLog, egressLog]) writeFileSync(file, '', { mode: 0o600 })
  for (const name of STAND_IN_NAMES) {
    writeFileSync(join(fakebin, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> ${shellLiteral(standInLog)}\nexit 97\n`, { mode: 0o700 })
  }
  writeFileSync(preload, `const fs = require('node:fs')
const upstream = globalThis.fetch
globalThis.fetch = Object.assign(async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(raw)
  const host = url.hostname.toLowerCase()
  if (!(host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^127\\./.test(host))) {
    fs.appendFileSync(${JSON.stringify(egressLog)}, url.href + '\\n', { mode: 0o600 })
    throw new TypeError('non-loopback fetch refused by corruption sweep')
  }
  return upstream(input, init)
}, { preconnect: upstream.preconnect })
`, { mode: 0o600 })
  return { fakebin, preload, standInLog, egressLog }
}

function shellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      if (name.startsWith('.') || name === 'tmp') continue
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isDirectory()) walk(path)
      else if (info.isFile()) files.push(relative(root, path).split('\\').join('/'))
    }
  }
  walk(root)
  return files.sort((a, b) => a.localeCompare(b))
}

export function inventoryStores(quirkyHome: string): InventoriedStore[] {
  return walkFiles(quirkyHome).flatMap((path): InventoriedStore[] => {
    if (path === 'runtime.json' || path.includes('.corrupt-') || /-(wal|shm|journal)$/.test(path)) return []
    if (/\.(db|sqlite|sqlite3)$/.test(path)) return [{ path, kind: 'sqlite' }]
    return path.endsWith('.json') ? [{ path, kind: 'json' }] : []
  })
}

export function damageStore(file: string, kind: StoreKind, mode: Exclude<CorruptionMode, 'healthy'>): Buffer {
  for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true })
  const original = readFileSync(file)
  let written: Buffer
  if (mode === 'garbage') written = Buffer.alloc(8192, 0x41)
  else if (mode === 'truncate') {
    const length = kind === 'json' ? Math.floor(original.length / 2) : Math.min(original.length - 1, Math.max(100, Math.floor(original.length / 2) - 37))
    written = original.subarray(0, length)
  } else if (kind === 'json') written = Buffer.from('{"quirkyCorruptStoreSweep":[1]}')
  else {
    written = Buffer.from(original)
    const encoded = original.readUInt16BE(16)
    const pageSize = encoded === 1 ? 65_536 : encoded
    written.fill(0xa5, original.length > pageSize ? pageSize : 100)
  }
  writeFileSync(file, written)
  return written
}

function corruptFiles(home: string): string[] {
  return walkFiles(home).filter((path) => basename(path).includes('.corrupt-'))
}

function newSiblings(home: string, store: InventoriedStore, before: ReadonlySet<string>): string[] {
  const directory = dirname(store.path)
  const name = basename(store.path)
  return corruptFiles(home).filter((path) => {
    if (before.has(path) || dirname(path) !== directory) return false
    const sibling = basename(path)
    return sibling.startsWith(name + '.corrupt-') ||
      name.endsWith('.json') && sibling.startsWith(name.slice(0, -5) + '.corrupt-') && sibling.endsWith('.json')
  })
}

export function classifyStore(home: string, store: InventoriedStore, written: Buffer, before: ReadonlySet<string>): StoreOutcome {
  if (newSiblings(home, store, before).length > 0) return 'quarantined'
  const path = join(home, store.path)
  return existsSync(path) && !readFileSync(path).equals(written) ? 'rewritten' : 'untouched'
}


export function sweepFailures(result: SweepResult): string[] {
  const failures: string[] = []
  for (const name of ['security', 'egress'] as const) {
    if (!result.standIns.selfTest[name]) failures.push(`self-test:${name}`)
  }
  for (const id of REQUIRED_OWNERS) {
    if (!result.activeBefore.includes(id)) failures.push(`required-owner-inactive:${id}`)
  }
  for (const [report, prefix] of [[result.restartReport, 'inactive-after-restart'], [result.thirdStartReport, 'inactive-after-third-start']] as const) {
    for (const id of result.activeBefore) {
      if (report.some((plugin) => plugin.id === id)) failures.push(`${prefix}:${id}`)
    }
  }
  for (const spec of JSON_STORES) {
    if (!result.stores.some((store) => store.path === spec.path)) failures.push(`missing-store:${spec.path}`)
  }
  for (const [index, host] of result.mobileListenerHosts.entries()) {
    const stateError = result.mobileStateErrors?.[index]
    const pendingRegistry = result.mode !== 'healthy' && (index === 1 || index === 2) && host === null &&
      (stateError === 'Mobile device registry unavailable' ||
        stateError === 'Mobile device registry unavailable. Mobile pairing data was damaged and set aside. Run quirky mobile reset-pairing --confirm to start over; every paired device must pair again.')
    if (host !== '127.0.0.1' && !pendingRegistry) failures.push(`listener-host:${host}`)
  }
  if (result.mode === 'healthy') {
    const quarantines = [...(result.newCorruptAfterRestart ?? []), ...result.newCorruptOnThirdStart]
    for (const name of quarantines) failures.push(`healthy-quarantine:${name}`)
    const grants = result.ownerGrants
    const seed = result.seededOwnerGrant
    if (!seed || !Array.isArray(grants) || grants.length !== 1 || typeof grants[0] !== 'object' || grants[0] === null ||
      Object.keys(grants[0]).length !== Object.keys(seed).length ||
      !Object.entries(seed).every(([key, value]) => grants[0][key] === value)) {
      failures.push('healthy-owner-grants')
    }
    if (!Array.isArray(result.credentialStatus) || !result.credentialStatus.some((status) =>
      typeof status === 'object' && status !== null && status.provider === 'zcode' && status.kind === 'base-url' && status.configured === true && status.readable === true
    )) failures.push('healthy-credential')
    if (result.stores.find((store) => store.path === JSON_STORES[0]!.path)?.check?.ok !== true) failures.push('healthy-browser-bytes')
    return failures
  }
  for (const name of result.newCorruptOnThirdStart) failures.push(`requarantined-on-third-start:${name}`)
  for (const store of result.stores) {
    if (!store.damaged) continue
    if (!store.damageChanged) failures.push(`damage-noop:${store.path}`)
    if (store.kind === 'sqlite') {
      if (store.outcome !== 'quarantined') failures.push(`sqlite-not-quarantined:${store.path}`)
      continue
    }
    const spec = JSON_STORES.find((entry) => entry.path === store.path)
    if (!spec) continue
    if (store.outcome !== (spec.expect === 'quarantine' ? 'quarantined' : 'rewritten')) {
      failures.push(`json-outcome:${store.path}:expected ${spec.expect} got ${store.outcome}`)
    }
    if (store.check?.ok !== true) failures.push(`json-check:${store.path}:${store.check?.detail ?? 'content check missing'}`)
    if (store.siblingBytesMatch === false) failures.push(`sibling-bytes:${store.path}`)
  }
  return failures
}

function reportPlugins(plugins: PluginInfo[]): PluginReportEntry[] {
  return plugins.filter((plugin) => plugin.state !== 'active').map((plugin) => ({
    id: plugin.id,
    state: plugin.state,
    reason: plugin.disabledReason ?? (plugin.diagnostics.map((diagnostic) => diagnostic.message).join('; ') || 'activation failed')
  }))
}

export function checkJsonStore(home: string, path: string, ownerGrants: unknown, credentialStatus: unknown): { ok: boolean; detail: string } {
  try {
    const file = join(home, path)
    if (path.endsWith('/e2ee-keypair.json') || path.endsWith('/devices.json')) {
      for (const name of ['e2ee-keypair.json', 'devices.json']) {
        try {
          lstatSync(join(dirname(file), name))
          return { ok: false, detail: 'mobile pairing files were recreated after quarantine' }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      return { ok: true, detail: 'mobile pairing remains quarantined' }
    }
    if (path.endsWith('/owner-grants.json')) {
      return { ok: !existsSync(file) && Array.isArray(ownerGrants) && ownerGrants.length === 0, detail: 'owner grants are not empty and absent' }
    }
    if (path.endsWith('/usage-credentials.json')) {
      return {
        ok: !existsSync(file) && Array.isArray(credentialStatus) && credentialStatus.length > 0 &&
          credentialStatus.every((status) => status.configured === false && status.readable === true),
        detail: 'credentials are not empty and readable'
      }
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (path.endsWith('/browser-state.json')) {
      return {
        ok: JSON.stringify(parsed.profiles) === JSON.stringify([{ id: 'default', label: 'Default', scope: 'default' }]) &&
          Array.isArray(parsed.pages) && parsed.pages.length === 0,
        detail: 'invalid browser metadata'
      }
    }
    return {
      ok: Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65_535 &&
        typeof parsed.token === 'string' && parsed.token.length >= 16 && typeof parsed.hookToken === 'string' && parsed.hookToken.length >= 16,
      detail: 'invalid daemon identity'
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function runCorruptionSweep(options: { mode: CorruptionMode; repoRoot: string }): Promise<SweepResult> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-corrupt-stores-'))
  try {
    return await sweepInRoot(root, options)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function sweepInRoot(root: string, options: { mode: CorruptionMode; repoRoot: string }): Promise<SweepResult> {
  const home = join(root, '.quirky')
  mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 })
  const installed = installSweepStandIns(root)
  const env = {
    ...createIsolatedRuntimeEnvironment(root, { repoRoot: options.repoRoot }),
    QUIRKY_HOME: home,
    PATH: [installed.fakebin, dirname(process.execPath), '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
    QUIRKY_MOBILE_HOST: '127.0.0.1',
    QUIRKY_MOBILE_PORT: '0',
    BUN_OPTIONS: `--preload=${installed.preload}`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'
  }
  const scope = createProcessScope(home)
  let child: Bun.Subprocess<'ignore', number, number> | undefined
  let client: QuirkyClient | undefined
  const logPath = join(root, 'daemon.log')
  let logFd: number | undefined
  const result: SweepResult = {
    mode: options.mode, activeBefore: [], firstStartReport: [], restartReport: [], thirdStartReport: [],
    stores: [], unlistedJson: [], mobileListenerHosts: [], mobileStateErrors: [], ownerGrants: null, credentialStatus: null,
    newCorruptOnThirdStart: [], newCorruptAfterRestart: [],
    standIns: { selfTest: { security: false, egress: false }, calls: [], refusedEgress: [] }
  }
  const stop = async () => {
    client?.close()
    client = undefined
    if (child) {
      child.kill('SIGTERM')
      await Promise.race([child.exited, Bun.sleep(5_000)])
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
      child = undefined
    }
    if (logFd !== undefined) closeSync(logFd)
    logFd = undefined
  }
  const call = async (method: string): Promise<unknown> => {
    try { return await client!.callAny(method, {}) }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }
  const start = async () => {
    logFd = openSync(logPath, 'a', 0o600)
    child = scope.spawn([process.execPath, 'packages/daemon/src/main.ts'], {
      cwd: options.repoRoot, env, stdin: 'ignore', stdout: logFd, stderr: logFd
    })
    const deadline = Date.now() + 30_000
    let healthy = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}`)
      const runtime = readRuntime(home)
      if (runtime?.pid === child.pid) {
        try {
          if ((await fetch(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(1_000) })).ok) {
            healthy = true
            break
          }
        } catch {}
      }
      await Bun.sleep(100)
    }
    if (!healthy) throw new Error('daemon health deadline exceeded')
    client = await connectDaemon({ home, role: 'cli', name: 'corrupt-stores', autostart: false })
    const plugins = await client.call('plugin.list', {})
    for (const plugin of plugins) {
      if (plugin.state !== 'inactive') continue
      try { await client.call('plugin.activate', { pluginId: plugin.id }) } catch {}
    }
    const activated = await client.call('plugin.list', {})
    const mobile = await call('quirky.mobile/state') as { listener?: { host?: string }; error?: string }
    result.mobileListenerHosts.push(mobile.listener?.host ?? null)
    result.mobileStateErrors!.push(mobile.error?.replace(/^quirky\.mobile: /, '') ?? null)
    return activated
  }
  try {
    const security = scope.spawn(['/bin/sh', '-c', 'security find-generic-password -s quirky-corrupt-stores-self-test'], {
      env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
    })
    result.standIns.selfTest.security = await security.exited === 97 &&
      readFileSync(installed.standInLog, 'utf8') === 'security find-generic-password -s quirky-corrupt-stores-self-test\n'
    const testUrl = 'https://example.invalid/quirky-corrupt-stores-self-test'
    const egress = scope.spawn([process.execPath, '-e', `await fetch('${testUrl}').then(() => process.exit(3), () => process.exit(0))`], {
      env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
    })
    result.standIns.selfTest.egress = await egress.exited === 0 && readFileSync(installed.egressLog, 'utf8') === testUrl + '\n'
    if (!result.standIns.selfTest.security || !result.standIns.selfTest.egress) return result
    writeFileSync(installed.standInLog, '')
    writeFileSync(installed.egressLog, '')
    const initial = await start()
    result.activeBefore = initial.filter((plugin) => plugin.state === 'active').map((plugin) => plugin.id)
    result.firstStartReport = reportPlugins(initial)
    await stop()
    const grant = {
      grantId: randomUUID(), name: 'sweep', endpoint: 'ws://127.0.0.1:1',
      token: randomBytes(24).toString('hex'), createdAt: Date.now()
    }
    result.seededOwnerGrant = {
      grantId: grant.grantId, name: grant.name, endpoint: grant.endpoint,
      scope: 'owner-cli', createdAt: grant.createdAt
    }
    const seeds = [
      [JSON_STORES[1]!.path, { version: 1, grants: [grant] }],
      [JSON_STORES[2]!.path, { zcode: { 'base-url': 'https://api.z.ai' } }]
    ] as const
    for (const [path, value] of seeds) {
      const file = join(home, path)
      if (existsSync(file)) continue
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    }
    const inventory = inventoryStores(home)
    const listed = new Set(JSON_STORES.map((store) => store.path))
    result.unlistedJson = inventory.filter((store) => store.kind === 'json' && !listed.has(store.path)).map((store) => store.path)
    const before = new Set(corruptFiles(home))
    const originals = new Map<string, Buffer>()
    const damages = new Map<string, Buffer>()
    result.stores = inventory.map((store) => {
      const damaged = options.mode !== 'healthy' && (store.kind === 'sqlite' || listed.has(store.path))
      const original = readFileSync(join(home, store.path))
      originals.set(store.path, original)
      const written = damaged ? damageStore(join(home, store.path), store.kind, options.mode as Exclude<CorruptionMode, 'healthy'>) : null
      if (written) damages.set(store.path, written)
      return { ...store, damaged, damageChanged: written ? !written.equals(original) : null, outcome: null, check: null }
    })
    result.restartReport = reportPlugins(await start())
    const refresh = async (stage: 'restart' | 'third-start') => {
      result.ownerGrants = await call('quirky.mobile/ownerGrants')
      result.credentialStatus = await call('quirky.accounts/credentialStatus')
      for (const store of result.stores) {
        const written = damages.get(store.path)
        if (written) store.outcome = classifyStore(home, store, written, before)
        const spec = JSON_STORES.find((entry) => entry.path === store.path)
        if (options.mode !== 'healthy' && spec && spec.checkAfter === stage) {
          store.check = checkJsonStore(home, store.path, result.ownerGrants, result.credentialStatus)
        }
        if (store.kind === 'json' && written && store.outcome === 'quarantined') {
          store.siblingBytesMatch = newSiblings(home, store, before).some((path) => readFileSync(join(home, path)).equals(written))
        }
      }
    }
    const deadline = Date.now() + 10_000
    do {
      await refresh('restart')
      const pending = result.stores.some((store) => store.damaged &&
        (store.outcome === 'untouched' || store.check?.ok === false))
      if (!pending || Date.now() >= deadline) break
      await Bun.sleep(250)
    } while (true)
    const afterRestart = new Set(corruptFiles(home))
    result.newCorruptAfterRestart = [...afterRestart].filter((name) => !before.has(name))
    await stop()
    result.thirdStartReport = reportPlugins(await start())
    await refresh('third-start')
    result.newCorruptOnThirdStart = corruptFiles(home).filter((name) => !afterRestart.has(name))
    if (options.mode === 'healthy') {
      const browser = result.stores.find((store) => store.path === JSON_STORES[0]!.path)
      if (browser) browser.check = {
        ok: readFileSync(join(home, browser.path)).equals(originals.get(browser.path)!),
        detail: 'browser bytes changed'
      }
    }
    await stop()
    result.standIns.calls = readFileSync(installed.standInLog, 'utf8').split('\n').filter(Boolean)
    result.standIns.refusedEgress = readFileSync(installed.egressLog, 'utf8').split('\n').filter(Boolean)
    return result
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''}`, { cause: error })
  } finally {
    try { await stop() } finally { await scope.cleanup() }
  }
}

async function main(): Promise<void> {
  const modes: CorruptionMode[] = []
  let out: string | undefined
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--out' && !out && args[index + 1]) out = args[++index]
    else if (flag === '--mode' && ['garbage', 'truncate', 'shape', 'healthy'].includes(args[index + 1] ?? '')) modes.push(args[++index] as CorruptionMode)
    else {
      console.error('usage: bun scripts/corrupt-stores.ts [--mode garbage|truncate|shape|healthy]... --out <new file>')
      process.exitCode = 2
      return
    }
  }
  let fd: number
  try {
    if (!out) throw new Error('missing --out')
    fd = openSync(out, 'wx', 0o600)
  } catch {
    console.error('usage: bun scripts/corrupt-stores.ts [--mode garbage|truncate|shape|healthy]... --out <new file>')
    process.exitCode = 2
    return
  }
  const failures: string[] = []
  const emit = (value: unknown) => {
    const line = JSON.stringify(value)
    console.log(line)
    writeFileSync(fd, line + '\n')
  }
  try {
    for (const mode of modes.length ? modes : ['garbage', 'truncate', 'shape', 'healthy'] as const) {
      const result = await runCorruptionSweep({ mode, repoRoot: resolve(import.meta.dir, '..') })
      emit(result)
      failures.push(...sweepFailures(result).map((failure) => `${mode}:${failure}`))
    }
    emit({ ok: failures.length === 0, failures })
    process.exitCode = failures.length === 0 ? 0 : 1
  } finally { closeSync(fd) }
}

if (import.meta.main) await main()
