import { BrowserFailure, type CliReceipt } from './browser-world'
import type { BrowserCheck, CheckContext } from './browser-run'

type StorageArea = 'local' | 'session'
type StorageValue = { key: string; value: string | null }
type StorageWrite = { key: string; value: string }
type StorageClear = { cleared: boolean }
type ClipboardRead = { text: string }
type ClipboardWrite = { written: boolean }
type CookieRecord = {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  hostOnly: boolean
  expires?: number
  sameSite?: 'Strict' | 'Lax' | 'None'
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
}
type CookieList = { cookies: CookieRecord[] }
type CookieSet = { success: boolean }
type CookieDelete = { deleted: boolean }
type IdentityState = { mode: 'clean' | 'native'; active: 'clean' | 'native'; restartRequired: boolean }
type TabCreate = { browserPageId: string }
type TabProfile = { browserPageId: string; profileId: string; profileLabel: string }
type Evaluation<T> = { value: T }
type SettledEvaluation<T> = { ok: true; result: T } | { ok: false; error: unknown }

const STORAGE_KEY = 'parity'
const STORAGE_OTHER_KEY = 'parity-clear-proof'
const LOCAL_VALUE = 'local-proof'
const SESSION_VALUE = 'session-proof'
const PERSISTENT_COOKIE = 'parity'
const PERSISTENT_VALUE = 'persistent-proof'
const DISPOSABLE_COOKIE = 'parity-disposable'
const KEEP_COOKIE = 'parity-unrelated'
const DIALOG_RETRIES = 8
const DIALOG_RETRY_DELAY_MS = 50
const NO_PENDING_DIALOG_CODE = 'conflict'
const NO_PENDING_DIALOG_MESSAGE = 'browser_error: there is no pending JavaScript dialog for this page'


function persistentCookieExpiry(c: CheckContext): number {
  return Math.floor(c.world.fixture.startedAt / 1000) + 24 * 60 * 60
}

function fixturePageUrl(c: CheckContext): string {
  return new URL('/page', c.world.fixture.origin).href
}

async function ensurePeer(c: CheckContext): Promise<string> {
  let peer = c.state.peer
  if (!peer) {
    const created = await c.call<TabCreate>('tab create', {
      url: fixturePageUrl(c),
      profile: c.state.profileA,
      worktree: c.world.worktreeA
    }, '')
    peer = created.browserPageId
    c.state.peer = peer
  }

  const assignment = await c.call<TabProfile>('tab profile show', {}, peer)
  c.equal(assignment.browserPageId, peer, 'peer profile inspection targeted the created page')
  c.equal(assignment.profileId, c.state.profileA, 'peer shares A profile')
  return peer
}

function storageName(area: StorageArea): string {
  return area === 'local' ? 'localStorage' : 'sessionStorage'
}

function storageGetExpression(area: StorageArea, key: string): string {
  return `${storageName(area)}.getItem(${JSON.stringify(key)})`
}

function storagePairExpression(area: StorageArea): string {
  const name = storageName(area)
  return `({primary:${name}.getItem(${JSON.stringify(STORAGE_KEY)}),other:${name}.getItem(${JSON.stringify(STORAGE_OTHER_KEY)})})`
}

async function setStorage(c: CheckContext, area: StorageArea, key: string, value: string, page: string): Promise<StorageWrite> {
  return await c.call<StorageWrite>(`storage ${area} set`, { key, value }, page)
}

async function readStorage(c: CheckContext, area: StorageArea, key: string, page: string): Promise<StorageValue> {
  return await c.call<StorageValue>(`storage ${area} get`, { key }, page)
}

async function observeStorage(c: CheckContext, area: StorageArea, key: string, page: string): Promise<string | null> {
  return await c.observe<string | null>(storageGetExpression(area, key), page)
}

function assertCookie(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BrowserFailure('lost-cookie', message)
}

function requirePersistentCookie(c: CheckContext, cookies: CookieRecord[], value: string): CookieRecord {
  const hostname = new URL(c.world.fixture.origin).hostname
  const expiry = persistentCookieExpiry(c)
  const cookie = cookies.find(candidate => candidate.name === PERSISTENT_COOKIE &&
    candidate.domain === hostname && candidate.path === '/' && candidate.hostOnly && candidate.partitionKey === undefined)
  assertCookie(cookie !== undefined, 'persistent fixture cookie identity was not returned')
  assertCookie(cookie.value === value, 'persistent fixture cookie value did not persist')
  assertCookie(cookie.expires === expiry, 'persistent fixture cookie expiry did not match fixture start plus one day')
  return cookie
}

async function setPersistentCookie(c: CheckContext, name = PERSISTENT_COOKIE, value = PERSISTENT_VALUE): Promise<CookieSet> {
  return await c.call<CookieSet>('cookie set', {
    name,
    value,
    url: c.world.fixture.origin,
    path: '/',
    expires: persistentCookieExpiry(c)
  }, c.state.pageA)
}

function hasNoPendingDialog(receipt: CliReceipt): boolean {
  const result = receipt.result
  if (typeof result !== 'object' || result === null || Array.isArray(result) || !('error' in result)) return false
  const error = result.error
  if (typeof error !== 'object' || error === null || Array.isArray(error) || !('code' in error) || !('message' in error)) return false
  return error.code === NO_PENDING_DIALOG_CODE && error.message === NO_PENDING_DIALOG_MESSAGE
}

async function respondToDialog(c: CheckContext, accept: boolean, text?: string): Promise<unknown> {
  const words = accept ? 'dialog accept' : 'dialog dismiss'
  const flags: Record<string, string> = accept && text !== undefined ? { text } : {}
  for (let retry = 0; retry <= DIALOG_RETRIES; retry++) {
    const receipt = await c.probe(words, flags, c.state.pageA)
    if (receipt.exitCode === 0) {
      c.equal(receipt.result, accept ? { accepted: true } : { dismissed: true }, `${words} CLI result`)
      return receipt.result
    }
    if (!hasNoPendingDialog(receipt)) {
      throw new BrowserFailure('cli-nonzero', `${words} failed with an error other than the exact no-pending-dialog response`, receipt.stderrTail)
    }
    if (retry === DIALOG_RETRIES) {
      throw new BrowserFailure('cli-nonzero', `${words} still reported no pending dialog after bounded retries`, receipt.stderrTail)
    }
    await Bun.sleep(DIALOG_RETRY_DELAY_MS)
  }
  throw new BrowserFailure('cli-nonzero', `${words} response did not complete`)
}

async function exerciseDialog(c: CheckContext, accept: boolean): Promise<Record<string, unknown>> {
  const previous = c.world.fixture.dialogCount
  const otherPageState = '({title:document.title,input:document.querySelector("#text").value,result:document.querySelector("#result").textContent})'
  const otherBefore = await c.observe<{ title: string; input: string; result: string }>(otherPageState, c.state.pageB)
  c.equal(otherBefore, { title: 'Parity fixture', input: 'seed', result: '' }, 'B starts unchanged before dialog')
  const prompt = accept ? 'parity-accept-prompt' : 'parity-dismiss-confirm'
  const responseText = 'answer λ'
  const dialogCall = accept
    ? `window.prompt(${JSON.stringify(prompt)})`
    : `window.confirm(${JSON.stringify(prompt)})`
  const expression = `(async()=>{await fetch(${JSON.stringify(new URL('/dialog-opening', c.world.fixture.origin).href)},{method:'POST'});window.__parityDialogResult=${dialogCall};return window.__parityDialogResult})()`
  const evaluation = c.call<Evaluation<string | boolean | null>>('eval', { expression }, c.state.pageA).then(
    (result): SettledEvaluation<Evaluation<string | boolean | null>> => ({ ok: true, result }),
    (error): SettledEvaluation<Evaluation<string | boolean | null>> => ({ ok: false, error })
  )
  const opening = c.world.fixture.waitForDialog(previous).then(
    () => ({ kind: 'opened' as const }),
    error => ({ kind: 'fixture-error' as const, error })
  )
  const first = await Promise.race([opening, evaluation.then(result => ({ kind: 'evaluation' as const, result }))])
  if (first.kind === 'fixture-error') throw first.error
  if (first.kind === 'evaluation') {
    if (!first.result.ok) throw first.result.error
    throw new BrowserFailure('wrong-page', 'dialog evaluation completed before the fixture observed its opening request')
  }

  const openingRequests = c.world.fixture.requests.filter(request => request.path === '/dialog-opening' && request.method === 'POST').length
  c.equal(openingRequests, previous + 1, 'fixture observed the dialog-opening POST before responding')
  const otherDuring = await c.observe<{ title: string; input: string; result: string }>(otherPageState, c.state.pageB)
  c.equal(otherDuring, otherBefore, 'B remains responsive and unchanged while A has a pending dialog')
  const response = await respondToDialog(c, accept, accept ? responseText : undefined)
  const settled = await evaluation
  if (!settled.ok) throw settled.error

  const expected = accept ? responseText : false
  c.equal(settled.result.value, expected, 'dialog evaluation result')
  const pageResult = await c.observe<string | boolean | null>('window.__parityDialogResult', c.state.pageA)
  c.equal(pageResult, expected, 'dialog page state')
  const otherAfter = await c.observe<{ title: string; input: string; result: string }>(otherPageState, c.state.pageB)
  c.equal(otherAfter, otherBefore, 'B remains unchanged after A dialog response')
  return { response, evaluation: settled.result.value, pageResult, openingRequests, otherBefore, otherDuring, otherAfter }
}

async function checkStorageSet(c: CheckContext, area: StorageArea, value: string): Promise<Record<string, unknown>> {
  const peer = await ensurePeer(c)
  const result = await setStorage(c, area, STORAGE_KEY, value, c.state.pageA)
  c.equal(result, { key: STORAGE_KEY, value }, `${area} storage set result`)
  const pageValue = await observeStorage(c, area, STORAGE_KEY, c.state.pageA)
  const peerValue = await observeStorage(c, area, STORAGE_KEY, peer)
  const otherProfileValue = await observeStorage(c, area, STORAGE_KEY, c.state.pageB)
  c.equal(pageValue, value, `${area} storage on page A`)
  if (area === 'local') c.equal(peerValue, value, 'local storage is shared by A profile pages')
  else c.equal(peerValue, null, 'session storage is isolated to page A')
  c.equal(otherProfileValue, null, `${area} storage is isolated from profile B`)
  return { result, pageValue, peerValue, otherProfileValue }
}

async function checkStorageGet(c: CheckContext, area: StorageArea, value: string): Promise<Record<string, unknown>> {
  const peer = await ensurePeer(c)
  const seeded = await setStorage(c, area, STORAGE_KEY, value, c.state.pageA)
  c.equal(seeded, { key: STORAGE_KEY, value }, `${area} storage setup`)
  const fromA = await readStorage(c, area, STORAGE_KEY, c.state.pageA)
  const fromPeer = await readStorage(c, area, STORAGE_KEY, peer)
  const fromB = await readStorage(c, area, STORAGE_KEY, c.state.pageB)
  c.equal(fromA, { key: STORAGE_KEY, value }, `${area} storage CLI read on A`)
  c.equal(fromPeer, { key: STORAGE_KEY, value: area === 'local' ? value : null }, `${area} storage CLI read on A peer`)
  c.equal(fromB, { key: STORAGE_KEY, value: null }, `${area} storage CLI read on B`)
  const pageValue = await observeStorage(c, area, STORAGE_KEY, c.state.pageA)
  const peerValue = await observeStorage(c, area, STORAGE_KEY, peer)
  const otherProfileValue = await observeStorage(c, area, STORAGE_KEY, c.state.pageB)
  c.equal(pageValue, value, `${area} page storage observation on A`)
  c.equal(peerValue, area === 'local' ? value : null, `${area} page storage observation on A peer`)
  c.equal(otherProfileValue, null, `${area} page storage observation on B`)
  return { fromA, fromPeer, fromB, pageValue, peerValue, otherProfileValue }
}

async function checkStorageClear(c: CheckContext, area: StorageArea, value: string): Promise<Record<string, unknown>> {
  const peer = await ensurePeer(c)
  const seeded = await setStorage(c, area, STORAGE_KEY, value, c.state.pageA)
  const otherSeeded = await setStorage(c, area, STORAGE_OTHER_KEY, 'clear-proof', c.state.pageA)
  c.equal(seeded, { key: STORAGE_KEY, value }, `${area} clear primary setup`)
  c.equal(otherSeeded, { key: STORAGE_OTHER_KEY, value: 'clear-proof' }, `${area} clear unrelated setup`)
  const result = await c.call<StorageClear>(`storage ${area} clear`, { yes: true }, c.state.pageA)
  c.equal(result, { cleared: true }, `${area} storage clear result`)
  const primaryRead = await readStorage(c, area, STORAGE_KEY, c.state.pageA)
  const otherRead = await readStorage(c, area, STORAGE_OTHER_KEY, c.state.pageA)
  c.equal(primaryRead, { key: STORAGE_KEY, value: null }, `${area} clear primary CLI read`)
  c.equal(otherRead, { key: STORAGE_OTHER_KEY, value: null }, `${area} clear unrelated CLI read`)
  const pageState = await c.observe<{ primary: string | null; other: string | null }>(storagePairExpression(area), c.state.pageA)
  const peerState = await c.observe<{ primary: string | null; other: string | null }>(storagePairExpression(area), peer)
  const otherProfileState = await c.observe<{ primary: string | null; other: string | null }>(storagePairExpression(area), c.state.pageB)
  c.equal(pageState, { primary: null, other: null }, `${area} page storage after clear`)
  c.equal(peerState, { primary: null, other: null }, `${area} A-peer storage after clear`)
  c.equal(otherProfileState, { primary: null, other: null }, `${area} B storage after clear`)
  return { result, primaryRead, otherRead, pageState, peerState, otherProfileState }
}

export const stateChecks: BrowserCheck[] = [
  {
    id: 'clipboard-read',
    async run(c) {
      const expected = 'clipboard-proof λ'
      const write = await c.call<ClipboardWrite>('clipboard write', { text: expected }, c.state.pageA)
      c.equal(write, { written: true }, 'clipboard setup write')
      const result = await c.call<ClipboardRead>('clipboard read', {}, c.state.pageA)
      c.equal(result, { text: expected }, 'clipboard read CLI result')
      const pageText = await c.observe<string>('navigator.clipboard.readText()', c.state.pageA)
      c.equal(pageText, expected, 'owned Chromium clipboard page observation')
      return { result, pageText }
    }
  },
  {
    id: 'clipboard-write',
    async run(c) {
      const expected = 'clipboard-proof λ'
      const result = await c.call<ClipboardWrite>('clipboard write', { text: expected }, c.state.pageA)
      c.equal(result, { written: true }, 'clipboard write CLI result')
      const pageText = await c.observe<string>('navigator.clipboard.readText()', c.state.pageA)
      c.equal(pageText, expected, 'owned Chromium clipboard page observation')
      return { result, pageText }
    }
  },
  {
    id: 'dialog-accept',
    async run(c) {
      return await exerciseDialog(c, true)
    }
  },
  {
    id: 'dialog-dismiss',
    async run(c) {
      return await exerciseDialog(c, false)
    }
  },
  {
    id: 'storage-local-get',
    async run(c) {
      return await checkStorageGet(c, 'local', LOCAL_VALUE)
    }
  },
  {
    id: 'storage-local-set',
    async run(c) {
      return await checkStorageSet(c, 'local', LOCAL_VALUE)
    }
  },
  {
    id: 'storage-local-clear',
    async run(c) {
      return await checkStorageClear(c, 'local', LOCAL_VALUE)
    }
  },
  {
    id: 'storage-session-get',
    async run(c) {
      return await checkStorageGet(c, 'session', SESSION_VALUE)
    }
  },
  {
    id: 'storage-session-set',
    async run(c) {
      return await checkStorageSet(c, 'session', SESSION_VALUE)
    }
  },
  {
    id: 'storage-session-clear',
    async run(c) {
      return await checkStorageClear(c, 'session', SESSION_VALUE)
    }
  },
  {
    id: 'cookie-get',
    async run(c) {
      await setPersistentCookie(c)
      const result = await c.call<CookieList>('cookie get', { url: c.world.fixture.origin }, c.state.pageA)
      const cookie = requirePersistentCookie(c, result.cookies, PERSISTENT_VALUE)
      const pageCookies = await c.observe<string>('document.cookie', c.state.pageA)
      assertCookie(pageCookies.split(';').map(part => part.trim()).includes(`${PERSISTENT_COOKIE}=${PERSISTENT_VALUE}`), 'persistent cookie was missing from page document.cookie')
      return { result, cookie, pageCookies }
    }
  },
  {
    id: 'cookie-set',
    async run(c) {
      const result = await setPersistentCookie(c)
      c.equal(result, { success: true }, 'cookie set CLI result')
      const observed = await c.call<CookieList>('cookie get', { url: c.world.fixture.origin }, c.state.pageA)
      const cookie = requirePersistentCookie(c, observed.cookies, PERSISTENT_VALUE)
      const pageCookies = await c.observe<string>('document.cookie', c.state.pageA)
      assertCookie(pageCookies.split(';').map(part => part.trim()).includes(`${PERSISTENT_COOKIE}=${PERSISTENT_VALUE}`), 'persistent cookie was missing from independent page observation')
      return { result, cookie, pageCookies }
    }
  },
  {
    id: 'cookie-delete',
    async run(c) {
      await setPersistentCookie(c)
      const expires = persistentCookieExpiry(c)
      await c.call<CookieSet>('cookie set', {
        name: DISPOSABLE_COOKIE,
        value: 'delete-me',
        url: fixturePageUrl(c),
        path: '/',
        expires
      }, c.state.pageA)
      await c.call<CookieSet>('cookie set', {
        name: DISPOSABLE_COOKIE,
        value: 'keep-nested',
        url: fixturePageUrl(c),
        path: '/nested',
        expires
      }, c.state.pageA)
      await c.call<CookieSet>('cookie set', {
        name: KEEP_COOKIE,
        value: 'keep-proof',
        url: fixturePageUrl(c),
        path: '/',
        expires
      }, c.state.pageA)
      const result = await c.call<CookieDelete>('cookie delete', {
        name: DISPOSABLE_COOKIE,
        url: fixturePageUrl(c),
        path: '/',
        yes: true
      }, c.state.pageA)
      assertCookie(result.deleted, 'cookie delete did not report deleting the exact disposable cookie')
      const observed = await c.call<CookieList>('cookie get', {}, c.state.pageA)
      requirePersistentCookie(c, observed.cookies, PERSISTENT_VALUE)
      const disposable = observed.cookies.filter(cookie => cookie.name === DISPOSABLE_COOKIE)
      const keep = observed.cookies.find(cookie => cookie.name === KEEP_COOKIE && cookie.path === '/' && cookie.hostOnly)
      assertCookie(disposable.length === 1 && disposable[0]?.path === '/nested' && disposable[0]?.value === 'keep-nested', 'cookie delete removed or changed the same-name unrelated path identity')
      assertCookie(keep !== undefined && keep.value === 'keep-proof', 'cookie delete removed an unrelated cookie')
      const pageCookies = await c.observe<string>('document.cookie', c.state.pageA)
      const pairs = pageCookies.split(';').map(part => part.trim())
      assertCookie(pairs.includes(`${PERSISTENT_COOKIE}=${PERSISTENT_VALUE}`), 'cookie delete failed to preserve the persistent cookie')
      assertCookie(pairs.includes(`${KEEP_COOKIE}=keep-proof`), 'cookie delete failed to preserve the unrelated cookie in the page')
      assertCookie(!pairs.includes(`${DISPOSABLE_COOKIE}=delete-me`), 'deleted cookie remained visible to the page')
      return { result, remainingDisposable: disposable, keep, pageCookies }
    }
  },
  {
    id: 'browser-identity-get',
    async run(c) {
      const result = await c.call<IdentityState>('identity get', {}, '')
      c.equal(result, { mode: 'clean', active: 'clean', restartRequired: false }, 'initial clean identity state')
      const independentRead = await c.call<IdentityState>('identity get', {}, '')
      c.equal(independentRead, result, 'subsequent identity read')
      return { result, independentRead }
    }
  },
  {
    id: 'browser-identity-set',
    async run(c) {
      try {
        const result = await c.call<IdentityState>('identity set', { mode: 'native' }, '')
        c.equal(result, { mode: 'native', active: 'clean', restartRequired: true }, 'selected native identity remains clean and requires restart')
        const readback = await c.call<IdentityState>('identity get', {}, '')
        c.equal(readback, { mode: 'native', active: 'clean', restartRequired: true }, 'native identity CLI readback')
        return { result, readback }
      } finally {
        const restored = await c.call<IdentityState>('identity set', { mode: 'clean' }, '')
        c.equal(restored, { mode: 'clean', active: 'clean', restartRequired: false }, 'restore clean identity selection')
        const restoreReadback = await c.call<IdentityState>('identity get', {}, '')
        c.equal(restoreReadback, restored, 'independent clean identity restore readback')
      }
    }
  }
]
