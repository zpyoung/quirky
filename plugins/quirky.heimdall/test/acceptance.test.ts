import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import type { Inspection } from '../src/contracts'
import { startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'

const PLUGINS_DIR = resolve(import.meta.dir, '../..')
const FIXTURE_ID = 'quirky.heimdall-fixture'
const KERNEL_METHOD = 'quirky.heimdall'

let root: string
let home: string
let userHome: string
let builtinPluginsDir: string
let counterFile: string
let startedFile: string
let releaseFile: string
let harness!: Harness
let client!: QuirkyClient
let daemonStopped = false
let ptyStopped = false
let oldHome: string | undefined

beforeEach(async () => {
  daemonStopped = false
  ptyStopped = false
  root = mkdtempSync(join(tmpdir(), 'heimdall-accept-'))
  home = join(root, 'quirky-home')
  userHome = join(root, 'user-home')
  builtinPluginsDir = join(root, 'builtins')
  counterFile = join(root, 'executions.log')
  startedFile = join(root, 'execute-started')
  releaseFile = join(root, 'release-execute')
  mkdirSync(home, { recursive: true })
  mkdirSync(userHome, { recursive: true })
  mkdirSync(builtinPluginsDir, { recursive: true })
  linkRequiredPlugins('quirky.heimdall')
  writePlugin(builtinPluginsDir, {
    id: FIXTURE_ID,
    name: 'Heimdall acceptance kind',
    version: '1.0.0',
    main: 'main.ts',
    activation: 'startup',
    dependencies: [KERNEL_METHOD],
    contributes: {
      method: ['authorize', 'read', 'decide', 'execute', 'resolveOutcome'].map((id) => ({
        id,
        params: { type: 'object', additionalProperties: true },
        result: {}
      }))
    }
  }, {
    'main.ts': fixtureSource(counterFile, startedFile, releaseFile)
  })
  oldHome = process.env.HOME
  process.env.HOME = userHome
  harness = await startHarness({ home, builtinPluginsDir })
  client = await harness.connect('cli')
})

afterEach(async () => {
  if (releaseFile && !existsSync(releaseFile)) writeFileSync(releaseFile, 'release')
  if (harness) {
    for (const open of harness.clients) open.close()
    if (!daemonStopped) await harness.daemon.stop()
    if (!ptyStopped) harness.pty.stop()
  }
  rmSync(root, { recursive: true, force: true })
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
})

describe('Heimdall daemon acceptance', () => {
  test('registers a real fixture kind, enrolls immediately, inspects, and reconciles through RPC', async () => {
    const result = await client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture', kindPayload: { valid: true, workspace: 'main', action: 'none' }
    }) as { kind: 'enrolled' | 're-armed'; enrollment: { watcherId: string } }
    expect(result.kind).toBe('enrolled')

    const watcherId = result.enrollment.watcherId
    const initial = await waitForAsync(async () => {
      const all = await client.callAny(`${KERNEL_METHOD}/inspect`, {}) as Inspection[]
      return all.find((item) => item.enrollment.watcherId === watcherId && item.traces.length > 0)
    })
    expect(initial).toMatchObject({
      enrollment: { watcherId, kind: 'fixture', enabled: true, paused: false },
      readOnly: false,
      status: { state: 'watching' },
      summary: null,
      budget: { exhausted: null, turns: 0 }
    })

    const selected = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
    expect(selected).toHaveLength(1)
    expect(selected[0]?.enrollment.watcherId).toBe(watcherId)

    writeFileSync(join(builtinPluginsDir, FIXTURE_ID, 'world-revision'), 'after-explicit-reconcile')
    const reconciled = await client.callAny(`${KERNEL_METHOD}/reconcile`, { watcherId }) as Inspection
    expect(reconciled.traces.at(-1)?.contentIdentity).toBe('after-explicit-reconcile')
    expect(reconciled.traces.at(-1)?.decision).toMatchObject({ action: null, reason: 'fixture-idle' })
    expect(existsSync(counterFile) ? readFileSync(counterFile, 'utf8') : '').toBe('')

    await expect(client.callAny(`${KERNEL_METHOD}/registerKind`, {
      id: 'forged', displayName: 'Forged', enrollmentPayloadSchema: {},
      hooks: { authorize: `${FIXTURE_ID}/authorize`, read: `${FIXTURE_ID}/read`, decide: `${FIXTURE_ID}/decide`, execute: `${FIXTURE_ID}/execute` },
      pluginId: FIXTURE_ID
    })).rejects.toThrow()
    expect(readFileSync(join(builtinPluginsDir, FIXTURE_ID, 'bad-registration'), 'utf8')).toBe('refused')
    expect(readFileSync(join(builtinPluginsDir, FIXTURE_ID, 'missing-hook-registration'), 'utf8')).toBe('refused')
  })
  test('keeps a schema-invalid persisted payload inspectable and never schedules it', async () => {
    const enrolled = await client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture',
      kindPayload: { valid: true, workspace: 'malformed', action: 'none' },
      capabilities: { 'fixture.write': 'on' }
    }) as { enrollment: { watcherId: string } }
    const watcherId = enrolled.enrollment.watcherId
    const beforeRestart = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
      return item && item.traces.length > 0 ? item : undefined
    })

    await stopDaemonKeepingHome(harness)
    const database = new Database(join(home, 'plugin-data', KERNEL_METHOD, 'store.db'))
    let changes = 0
    try {
      const update = database.query(
        'UPDATE enrollments SET kind_payload_json = ? WHERE watcher_id = ?'
      ).run(JSON.stringify({ workspace: 'malformed', action: 'uncertain' }), watcherId)
      changes = Number(update.changes)
    } finally {
      database.close()
    }
    expect(changes).toBe(1)

    harness = await startWithHome()
    client = await harness.connect('cli')
    daemonStopped = false
    ptyStopped = false
    const malformed = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
      return item?.enrollment.malformed !== undefined ? item : undefined
    })
    expect(malformed.status).toMatchObject({ state: 'malformed' })
    expect(malformed.traces).toHaveLength(beforeRestart.traces.length)
    expect(existsSync(counterFile)).toBe(false)
  })
  test('inspects a future schema read-only without scheduling or writing', async () => {
    const enrolled = await client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture', kindPayload: { valid: true, workspace: 'forward-schema', action: 'none' }
    }) as { enrollment: { watcherId: string } }
    const watcherId = enrolled.enrollment.watcherId
    const beforeRestart = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
      return item && item.traces.length > 0 ? item : undefined
    })

    await stopDaemonKeepingHome(harness)
    const database = new Database(join(home, 'plugin-data', KERNEL_METHOD, 'store.db'))
    let futureVersion = 0
    try {
      const currentVersion = databaseUserVersion(database)
      futureVersion = currentVersion + 1
      database.exec(`PRAGMA user_version = ${futureVersion}`)
    } finally {
      database.close()
    }

    harness = await startWithHome()
    client = await harness.connect('cli')
    daemonStopped = false
    ptyStopped = false
    const readOnly = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
      return item?.readOnly ? item : undefined
    })
    expect(readOnly.status).toBeNull()
    expect(readOnly.traces).toHaveLength(beforeRestart.traces.length)
    expect(readOnly.journal).toHaveLength(beforeRestart.journal.length)
    await expect(client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture', kindPayload: { valid: true, workspace: 'refused', action: 'none' }
    })).rejects.toThrow()
    await expect(client.callAny(`${KERNEL_METHOD}/reconcile`, { watcherId })).rejects.toThrow()
    const [afterRefusal] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
    expect(afterRefusal?.traces).toHaveLength(beforeRestart.traces.length)
    expect(afterRefusal?.journal).toHaveLength(beforeRestart.journal.length)

    await stopDaemonKeepingHome(harness)
    const verifyDb = new Database(join(home, 'plugin-data', KERNEL_METHOD, 'store.db'))
    try {
      expect(databaseUserVersion(verifyDb)).toBe(futureVersion)
    } finally {
      verifyDb.close()
    }
  })

  test('keeps an indeterminate write-ahead attempt unresolved across a real daemon restart', async () => {
    const enrolled = await client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture',
      kindPayload: { valid: true, workspace: 'uncertain', action: 'uncertain' },
      capabilities: { 'fixture.write': 'on' }
    }) as { enrollment: { watcherId: string } }
    const watcherId = enrolled.enrollment.watcherId

    await waitFor(() => existsSync(counterFile) && readFileSync(counterFile, 'utf8').trim().length > 0)
    const beforeRestart = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
      return item?.journal.some((entry) => entry.kind === 'attempt' && entry.effect === 'indeterminate') ? item : undefined
    })
    expect(beforeRestart.journal.filter((entry) => entry.kind === 'attempt').at(-1))
      .toMatchObject({ state: 'settled', effect: 'indeterminate' })
    expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(1)

    const previousTraceCount = beforeRestart.traces.length
    await stopDaemonKeepingHome(harness)
    harness = await startWithHome()
    client = await harness.connect('cli')
    daemonStopped = false
    ptyStopped = false

    const afterRestart = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
      return item && item.traces.length > previousTraceCount ? item : undefined
    })
    expect(afterRestart.journal.some((entry) => entry.kind === 'attempt' && entry.effect === 'indeterminate')).toBe(true)
    expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('holds a capability-off action and parks a zero-budget watcher before execution', async () => {
    const held = await client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture', kindPayload: { valid: true, workspace: 'gated', action: 'uncertain' }
    }) as { enrollment: { watcherId: string } }
    const heldId = held.enrollment.watcherId
    const heldInspection = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId: heldId }) as Inspection[]
      return item?.traces.some((trace) =>
        trace.gate && trace.gate.verdict !== 'allow' && trace.gate.reason === 'capability-off'
      ) ? item : undefined
    })
    expect(heldInspection.traces.at(-1)?.gate).toMatchObject({ verdict: 'hold', reason: 'capability-off' })

    const spent = await client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture',
      kindPayload: { valid: true, workspace: 'zero-budget', action: 'uncertain' },
      capabilities: { 'fixture.write': 'on' },
      budget: { wallClockActiveMs: 0, turns: null }
    }) as { enrollment: { watcherId: string } }
    const spentId = spent.enrollment.watcherId
    const exhausted = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId: spentId }) as Inspection[]
      return item?.status?.state === 'parked' ? item : undefined
    })
    expect(exhausted.status).toMatchObject({ state: 'parked', reason: 'budget' })
    expect(exhausted.budget.exhausted).toBe('budget-wall-clock')
    expect(existsSync(counterFile) ? readFileSync(counterFile, 'utf8') : '').toBe('')
  })

  test('shutdown fences an in-flight hook and restart preserves its unknown outcome', async () => {
    const enrolled = await client.callAny(`${KERNEL_METHOD}/enroll`, {
      kind: 'fixture',
      kindPayload: { valid: true, workspace: 'shutdown', action: 'blocked' },
      capabilities: { 'fixture.write': 'on' }
    }) as { enrollment: { watcherId: string } }
    await waitFor(() => existsSync(startedFile))
    const watcherId = enrolled.enrollment.watcherId
    const [beforeStop] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
    const attemptId = beforeStop!.journal.find((entry) => entry.kind === 'attempt')?.attemptId
    if (typeof attemptId !== 'string' || attemptId.length === 0) throw new Error('effect started without a durable attempt identity')

    await harness.daemon.stop()
    daemonStopped = true
    harness.pty.stop()
    ptyStopped = true
    expect(readFileSync(startedFile, 'utf8')).toBe('started')
    writeFileSync(releaseFile, 'release')
    await waitFor(() => readFileSync(startedFile, 'utf8') === 'complete')
    expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(1)
    harness = await startWithHome()
    client = await harness.connect('cli')
    daemonStopped = false
    ptyStopped = false
    const restored = await waitForAsync(async () => {
      const [item] = await client.callAny(`${KERNEL_METHOD}/inspect`, { watcherId }) as Inspection[]
      return item && item.traces.length > 0 ? item : undefined
    })
    const pending = restored.journal.filter((entry) => entry.kind === 'attempt' && entry.attemptId === attemptId).at(-1)
    if (!pending) throw new Error('restart lost the write-ahead attempt')
    expect(pending?.effect).not.toBe('landed')
    expect(pending?.effect).not.toBe('not-landed')
    expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})

async function startWithHome(): Promise<Harness> {
  process.env.HOME = userHome
  return startHarness({ home, builtinPluginsDir })
}

async function stopDaemonKeepingHome(current: Harness): Promise<void> {
  for (const open of current.clients) open.close()
  await current.daemon.stop()
  current.pty.stop()
  daemonStopped = true
  ptyStopped = true
}

function fixtureSource(counter: string, started: string, release: string): string {
  return `
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pluginId = ${JSON.stringify(FIXTURE_ID)}
const counterPath = ${JSON.stringify(counter)}
const startedPath = ${JSON.stringify(started)}
const releasePath = ${JSON.stringify(release)}
const hook = (name) => pluginId + '/' + name

export async function activate(context) {
  const descriptor = {
    id: 'fixture',
    displayName: 'Heimdall acceptance fixture',
    enrollmentPayloadSchema: { type: 'object', properties: { valid: { type: 'boolean' } }, required: ['valid'], additionalProperties: true },
    hooks: {
      authorize: hook('authorize'), read: hook('read'), decide: hook('decide'),
      execute: hook('execute'), resolveOutcome: hook('resolveOutcome')
    }
  }

  context.provide('method:' + hook('authorize'), (params) => {
    const input = params.input ?? params
    const payload = input.kindPayload ?? {}
    const workspace = typeof payload.workspace === 'string' ? payload.workspace : 'main'
    if (!/^[a-z0-9-]+$/.test(workspace)) throw new Error('invalid fixture workspace')
    const path = join(context.dir, 'fixture-workspaces', workspace)
    mkdirSync(path, { recursive: true })
    const canonicalPath = realpathSync(path)
    return {
      workspaceKey: 'local::' + canonicalPath,
      workspacePath: canonicalPath,
      executionHostId: 'local',
      schedulerOwner: 'daemon',
      kindPayload: payload
    }
  })
  context.provide('method:' + hook('read'), () => {
    const revisionPath = join(context.dir, 'world-revision')
    const revision = existsSync(revisionPath) ? readFileSync(revisionPath, 'utf8') : 'fixture-live'
    return { freshness: 'live', contentIdentity: revision, observedAtMs: Date.now(), world: { revision } }
  })
  context.provide('method:' + hook('decide'), (params) => {
    const enrollment = params.enrollment ?? params
    const actionMode = enrollment.kindPayload?.action ?? 'none'
    if (actionMode === 'none') return { action: null, reason: 'fixture-idle', considered: ['fixture'] }
    return { action: {
      kind: 'fixture-write', capability: 'fixture.write', visibility: 'external',
      contentIdentity: params.snapshot?.contentIdentity ?? 'fixture-live',
      evidenceKey: 'fixture-evidence-v1',
      expectedState: { target: 'fixture-resource', before: { state: 'ready' } }
    }, considered: ['fixture-write'] }
  })
  context.provide('method:' + hook('execute'), async (params) => {
    const action = params.action ?? params
    const enrollment = params.enrollment ?? params.context?.enrollment ?? {}
    const actionMode = enrollment.kindPayload?.action ?? 'uncertain'
    appendFileSync(counterPath, action.kind + '\\n')
    if (actionMode === 'blocked') {
      writeFileSync(startedPath, 'started')
      while (!existsSync(releasePath)) await Bun.sleep(5)
      writeFileSync(startedPath, 'complete')
      return { effect: 'landed' }
    }
    return actionMode === 'uncertain'
      ? { effect: 'indeterminate', reason: 'fixture lost reply' }
      : { effect: 'landed' }
  })
  context.provide('method:' + hook('resolveOutcome'), () => null)
  await context.call('quirky.heimdall/registerKind', descriptor)

  try {
    await context.call('quirky.heimdall/registerKind', {
      ...descriptor,
      id: 'forged',
      hooks: { ...descriptor.hooks, read: 'quirky.other/read' }
    })
    writeFileSync(join(context.dir, 'bad-registration'), 'accepted')
  } catch {
    writeFileSync(join(context.dir, 'bad-registration'), 'refused')
  }
  try {
    await context.call('quirky.heimdall/registerKind', {
      ...descriptor,
      id: 'missing-method',
      hooks: { ...descriptor.hooks, read: hook('notDeclared') }
    })
    writeFileSync(join(context.dir, 'missing-hook-registration'), 'accepted')
  } catch {
    writeFileSync(join(context.dir, 'missing-hook-registration'), 'refused')
  }
}
`
}
function linkRequiredPlugins(pluginId: string, linked = new Set<string>()): void {
  if (linked.has(pluginId)) return
  const pluginDir = join(PLUGINS_DIR, pluginId)
  const manifestPath = join(pluginDir, 'quirky-plugin.json')
  if (!existsSync(manifestPath)) throw new Error(`required built-in plugin ${pluginId} is unavailable`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: unknown }
  linked.add(pluginId)
  symlinkSync(pluginDir, join(builtinPluginsDir, pluginId))
  if (Array.isArray(manifest.dependencies)) {
    for (const dependency of manifest.dependencies) {
      if (typeof dependency === 'string') linkRequiredPlugins(dependency, linked)
    }
  }
}
function databaseUserVersion(database: Database): number {
  const row = database.query('PRAGMA user_version').get()
  if (typeof row !== 'object' || row === null || !('user_version' in row) || typeof row.user_version !== 'number') {
    throw new Error('SQLite returned no valid user_version')
  }
  return row.user_version
}
