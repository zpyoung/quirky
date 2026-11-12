import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { BrowserStore } from '../src/profiles/store'
import { CdpTimeoutError } from '../src/runtime/cdp'
import { BrowserRuntime } from '../src/runtime/driver'
import { BrowserFault, fault } from '../src/runtime/errors'

type FakeEpoch = { id: string; profileId: string; invalid: boolean; stopping: boolean; cdp: { send(method: string): Promise<unknown>; close(): void }; helper: { asyncClose(): Promise<void>; socketDir: string; socketAliasRoot: string }; chrome: { asyncClose(): Promise<void>; profileRoot: string }; pages: Map<string, unknown> }

function setup(probe: () => Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'browser-timeouts-'))
  const store = new BrowserStore(root)
  const runtime = new BrowserRuntime(store, {} as never, () => {})
  const profileId = store.createProfile('Timeouts').id
  const epoch: FakeEpoch = {
    id: 'epoch-1', profileId, invalid: false, stopping: false, pages: new Map(),
    cdp: { send: async (method) => method === 'Browser.getVersion' ? await probe() : {}, close: () => {} },
    helper: { asyncClose: async () => {}, socketDir: join(root, 'sock'), socketAliasRoot: join(root, 'alias') },
    chrome: { asyncClose: async () => {}, profileRoot: join(root, 'chrome') }
  }
  Reflect.set(Reflect.get(runtime, 'profile').call(runtime, profileId), 'epoch', epoch)
  return { runtime, profileId, epoch, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('a CDP command timeout on a responsive Chrome is reported as that timeout and keeps the epoch', async () => {
  const t = setup(async () => ({ product: 'Chrome' }))
  try {
    const failure = await t.runtime.withProfileLock(t.profileId, async () => { throw new CdpTimeoutError('Page.navigate') }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BrowserFault)
    expect((failure as BrowserFault).reason).toBe('browser_timeout')
    expect(t.epoch.invalid).toBe(false)
  } finally { t.cleanup() }
})

test('a fault that mentions a timeout does not invalidate the epoch', async () => {
  const t = setup(async () => ({}))
  try {
    const failure = await t.runtime.withProfileLock(t.profileId, async () => { throw fault('browser_timeout', 'navigation to http://x/ timed out') }).catch((error: unknown) => error)
    expect((failure as BrowserFault).reason).toBe('browser_timeout')
    expect(t.epoch.invalid).toBe(false)
  } finally { t.cleanup() }
})

test('a CDP command timeout on an unresponsive Chrome still invalidates the epoch', async () => {
  const t = setup(async () => { throw new CdpTimeoutError('Browser.getVersion') })
  try {
    const failure = await t.runtime.withProfileLock(t.profileId, async () => { throw new CdpTimeoutError('Page.navigate') }).catch((error: unknown) => error)
    expect((failure as BrowserFault).reason).toBe('browser_tab_changed')
    expect(t.epoch.invalid).toBe(true)
  } finally { t.cleanup() }
})

test('a closed websocket still invalidates the epoch', async () => {
  const t = setup(async () => ({}))
  try {
    const failure = await t.runtime.withProfileLock(t.profileId, async () => { throw new Error('CDP websocket closed') }).catch((error: unknown) => error)
    expect((failure as BrowserFault).reason).toBe('browser_tab_changed')
    expect(t.epoch.invalid).toBe(true)
  } finally { t.cleanup() }
})
