import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginNotification, PluginStore, QuirkyEvent, StoreMigration } from '@quirky/protocol'
import { avatarMigrations } from '../store-migrations'
import { createApp } from '../src/app'
import type { AvatarApp, Mandate } from '../src/contracts'
import { createAvatarStore } from '../src/store'

/** A `PluginStore` over an in-memory SQLite database with `migrations` applied in order. */
export function memoryPluginStore(migrations: StoreMigration[] = avatarMigrations): PluginStore {
  const db = new Database(':memory:')
  const store: PluginStore = {
    version: migrations.length,
    run: (sql, ...params) => {
      const result = db.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: (sql, ...params) => (db.query(sql).get(...(params as never[])) as never) ?? null,
    all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work)()
  }
  for (const migration of migrations) {
    if (typeof migration === 'string') store.exec(migration)
    else migration(store)
  }
  return store
}

export type FakeCalls = Record<string, (params: Record<string, unknown>) => unknown>

export type TestApp = {
  app: AvatarApp
  context: PluginContext
  /** Method implementations for `context.call`; a method with none rejects with `no fake for <method>`. */
  fakeCalls: FakeCalls
  calls: { method: string; params: Record<string, unknown> }[]
  emitted: { event: string; data: unknown }[]
  notifications: PluginNotification[]
  /** Values `context.getSetting` answers with, by short setting name; unset names answer undefined. */
  settings: Record<string, unknown>
  /** Stores `context.openStore` handed out, oldest first. */
  openedStores: PluginStore[]
  /** What `context.provide` received, by contribution id. */
  provided: Map<string, unknown>
  /** Pushes an event to every `context.subscribe` listener. */
  deliver(event: QuirkyEvent): Promise<void>
  pty: FakePty
  hostPower: FakeHostPower
}

export type FakePty = {
  connected: true
  writes: { sessionId: string; data: string | Uint8Array }[]
  /** `lastUserInput` answers by session id. */
  userInput: Map<string, { session: string; expectedIncarnation: string; at: number }>
  screen: Map<string, string[]>
  write(sessionId: string, data: string | Uint8Array): void
  writeAccepted(sessionId: string, data: string | Uint8Array): Promise<void>
  read(sessionId: string): Promise<{ lines: string[]; cols: number; rows: number; alt: boolean }>
  lastUserInput(sessionId: string): { session: string; expectedIncarnation: string; at: number } | null
  onData(): () => void
  onExit(): () => void
  onFact(): () => void
  onInput(): () => void
  onUserInput(): () => void
  onReconnect(): () => void
}

export type FakeHostPower = {
  supported: true
  suspended: boolean
  /** One entry per `keepAwake` call; `active` turns false when its disposer runs. */
  holds: { reason: string; active: boolean }[]
  state: { onBattery: boolean; externalDisplay: boolean | null }
  subscribe(): () => void
  keepAwake(reason: string): () => void
  powerState(): { onBattery: boolean; externalDisplay: boolean | null }
}

function fakePty(): FakePty {
  const pty: FakePty = {
    connected: true,
    writes: [],
    userInput: new Map(),
    screen: new Map(),
    write: (sessionId, data) => void pty.writes.push({ sessionId, data }),
    writeAccepted: async (sessionId, data) => void pty.writes.push({ sessionId, data }),
    read: async (sessionId) => ({ lines: pty.screen.get(sessionId) ?? [], cols: 80, rows: 24, alt: false }),
    lastUserInput: (sessionId) => pty.userInput.get(sessionId) ?? null,
    onData: () => () => {},
    onExit: () => () => {},
    onFact: () => () => {},
    onInput: () => () => {},
    onUserInput: () => () => {},
    onReconnect: () => () => {}
  }
  return pty
}

function fakeHostPower(): FakeHostPower {
  const power: FakeHostPower = {
    supported: true,
    suspended: false,
    holds: [],
    state: { onBattery: false, externalDisplay: null },
    subscribe: () => () => {},
    keepAwake(reason) {
      const hold = { reason, active: true }
      power.holds.push(hold)
      return () => void (hold.active = false)
    },
    powerState: () => power.state
  }
  return power
}

/**
 * An `AvatarApp` over an in-memory store and a fake plugin context. The context records what the
 * plugin provides, emits, notifies and calls, and answers calls from `fakeCalls`.
 */
export function makeTestApp(overrides: { fakeCalls?: FakeCalls; settings?: Record<string, unknown> } = {}): TestApp {
  const fakeCalls: FakeCalls = { ...overrides.fakeCalls }
  const settings: Record<string, unknown> = { ...overrides.settings }
  const calls: TestApp['calls'] = []
  const emitted: TestApp['emitted'] = []
  const notifications: PluginNotification[] = []
  const provided = new Map<string, unknown>()
  const openedStores: PluginStore[] = []
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const pty = fakePty()
  const hostPower = fakeHostPower()
  const home = mkdtempSync(join(tmpdir(), 'avatar-test-'))

  const context = {
    pluginId: 'quirky.avatar',
    dir: join(import.meta.dir, '..'),
    dataDir: join(home, 'plugin-data', 'quirky.avatar'),
    home,
    pty,
    hostPower,
    log() {},
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    emit(event: string, data?: unknown) {
      emitted.push({ event, data })
      return true
    },
    notify: (notification: PluginNotification) => void notifications.push(notification),
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const fake = fakeCalls[method]
      if (fake === undefined) throw new Error(`no fake for ${method}`)
      return fake(params)
    },
    getSetting: (name: string) => settings[name],
    openStore: (migrations: StoreMigration[]) => {
      const store = memoryPluginStore(migrations)
      openedStores.push(store)
      return store
    },
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind })
  } as unknown as PluginContext

  const app = createApp(context, createAvatarStore(memoryPluginStore()))
  return {
    app,
    context,
    fakeCalls,
    calls,
    emitted,
    notifications,
    settings,
    openedStores,
    provided,
    deliver: async (event) => {
      for (const listener of [...listeners]) await listener(event)
    },
    pty,
    hostPower
  }
}

/** A complete mandate for `worktreeId` (default `wt-1`), with any field overridden. */
export function sampleMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    worktreeId: 'wt-1',
    goal: 'Fix the two failing checks',
    doneWhen: 'PR checks green',
    doneWhenKind: 'prose',
    guidelines: ['keep commits small'],
    level: 'own-branch',
    switches: { messaging: false, historyRewrite: false, deploys: false },
    agent: null,
    sharedGoalId: null,
    notes: '',
    allowSplit: false,
    updatedAt: 1_000,
    ...overrides
  }
}
