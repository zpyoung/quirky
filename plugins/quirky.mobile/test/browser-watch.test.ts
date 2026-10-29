import { afterEach, expect, test } from 'bun:test'
import type { MobileWorkspaceTab, QuirkyClient } from '@quirky/protocol'
import { startBrowserHarness, type BrowserTestHarness } from '../../quirky.browser/test/harness'

type MobileWatch = { tab: MobileWorkspaceTab; watchId: string }
type MobileFrame = {
  tabId: string
  worktreeId: string
  watchId: string
  sequence: number
  width: number
  height: number
  mimeType: 'image/jpeg'
  data: string
}
let harness: BrowserTestHarness | undefined
let previousPort: string | undefined

afterEach(async () => {
  if (harness) await harness.cleanup()
  harness = undefined
  if (previousPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
  else process.env.QUIRKY_MOBILE_PORT = previousPort
  previousPort = undefined
})

const call = <T>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>

async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await read()
    if (value != null) return value
    // CDP frame delivery is an external runtime event; fake timers cannot produce it.
    await Bun.sleep(20)
  }
  throw new Error(`Watch fixture condition did not become true within ${timeoutMs}ms`)
}

test('mobile Watch uses real worktree tab identity, bounded frames and connection-owned leases', async () => {
  previousPort = process.env.QUIRKY_MOBILE_PORT
  process.env.QUIRKY_MOBILE_PORT = '0'
  harness = await startBrowserHarness({}, { includeMobile: true })
  const first = harness.client
  const second = await harness.daemon.connect('cli')
  const worktree = await harness.addFolderWorktree('mobile-watch')
  const created = await call<MobileWatch>(first, 'quirky.mobile/browserWatchCreate', {
    worktree, url: `${harness.fixtureUrl}events`
  })
  expect(created.tab).toMatchObject({ worktreeId: worktree, kind: 'browser', dirty: false })
  expect(created.tab.tabId).toBeTruthy()
  expect(created.tab.tabId).not.toBe(created.watchId)

  const tabs = await call<MobileWorkspaceTab[]>(first, 'quirky.mobile/sessionTabs', { worktree })
  expect(tabs).toContainEqual(created.tab)
  const paneState = await call<{ tabs: Array<{ id: string; tabId?: string; mode: string; page: string | null }> }>(first, 'quirky.browser/paneState', { worktree: `id:${worktree}` })
  const pane = paneState.tabs.find((tab) => tab.tabId === created.tab.tabId)
  expect(pane).toMatchObject({ mode: 'watch' })
  if (!pane?.page) throw new Error('The created Watch pane must own an agent page.')

  await expect(call(second, 'quirky.mobile/browserWatchFrame', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId
  })).rejects.toThrow()
  await expect(call(second, 'quirky.mobile/browserWatchStop', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId
  })).rejects.toThrow()
  await expect(call(first, 'quirky.browser/paneWatch', { pane: pane.id })).rejects.toThrow()
  await expect(call(first, 'quirky.browser/paneControl', { pane: pane.id, action: 'reload' })).rejects.toThrow()

  const frame = await waitFor(() => call<MobileFrame | null>(first, 'quirky.mobile/browserWatchFrame', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId
  }))
  expect(frame).toMatchObject({ tabId: created.tab.tabId, worktreeId: worktree, watchId: created.watchId, mimeType: 'image/jpeg' })
  expect(Buffer.from(frame.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  expect(Buffer.byteLength(frame.data, 'ascii')).toBeLessThanOrEqual(512 * 1024)
  const { value: point } = await call<{ value: { x: number; y: number; scale: number } }>(first, 'quirky.browser/eval', {
    page: pane.page,
    expression: '(() => { const rect = document.querySelector("#submit").getBoundingClientRect(); return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, scale: visualViewport.scale}; })()'
  })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call(first, 'quirky.mobile/browserWatchInput', {
      worktree, tabId: created.tab.tabId, watchId: created.watchId,
      kind: 'mouse', type, x: point.x * point.scale, y: point.y * point.scale, button: 'left'
    })
  }
  expect(await call(first, 'quirky.browser/eval', { page: pane.page, expression: 'document.querySelector("#result").textContent' }))
    .toMatchObject({ value: 'clicked' })
  const { value: inputPoint } = await call<{ value: { x: number; y: number; scale: number } }>(first, 'quirky.browser/eval', {
    page: pane.page,
    expression: '(() => { const rect = document.querySelector("#text").getBoundingClientRect(); return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, scale: visualViewport.scale}; })()'
  })
  const inputX = inputPoint.x * inputPoint.scale
  const inputY = inputPoint.y * inputPoint.scale
  expect(inputX).toBeGreaterThanOrEqual(0)
  expect(inputX).toBeLessThan(frame.width)
  expect(inputY).toBeGreaterThanOrEqual(0)
  expect(inputY).toBeLessThan(frame.height)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call(first, 'quirky.mobile/browserWatchInput', {
      worktree, tabId: created.tab.tabId, watchId: created.watchId,
      kind: 'mouse', type, x: inputX, y: inputY, button: 'left'
    })
  }
  const selectAllModifier = process.platform === 'darwin' ? 4 : 2
  const keyRecorder = await call<{ value: boolean }>(first, 'quirky.browser/eval', {
    page: pane.page,
    expression: `(() => {
      const input = document.querySelector('#text')
      if (!input) return false
      window.mobileWatchKeyEvents = []
      input.addEventListener('keydown', () => window.mobileWatchKeyEvents.push('keydown'))
      input.addEventListener('keyup', () => window.mobileWatchKeyEvents.push('keyup'))
      return true
    })()`
  })
  expect(keyRecorder.value).toBe(true)
  for (const type of ['keyDown', 'keyUp']) {
    await call(first, 'quirky.mobile/browserWatchInput', {
      worktree, tabId: created.tab.tabId, watchId: created.watchId,
      kind: 'key', type, key: 'a', modifiers: selectAllModifier
    })
  }
  await call(first, 'quirky.mobile/browserWatchInput', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId, kind: 'key', type: 'char', key: 'x', text: 'x'
  })
  const charValue = await call<{ value: string }>(first, 'quirky.browser/eval', {
    page: pane.page, expression: 'document.querySelector("#text").value'
  })
  expect(charValue.value).toBe('x')
  const keyEvents = await call<{ value: string[] }>(first, 'quirky.browser/eval', {
    page: pane.page, expression: 'window.mobileWatchKeyEvents'
  })
  expect(keyEvents.value).toContain('keydown')
  expect(keyEvents.value).toContain('keyup')

  for (const type of ['keyDown', 'keyUp']) {
    await call(first, 'quirky.mobile/browserWatchInput', {
      worktree, tabId: created.tab.tabId, watchId: created.watchId,
      kind: 'key', type, key: 'a', modifiers: selectAllModifier
    })
  }
  const longText = 'x'.repeat(4 * 1024 + 1)
  await call(first, 'quirky.mobile/browserWatchInput', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId, kind: 'text', text: longText
  })
  const longValue = await call<{ value: string }>(first, 'quirky.browser/eval', {
    page: pane.page, expression: 'document.querySelector("#text").value'
  })
  expect(longValue.value).toBe(longText)
  expect(await call(first, 'quirky.mobile/browserWatchControl', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId, action: 'reload'
  })).toMatchObject({ tabId: created.tab.tabId, worktreeId: worktree, kind: 'browser' })
  await expect(call(first, 'quirky.mobile/browserWatchFrameAck', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId, sequence: frame.sequence + 1
  })).rejects.toThrow()
  expect(await call(first, 'quirky.mobile/browserWatchFrameAck', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId, sequence: frame.sequence
  })).toMatchObject({ acknowledged: true })

  await expect(call(second, 'quirky.mobile/browserWatchStart', { worktree, tabId: created.tab.tabId })).rejects.toThrow()
  expect(await call(first, 'quirky.mobile/browserWatchStop', {
    worktree, tabId: created.tab.tabId, watchId: created.watchId
  })).toMatchObject({ closed: true })

  const native = await call<{ id: string; tabId: string; mode: string }>(first, 'quirky.browser/paneOpen', { worktree: `id:${worktree}`, mode: 'native' })
  expect(native.mode).toBe('native')
  const nativeTabs = await call<MobileWorkspaceTab[]>(first, 'quirky.mobile/sessionTabs', { worktree })
  expect(nativeTabs).toContainEqual(expect.objectContaining({ tabId: native.tabId, worktreeId: worktree, kind: 'browser', browserMode: 'native' }))
  await expect(call(first, 'quirky.mobile/browserWatchStart', { worktree, tabId: native.tabId })).rejects.toThrow(/Watch|Native/i)
  const resumed = await call<MobileWatch>(first, 'quirky.mobile/browserWatchStart', { worktree, tabId: created.tab.tabId })
  expect(resumed.watchId).not.toBe(created.watchId)
  first.close()
  const afterDisconnect = await waitFor(async () => {
    try {
      return await call<MobileWatch>(second, 'quirky.mobile/browserWatchStart', { worktree, tabId: created.tab.tabId })
    } catch {
      return null
    }
  })
  expect(afterDisconnect.watchId).not.toBe(resumed.watchId)
  await call(second, 'quirky.mobile/browserWatchStop', { worktree, tabId: created.tab.tabId, watchId: afterDisconnect.watchId })

  second.close()
})
