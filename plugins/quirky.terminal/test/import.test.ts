import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { base64ToBytes, QuirkyClient, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { makeTempHome, type Harness } from '../../../packages/daemon/test/helpers'
import {
  call,
  makeBuiltinDir,
  restartDaemon,
  seedPtySession,
  startPluginHarness,
  TERMINAL_PLUGINS,
  writeV1Sessions
} from './support'

let h: Harness | undefined
afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

const SETTING = 'setting:quirky.terminal/scrollback'

function writeV1Setting(home: string, key: string, value: unknown): void {
  const db = new Database(join(home, 'quirky.db'))
  try {
    db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  } finally {
    db.close()
  }
}

/** A v1 home: a PTY host holding `s_v1` and the v1 tables carrying its record and `scrollback`. */
async function v1Home(scrollback?: unknown): Promise<Harness> {
  const harness = await startPluginHarness({ real: [], fakes: ['quirky.worktree'] }, { home: makeTempHome() })
  await harness.daemon.stop()
  seedPtySession(harness, 's_v1', 'v1 output')
  writeV1Sessions(harness.home, [{ id: 's_v1' }])
  if (scrollback !== undefined) writeV1Setting(harness.home, 'terminalScrollback', scrollback)
  return harness
}

const full = (harness: Harness) => ({ builtinPluginsDir: makeBuiltinDir(harness.home, TERMINAL_PLUGINS, 'builtin-all') })

describe('SC-26: a v1 home carries over', () => {
  test('the imported session is attachable through the PTY host that kept it, and the scrollback setting is carried', async () => {
    h = await v1Home(4000)
    const restarted = await restartDaemon(h, full(h))
    const ws = await QuirkyClient.connect(rpcUrl(restarted.daemon.runtime), { role: 'ui' })
    try {
      expect((await call<Session[]>(ws, 'quirky.session/list')).map((s) => [s.id, s.status])).toEqual([['s_v1', 'running']])
      const attached = await call<{ replay: string }>(ws, 'quirky.terminal/attach', { session: 's_v1', cols: 80, rows: 24 })
      expect(new TextDecoder().decode(base64ToBytes(attached.replay))).toBe('v1 output')
      expect(await call(ws, 'setting.get', { id: SETTING })).toMatchObject({ value: 4000 })
    } finally {
      ws.close()
      await restarted.stop()
    }
  })

  test('a v1 scrollback outside the range is clamped, and one the user already set is kept', async () => {
    h = await v1Home(20000)
    const first = await restartDaemon(h, full(h))
    const ws = await QuirkyClient.connect(rpcUrl(first.daemon.runtime), { role: 'ui' })
    try {
      await call(ws, 'quirky.terminal/read', { session: 's_v1' })
      expect(await call(ws, 'setting.get', { id: SETTING })).toMatchObject({ value: 10000 })
      await call(ws, 'setting.set', { id: SETTING, value: 700 })
    } finally {
      ws.close()
      await first.stop()
    }
    const second = await restartDaemon(h, full(h))
    const again = await QuirkyClient.connect(rpcUrl(second.daemon.runtime), { role: 'ui' })
    try {
      await call(again, 'quirky.terminal/read', { session: 's_v1' })
      expect(await call(again, 'setting.get', { id: SETTING })).toMatchObject({ value: 700 })
    } finally {
      again.close()
      await second.stop()
    }
  })

  test('a v1 scrollback of the wrong type is skipped', async () => {
    h = await v1Home('lots')
    const restarted = await restartDaemon(h, full(h))
    const ws = await QuirkyClient.connect(rpcUrl(restarted.daemon.runtime), { role: 'ui' })
    try {
      await call(ws, 'quirky.terminal/read', { session: 's_v1' })
      expect(await call(ws, 'setting.get', { id: SETTING })).toMatchObject({ value: 2000 })
    } finally {
      ws.close()
      await restarted.stop()
    }
  })

  test('a second start does not copy the v1 value again', async () => {
    h = await v1Home(4000)
    const first = await restartDaemon(h, full(h))
    const ws = await QuirkyClient.connect(rpcUrl(first.daemon.runtime), { role: 'ui' })
    try {
      await call(ws, 'quirky.terminal/read', { session: 's_v1' })
      await call(ws, 'setting.reset', { id: SETTING })
    } finally {
      ws.close()
      await first.stop()
    }
    const second = await restartDaemon(h, full(h))
    const again = await QuirkyClient.connect(rpcUrl(second.daemon.runtime), { role: 'ui' })
    try {
      await call(again, 'quirky.terminal/read', { session: 's_v1' })
      expect(await call(again, 'setting.get', { id: SETTING })).toMatchObject({ value: 2000 })
    } finally {
      again.close()
      await second.stop()
    }
  })
})
