import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

const method = (name: string) => `quirky.browser/${name}`
const call = (client: BrowserTestHarness['client'], name: string, params: Record<string, unknown> = {}) =>
  client.callAny(method(name), params)
function eventQueue<T>() {
  const events: T[] = []
  const waiters: Array<{ predicate: (event: T) => boolean; resolve: (event: T) => void }> = []
  return {
    next(predicate: (event: T) => boolean = () => true): Promise<T> {
      const index = events.findIndex(predicate)
      if (index !== -1) return Promise.resolve(events.splice(index, 1)[0]!)
      const { promise, resolve } = Promise.withResolvers<T>()
      waiters.push({ predicate, resolve })
      return promise
    },
    push(event: T): void {
      const index = waiters.findIndex((waiter) => waiter.predicate(event))
      if (index === -1) events.push(event)
      else waiters.splice(index, 1)[0]!.resolve(event)
    },
    clear(): void { events.length = 0 }
  }
}

async function expectReason(
  client: BrowserTestHarness['client'],
  name: string,
  params: Record<string, unknown>,
  reason: string
): Promise<void> {
  let failure: unknown
  try { await call(client, name, params) } catch (error) { failure = error }
  expect(failure).toBeDefined()
  expect((failure instanceof Error ? failure.message : String(failure)).startsWith(`${reason}:`)).toBe(true)
}
async function expectSchemaFailure(
  client: BrowserTestHarness['client'],
  name: string,
  params: Record<string, unknown>
): Promise<void> {
  let failure: unknown
  try { await call(client, name, params) } catch (error) { failure = error }
  expect(failure).toBeDefined()
}

async function newPage(h: BrowserTestHarness, url = `${h.fixtureUrl}events`, extra: Record<string, unknown> = {}) {
  return (await call(h.client, 'tabCreate', { url, ...extra })) as { browserPageId: string }
}

async function runBrowserCli(h: BrowserTestHarness, argv: string[]) {
  let stdout = ''
  let stderr = ''
  const client = await h.daemon.connect('cli')
  const code = await run({
    argv,
    env: { QUIRKY_HOME: h.home },
    cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, { yes: argv.includes('--yes') }),
    openDesktopApp: async () => ({ ok: false, reason: 'not used' })
  })
  return { code, stdout, stderr }
}

test('SC-01: plugin metadata is lazy and owned Chrome browses local history', async () => {
  const h = await startBrowserHarness()
  try {
    expect((await call(h.client, 'profileList') as { profiles: Array<{ id: string }> }).profiles.map((p) => p.id)).toContain('default')
    expect((await call(h.client, 'tabList') as { tabs: unknown[] }).tabs).toEqual([])
    expect(h.spawnCount()).toBe(0)

    const created = await newPage(h, 'about:blank')
    expect(h.spawnCount()).toBe(2)
    expect(await call(h.client, 'tabCurrent')).toMatchObject({ tab: { browserPageId: created.browserPageId } })
    const shown = await call(h.client, 'tabShow', { page: created.browserPageId }) as { tab: { browserPageId: string; url: string } }
    expect(shown.tab).toMatchObject({ browserPageId: created.browserPageId, url: 'about:blank' })
    const first = await call(h.client, 'goto', { page: created.browserPageId, url: `${h.fixtureUrl}first` }) as { url: string; title: string }
    expect(first).toMatchObject({ url: `${h.fixtureUrl}first`, title: 'First' })
    await call(h.client, 'goto', { page: created.browserPageId, url: `${h.fixtureUrl}second` })
    expect(await call(h.client, 'back', { page: created.browserPageId })).toMatchObject({ url: `${h.fixtureUrl}first`, title: 'First' })
    expect(await call(h.client, 'forward', { page: created.browserPageId })).toMatchObject({ url: `${h.fixtureUrl}second`, title: 'Second' })
    expect(await call(h.client, 'reload', { page: created.browserPageId })).toMatchObject({ url: `${h.fixtureUrl}second`, title: 'Second' })
    await expectReason(h.client, 'goto', { page: created.browserPageId, url: 'javascript:alert(1)' }, 'invalid_argument')
    expect((await call(h.client, 'tabShow', { page: created.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}second`)
    const opened = await call(h.client, 'openUrl', { url: `${h.fixtureUrl}first` }) as { browserPageId: string }
    expect((await call(h.client, 'tabShow', { page: opened.browserPageId }) as { tab: { browserPageId: string; url: string; title: string } }).tab)
      .toMatchObject({ browserPageId: opened.browserPageId, url: `${h.fixtureUrl}first`, title: 'First' })
  } finally { await h.cleanup() }
}, 60_000)

test('SC-02 and DF-03: explicit page/worktree/cwd targeting; focus:true fails before mutation', async () => {
  const h = await startBrowserHarness()
  try {
    const cedar = await h.addFolderWorktree('Cedar')
    const birch = await h.addFolderWorktree('Birch')
    const a = await newPage(h, `${h.fixtureUrl}events`, { worktree: cedar })
    const b = await newPage(h, `${h.fixtureUrl}events`, { worktree: birch })
    await call(h.client, 'fill', { cwd: join(h.home, 'projects', 'Cedar'), element: '#text', value: 'only-cedar' })
    await call(h.client, 'fill', { page: b.browserPageId, element: '#text', value: 'only-birch' })
    expect((await call(h.client, 'get', { page: a.browserPageId, what: 'value', element: '#text' }) as { value: string }).value).toBe('only-cedar')
    expect((await call(h.client, 'get', { page: b.browserPageId, what: 'value', element: '#text' }) as { value: string }).value).toBe('only-birch')
    const c = await newPage(h, `${h.fixtureUrl}events`, { worktree: cedar })
    const all = await call(h.client, 'tabList', { worktree: 'all' }) as { tabs: Array<{ browserPageId: string; index: number; active: boolean }> }
    expect(all.tabs.map((tab) => tab.browserPageId).sort()).toEqual([a.browserPageId, b.browserPageId, c.browserPageId].sort())
    await call(h.client, 'tabSwitch', { page: c.browserPageId })
    expect((await call(h.client, 'tabCurrent', { worktree: cedar }) as { tab: { browserPageId: string; worktreeId: string } }).tab)
      .toMatchObject({ browserPageId: c.browserPageId, worktreeId: cedar })
    expect((await call(h.client, 'tabShow', { page: a.browserPageId, worktree: 'invalid-selector' }) as { tab: { browserPageId: string } }).tab.browserPageId).toBe(a.browserPageId)
    await expectReason(h.client, 'fill', { element: '#text', value: 'unscoped' }, 'browser_no_tab')
    await expectReason(h.client, 'fill', { page: 'not-a-browser-page', worktree: cedar, element: '#text', value: 'wrong' }, 'browser_tab_not_found')
    await expectReason(h.client, 'fill', { worktree: 'all', element: '#text', value: 'all-worktrees' }, 'invalid_argument')
    await expectSchemaFailure(h.client, 'fill', { page: a.browserPageId, element: '#text', value: 7 })
    await expectSchemaFailure(h.client, 'fill', { page: a.browserPageId, element: '#text', value: 'bad', extra: true })
    await expectSchemaFailure(h.client, 'goto', { page: a.browserPageId, url: 7 })
    await expectReason(h.client, 'tabSwitch', { page: a.browserPageId, index: 0 }, 'invalid_argument')
    expect((await call(h.client, 'get', { page: a.browserPageId, what: 'value', element: '#text' }) as { value: string }).value).toBe('only-cedar')
    expect((await call(h.client, 'get', { page: b.browserPageId, what: 'value', element: '#text' }) as { value: string }).value).toBe('only-birch')
    expect((await call(h.client, 'tabShow', { page: a.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}events`)
    const beforeFocus = (await call(h.client, 'tabList', { worktree: 'all' }) as { tabs: Array<{ browserPageId: string; active: boolean }> }).tabs
      .map(({ browserPageId, active }) => ({ browserPageId, active }))
      .sort((left, right) => left.browserPageId.localeCompare(right.browserPageId))
    expect(beforeFocus.find((tab) => tab.browserPageId === a.browserPageId)?.active).toBe(false)
    await expectReason(h.client, 'tabSwitch', { page: a.browserPageId, focus: true }, 'invalid_argument')
    const afterFocus = (await call(h.client, 'tabList', { worktree: 'all' }) as { tabs: Array<{ browserPageId: string; active: boolean }> }).tabs
      .map(({ browserPageId, active }) => ({ browserPageId, active }))
      .sort((left, right) => left.browserPageId.localeCompare(right.browserPageId))
    expect(afterFocus).toEqual(beforeFocus)
    expect((await call(h.client, 'tabCurrent', { worktree: cedar }) as { tab: { browserPageId: string } }).tab.browserPageId).toBe(c.browserPageId)
    const cedarIndex = all.tabs.find((tab) => tab.browserPageId === a.browserPageId)!.index
    const switchedByIndex = await call(h.client, 'tabSwitch', { index: cedarIndex, worktree: cedar }) as { switched: number; browserPageId: string }
    expect(switchedByIndex.browserPageId).toBe(a.browserPageId)
    expect((await call(h.client, 'tabCurrent', { worktree: cedar }) as { tab: { browserPageId: string } }).tab.browserPageId).toBe(a.browserPageId)
    const switched = await call(h.client, 'tabSwitch', { page: b.browserPageId }) as { switched: number; browserPageId: string }
    expect(switched.browserPageId).toBe(b.browserPageId)
    expect((await call(h.client, 'tabCurrent', { worktree: birch }) as { tab: { browserPageId: string } }).tab.browserPageId).toBe(b.browserPageId)
  } finally { await h.cleanup() }
}, 60_000)

test('SC-03 and DF-04: snapshot refs are page- and projection-bound', async () => {
  const h = await startBrowserHarness()
  try {
    const a = await newPage(h, `${h.fixtureUrl}events`)
    const b = await newPage(h, `${h.fixtureUrl}events`)
    const projection = await call(h.client, 'snapshot', { page: a.browserPageId }) as { projectionId: string; refs: Array<{ ref: string; role: string; name: string }> }
    expect(projection.projectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const submit = projection.refs.find((ref) => ref.name === 'Submit')
    expect(submit?.ref).toMatch(new RegExp(`^qbr1:${projection.projectionId}:\\d+$`))
    await call(h.client, 'click', { page: a.browserPageId, element: submit!.ref })
    const nextProjection = await call(h.client, 'snapshot', { page: a.browserPageId }) as { refs: Array<{ ref: string; name: string }> }
    await expectReason(h.client, 'click', { page: a.browserPageId, element: submit!.ref }, 'browser_stale_ref')
    const nextSubmit = nextProjection.refs.find((ref) => ref.name === 'Submit')
    expect(nextSubmit).toBeDefined()
    await call(h.client, 'click', { page: a.browserPageId, element: nextSubmit!.ref })
    await expectReason(h.client, 'click', { page: b.browserPageId, element: submit!.ref }, 'browser_stale_ref')
    await call(h.client, 'goto', { page: a.browserPageId, url: `${h.fixtureUrl}first` })
    await expectReason(h.client, 'click', { page: a.browserPageId, element: submit!.ref }, 'browser_stale_ref')
    const old = await call(h.client, 'snapshot', { page: b.browserPageId }) as { refs: Array<{ ref: string }> }
    await call(h.client, 'tabSwitch', { page: a.browserPageId })
    await expectReason(h.client, 'click', { page: b.browserPageId, element: old.refs[0]!.ref }, 'browser_stale_ref')
  } finally { await h.cleanup() }
}, 60_000)

test('SC-04 and DF-06: interactions preserve large Unicode and use the real browser clipboard', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h)
    const big = '🧪漢字'.repeat(4_500)
    await call(h.client, 'fill', { page: page.browserPageId, element: '#text', value: big })
    expect((await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#text' }) as { value: string }).value).toBe(big)
    await call(h.client, 'type', { page: page.browserPageId, input: 'typed' })
    expect((await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#text' }) as { value: string }).value).toBe(`${big}typed`)
    await call(h.client, 'keyboardInsertText', { page: page.browserPageId, text: '✅' })
    expect((await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#text' }) as { value: string }).value).toBe(`${big}typed✅`)
    await call(h.client, 'selectAll', { page: page.browserPageId, element: '#text' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length' })).toEqual({ value: true })
    await call(h.client, 'clear', { page: page.browserPageId, element: '#text' })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#text' })).toEqual({ value: '' })
    await call(h.client, 'keypress', { page: page.browserPageId, key: 'Control+a' })
    await call(h.client, 'fill', { page: page.browserPageId, element: '#text', value: 'small' })
    await call(h.client, 'select', { page: page.browserPageId, element: '#choice', value: 'b' })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#choice' })).toEqual({ value: 'b' })
    expect(await call(h.client, 'check', { page: page.browserPageId, element: '#check' })).toEqual({ checked: true })
    expect(await call(h.client, 'is', { page: page.browserPageId, what: 'checked', element: '#check' })).toEqual({ value: true })
    expect(await call(h.client, 'uncheck', { page: page.browserPageId, element: '#check' })).toEqual({ checked: false })
    expect(await call(h.client, 'is', { page: page.browserPageId, what: 'checked', element: '#check' })).toEqual({ value: false })
    await call(h.client, 'focus', { page: page.browserPageId, element: '#other' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.activeElement.id' })).toEqual({ value: 'other' })
    await call(h.client, 'hover', { page: page.browserPageId, element: '#submit' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#submit").matches(":hover")' })).toEqual({ value: true })
    await call(h.client, 'eval', {
      page: page.browserPageId,
      expression: '(() => { const drag = document.querySelector("#drag"); const drop = document.querySelector("#drop"); drop.style.marginTop = "1600px"; document.body.style.height = "4000px"; window.__dragEvents = []; drag.addEventListener("dragstart", () => window.__dragEvents.push("start")); drop.addEventListener("dragover", event => event.preventDefault()); drop.addEventListener("drop", () => window.__dragEvents.push("drop")); return true })()'
    })
    await call(h.client, 'scrollIntoView', { page: page.browserPageId, element: '#drop' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.scrollY > 0' })).toEqual({ value: true })
    await call(h.client, 'drag', { page: page.browserPageId, from: '#drag', to: '#drop' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__dragEvents' })).toMatchObject({ value: ['start', 'drop'] })
    const uploadPath = join(h.home, 'upload.txt')
    writeFileSync(uploadPath, 'browser upload fixture')
    await call(h.client, 'upload', { page: page.browserPageId, element: '#files', files: [uploadPath] })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#files").files[0].name' })).toEqual({ value: 'upload.txt' })
    const scrollBefore = await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.scrollY' }) as { value: number }
    await call(h.client, 'scroll', { page: page.browserPageId, direction: 'down', amount: 400 })
    const scrollAfter = await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.scrollY' }) as { value: number }
    expect(scrollAfter.value).toBeGreaterThan(scrollBefore.value)
    await call(h.client, 'eval', {
      page: page.browserPageId,
      expression: '(() => { window.__mouseEvents = { moves: [], downs: [], ups: [], wheels: [] }; document.addEventListener("mousemove", event => window.__mouseEvents.moves.push({ x: event.clientX, y: event.clientY }), true); document.addEventListener("mousedown", event => window.__mouseEvents.downs.push({ button: event.button }), true); document.addEventListener("mouseup", event => window.__mouseEvents.ups.push({ button: event.button }), true); document.addEventListener("wheel", event => window.__mouseEvents.wheels.push({ deltaX: event.deltaX, deltaY: event.deltaY }), true); return true })()'
    })
    expect(await call(h.client, 'mouseMove', { page: page.browserPageId, x: 20, y: 30 })).toEqual({ moved: { x: 20, y: 30 } })
    expect(await call(h.client, 'mouseDown', { page: page.browserPageId })).toEqual({ button: 'left', down: true })
    expect(await call(h.client, 'mouseUp', { page: page.browserPageId })).toEqual({ button: 'left', down: false })
    expect(await call(h.client, 'mouseWheel', { page: page.browserPageId, dy: 30, dx: 2 })).toEqual({ scrolled: { dx: 2, dy: 30 } })
    const mouseEvents = await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__mouseEvents' }) as {
      value: { moves: Array<{ x: number; y: number }>; downs: Array<{ button: number }>; ups: Array<{ button: number }>; wheels: Array<{ deltaX: number; deltaY: number }> }
    }
    expect(mouseEvents.value.moves).toContainEqual({ x: 20, y: 30 })
    expect(mouseEvents.value.downs).toContainEqual({ button: 0 })
    expect(mouseEvents.value.ups).toContainEqual({ button: 0 })
    expect(mouseEvents.value.wheels).toContainEqual({ deltaX: 2, deltaY: 30 })
    await call(h.client, 'clipboardWrite', { page: page.browserPageId, text: 'real headless clipboard' })
    expect(await call(h.client, 'clipboardRead', { page: page.browserPageId })).toEqual({ text: 'real headless clipboard' })
    await expectReason(h.client, 'clipboardWrite', { page: page.browserPageId, text: 'é'.repeat(4_097) }, 'invalid_argument')
  } finally { await h.cleanup() }
}, 90_000)

test('SC-05: query, semantic find, wait and evaluation return real page results', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h)
    expect(await call(h.client, 'wait', { page: page.browserPageId, selector: '#delayed', timeout: 5_000, state: 'visible' })).toEqual({ waited: true })
    expect(await call(h.client, 'wait', { page: page.browserPageId, text: 'Submit', timeout: 5_000 })).toEqual({ waited: true })
    expect(await call(h.client, 'wait', { page: page.browserPageId, url: `${h.fixtureUrl}events`, timeout: 5_000 })).toEqual({ waited: true })
    expect(await call(h.client, 'wait', { page: page.browserPageId, load: 'domcontentloaded', timeout: 5_000 })).toEqual({ waited: true })
    expect(await call(h.client, 'wait', { page: page.browserPageId, fn: 'document.title === "Events"', timeout: 5_000 })).toEqual({ waited: true })
    expect(await call(h.client, 'wait', { page: page.browserPageId, selector: '#never', state: 'hidden', timeout: 5_000 })).toEqual({ waited: true })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'url' })).toEqual({ value: `${h.fixtureUrl}events` })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'title' })).toEqual({ value: 'Events' })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'html', element: '#submit' })).toMatchObject({ value: expect.stringContaining('Submit') })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'text', element: '#submit' })).toEqual({ value: 'Submit' })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#text' })).toEqual({ value: 'seed' })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'count', element: '#submit' })).toEqual({ value: 1 })
    const box = await call(h.client, 'get', { page: page.browserPageId, what: 'box', element: '#submit' }) as { value: { x: number; y: number; width: number; height: number } }
    const measuredBox = await call(h.client, 'eval', { page: page.browserPageId, expression: '(() => { const { x, y, width, height } = document.querySelector("#submit").getBoundingClientRect(); return { x, y, width, height } })()' }) as { value: typeof box.value }
    expect(box.value).toEqual(measuredBox.value)
    expect(await call(h.client, 'is', { page: page.browserPageId, what: 'visible', element: '#submit' })).toEqual({ value: true })
    expect(await call(h.client, 'is', { page: page.browserPageId, what: 'enabled', element: '#submit' })).toEqual({ value: true })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'role', value: 'button', action: 'text' })).toMatchObject({ action: 'text', text: 'Submit' })
    await call(h.client, 'eval', {
      page: page.browserPageId,
      expression: '(() => { const button = document.querySelector("#submit"); window.__doubleClickState = { clickDetails: [], doubleClicks: 0 }; button.addEventListener("click", event => window.__doubleClickState.clickDetails.push(event.detail)); button.addEventListener("dblclick", () => window.__doubleClickState.doubleClicks++); return true })()'
    })
    expect(await call(h.client, 'dblclick', { page: page.browserPageId, element: '#submit' })).toEqual({ clicked: '#submit' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__doubleClickState' })).toEqual({
      value: { clickDetails: [1, 2], doubleClicks: 1 }
    })
    await call(h.client, 'eval', {
      page: page.browserPageId,
      expression: '(() => { document.body.insertAdjacentHTML("beforeend", \'<label for="find-input">Find field</label><input id="find-input" placeholder="Find placeholder"><label for="find-check">Find check</label><input id="find-check" type="checkbox"><button data-testid="find-action">Find action</button><div title="Find title">Find hover</div>\'); document.querySelector("[data-testid=find-action]").addEventListener("click", () => { window.__findClicks = (window.__findClicks ?? 0) + 1 }); return true })()'
    })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'testid', value: 'find-action', action: 'click' }))
      .toEqual({ action: 'click', performed: true })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__findClicks' })).toEqual({ value: 1 })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'label', value: 'Find field', action: 'fill', text: 'found value' }))
      .toEqual({ action: 'fill', performed: true })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#find-input' })).toEqual({ value: 'found value' })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'placeholder', value: 'Find placeholder', action: 'type', text: ' typed' }))
      .toEqual({ action: 'type', performed: true })
    expect(await call(h.client, 'get', { page: page.browserPageId, what: 'value', element: '#find-input' })).toEqual({ value: 'found value typed' })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'title', value: 'Find title', action: 'hover' }))
      .toEqual({ action: 'hover', performed: true })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("[title=\\"Find title\\"]").matches(":hover")' })).toEqual({ value: true })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'label', value: 'Find field', action: 'focus' }))
      .toEqual({ action: 'focus', performed: true })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.activeElement.id' })).toEqual({ value: 'find-input' })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'label', value: 'Find check', action: 'check' }))
      .toEqual({ action: 'check', performed: true })
    expect(await call(h.client, 'is', { page: page.browserPageId, what: 'checked', element: '#find-check' })).toEqual({ value: true })
    expect(await call(h.client, 'find', { page: page.browserPageId, locator: 'label', value: 'Find check', action: 'uncheck' }))
      .toEqual({ action: 'uncheck', performed: true })
    expect(await call(h.client, 'is', { page: page.browserPageId, what: 'checked', element: '#find-check' })).toEqual({ value: false })
    await call(h.client, 'highlight', { page: page.browserPageId, selector: '#submit' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'Promise.resolve({ok:true, count: 2})' })).toEqual({ value: { ok: true, count: 2 } })
    await expectReason(h.client, 'eval', { page: page.browserPageId, expression: 'throw new Error("fixture")' }, 'browser_eval_error')
    await expectReason(h.client, 'wait', { page: page.browserPageId, selector: '#never', timeout: 50 }, 'browser_timeout')
    await expectReason(h.client, 'wait', { page: page.browserPageId }, 'invalid_argument')
  } finally { await h.cleanup() }
}, 60_000)

test('SC-06: screenshots, full-page captures, PDF and explicit downloads are real files', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h, `${h.fixtureUrl}tall`)
    const png = await call(h.client, 'screenshot', { page: page.browserPageId, format: 'png' }) as { data: string; format: string }
    const jpeg = await call(h.client, 'screenshot', { page: page.browserPageId, format: 'jpeg' }) as { data: string; format: string }
    const full = await call(h.client, 'fullScreenshot', { page: page.browserPageId }) as { data: string }
    const pdf = await call(h.client, 'pdf', { page: page.browserPageId }) as { data: string }
    expect(Buffer.from(png.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(Buffer.from(jpeg.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')
    expect(Buffer.from(full.data, 'base64').length).toBeGreaterThan(Buffer.from(png.data, 'base64').length)
    expect(Buffer.from(pdf.data, 'base64').subarray(0, 4).toString()).toBe('%PDF')
    expect(readdirSync(join(h.home, 'plugin-data', 'quirky.browser', 'captures'))).toEqual([])
    await call(h.client, 'goto', { page: page.browserPageId, url: `${h.fixtureUrl}download` })
    const downloadPath = join(h.home, 'downloads', 'fixture.bin')
    expect(await call(h.client, 'download', { page: page.browserPageId, selector: '#download', path: downloadPath })).toEqual({ path: downloadPath })
    expect(readFileSync(downloadPath, 'utf8')).toBe('fixture-download-bytes')
  } finally { await h.cleanup() }
}, 90_000)

test('SC-07, DF-01 and DF-02: bounded logs, all routes, emulation, HAR and exact dialog control', async () => {
  const dialogs = eventQueue<{ pageId: string; type: string }>()
  const h = await startBrowserHarness({ onDialog: (event) => dialogs.push(event) })
  try {
    const first = await newPage(h)
    const second = await newPage(h)
    await call(h.client, 'eval', { page: first.browserPageId, expression: 'await window.fixtureFetch()' })
    const limitedConsole = await call(h.client, 'console', { page: first.browserPageId, limit: 1 }) as { entries: unknown[]; truncated: boolean }
    expect(limitedConsole.entries).toHaveLength(1)
    expect(limitedConsole.truncated).toBe(true)
    const limitedNetwork = await call(h.client, 'network', { page: first.browserPageId, limit: 1 }) as { entries: unknown[]; truncated: boolean }
    expect(limitedNetwork.entries).toHaveLength(1)
    expect(limitedNetwork.truncated).toBe(true)
    await call(h.client, 'captureStart', { page: first.browserPageId })
    await call(h.client, 'eval', { page: first.browserPageId, expression: 'await window.fixtureFetch()' })
    const capture = await call(h.client, 'captureStop', { page: first.browserPageId }) as { stopped: true; har: { log: { version: string; entries: unknown[] } } }
    expect(capture.har.log.version).toBe('1.2')
    expect(capture.har.log.entries.length).toBeGreaterThan(0)
    const patterns = ['*/one', '*/two']
    expect(await call(h.client, 'interceptEnable', { page: first.browserPageId, patterns })).toEqual({ enabled: true, patterns })
    expect((await call(h.client, 'interceptList', { page: first.browserPageId }) as { patterns: string[] }).patterns).toEqual(patterns)
    await call(h.client, 'eval', { page: first.browserPageId, expression: 'await window.fixtureFetch()' })
    const intercepted = await call(h.client, 'interceptList', { page: first.browserPageId }) as { requests: Array<{ url: string }> }
    expect(intercepted.requests.some((request) => request.url.endsWith('/one'))).toBe(true)
    expect(intercepted.requests.some((request) => request.url.endsWith('/two'))).toBe(true)
    expect(await call(h.client, 'interceptDisable', { page: first.browserPageId })).toEqual({ disabled: true })
    expect((await call(h.client, 'interceptList', { page: first.browserPageId }) as { patterns: string[] }).patterns).toEqual([])
    expect(await call(h.client, 'interceptEnable', { page: second.browserPageId })).toEqual({ enabled: true, patterns: ['**/*'] })
    expect((await call(h.client, 'interceptList', { page: second.browserPageId }) as { patterns: string[] }).patterns).toEqual(['**/*'])
    expect(await call(h.client, 'interceptDisable', { page: second.browserPageId })).toEqual({ disabled: true })
    expect((await call(h.client, 'interceptList', { page: second.browserPageId }) as { patterns: string[] }).patterns).toEqual([])
    expect(await call(h.client, 'viewport', { page: first.browserPageId, width: 800, height: 600, deviceScaleFactor: 2, mobile: true })).toMatchObject({ width: 800, height: 600, deviceScaleFactor: 2, mobile: true })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: '({width:innerWidth,height:innerHeight,scale:devicePixelRatio})' })).toEqual({ value: { width: 800, height: 600, scale: 2 } })
    expect(await call(h.client, 'geolocation', { page: first.browserPageId, latitude: 47.6, longitude: -122.3, accuracy: 2 })).toMatchObject({ latitude: 47.6, longitude: -122.3, accuracy: 2 })
    const location = await call(h.client, 'eval', { page: first.browserPageId, expression: '(() => { const result = Promise.withResolvers(); navigator.geolocation.getCurrentPosition(({coords}) => result.resolve({latitude:coords.latitude,longitude:coords.longitude,accuracy:coords.accuracy}), error => result.reject(error.message)); return result.promise })()' }) as { value: { latitude: number; longitude: number; accuracy: number } }
    expect(location.value).toMatchObject({ latitude: 47.6, longitude: -122.3, accuracy: 2 })
    expect(await call(h.client, 'setDevice', { page: first.browserPageId, name: 'iPhone 14' })).toEqual({ name: 'iPhone 14' })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'innerWidth === 390 && navigator.userAgent.includes("iPhone")' })).toEqual({ value: true })
    expect(await call(h.client, 'setOffline', { page: first.browserPageId, state: 'on' })).toEqual({ offline: true })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'fetch("/one").then(()=>false,()=>true)' })).toEqual({ value: true })
    expect(await call(h.client, 'setOffline', { page: first.browserPageId, state: 'off' })).toEqual({ offline: false })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'fetch("/one").then(response=>response.text())' })).toEqual({ value: 'one' })
    expect(await call(h.client, 'setHeaders', { page: first.browserPageId, headers: '{"X-Fixture":"yes"}' })).toEqual({ headers: { 'X-Fixture': 'yes' } })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'fetch("/headers").then(response=>response.text())' })).toEqual({ value: 'yes' })
    expect(await call(h.client, 'setCredentials', { page: first.browserPageId, user: 'fixture-user', pass: 'secret' })).toEqual({ configured: true })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'fetch("/auth").then(response=>response.text())' })).toEqual({ value: 'authenticated' })
    expect(await call(h.client, 'setMedia', { page: first.browserPageId, colorScheme: 'dark', reducedMotion: 'reduce' })).toMatchObject({ colorScheme: 'dark', reducedMotion: 'reduce' })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'matchMedia("(prefers-color-scheme:dark)").matches && matchMedia("(prefers-reduced-motion:reduce)").matches' })).toEqual({ value: true })

    const promptPending = dialogs.next()
    const prompt = call(h.client, 'eval', { page: first.browserPageId, expression: 'prompt(\"name?\")' })
    expect(await promptPending).toMatchObject({ pageId: first.browserPageId, type: 'prompt' })
    await expectReason(h.client, 'dialogDismiss', { page: second.browserPageId }, 'browser_error')
    expect(await call(h.client, 'dialogAccept', { page: first.browserPageId, text: '雪🙂' })).toEqual({ accepted: true })
    expect(await prompt).toEqual({ value: '雪🙂' })
    const duplicatePending = dialogs.next()
    const duplicatePrompt = call(h.client, 'eval', { page: first.browserPageId, expression: 'prompt("duplicate?")' })
    expect(await duplicatePending).toMatchObject({ pageId: first.browserPageId, type: 'prompt' })
    const duplicateReplies = await Promise.allSettled([
      call(h.client, 'dialogAccept', { page: first.browserPageId, text: 'one' }),
      call(h.client, 'dialogAccept', { page: first.browserPageId, text: 'two' })
    ])
    const acceptedReplies = duplicateReplies.filter((reply) => reply.status === 'fulfilled')
    const refusedReply = duplicateReplies.find((reply) => reply.status === 'rejected')
    expect(acceptedReplies).toHaveLength(1)
    expect(acceptedReplies[0]).toMatchObject({ status: 'fulfilled', value: { accepted: true } })
    expect(refusedReply).toBeDefined()
    const refusedMessage = refusedReply?.status === 'rejected'
      ? refusedReply.reason instanceof Error ? refusedReply.reason.message : String(refusedReply.reason)
      : ''
    expect(refusedMessage.startsWith('browser_error:')).toBe(true)
    const duplicateResult = await duplicatePrompt as { value: string }
    expect(['one', 'two']).toContain(duplicateResult.value)

    const confirmPending = dialogs.next()
    const confirm = call(h.client, 'eval', { page: second.browserPageId, expression: 'confirm(\"continue?\")' })
    expect(await confirmPending).toMatchObject({ pageId: second.browserPageId, type: 'confirm' })
    expect(await call(h.client, 'dialogDismiss', { page: second.browserPageId })).toEqual({ dismissed: true })
    expect(await confirm).toEqual({ value: false })
  } finally { await h.cleanup() }
}, 90_000)

test('SC-08: cookie identities and origin-local/session storage remain scoped', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h)
    await call(h.client, 'cookieSet', { page: page.browserPageId, name: 'identity', value: 'one', path: '/private', secure: false, httpOnly: true, sameSite: 'Lax' })
    const cookies = await call(h.client, 'cookieGet', { page: page.browserPageId }) as { cookies: Array<Record<string, unknown>> }
    expect(cookies.cookies).toContainEqual(expect.objectContaining({ name: 'identity', value: 'one', path: '/private', httpOnly: true, sameSite: 'Lax', hostOnly: true }))
    expect(await call(h.client, 'cookieDelete', { page: page.browserPageId, name: 'identity', path: '/private', yes: true })).toEqual({ deleted: true })
    expect((await call(h.client, 'cookieGet', { page: page.browserPageId }) as { cookies: Array<{ name: string }> }).cookies.some((cookie) => cookie.name === 'identity')).toBe(false)
    await call(h.client, 'storageLocalSet', { page: page.browserPageId, key: 'key', value: '' })
    await call(h.client, 'storageSessionSet', { page: page.browserPageId, key: 'key', value: 'session' })
    expect(await call(h.client, 'storageLocalGet', { page: page.browserPageId, key: 'key' })).toEqual({ key: 'key', value: '' })
    expect(await call(h.client, 'storageSessionGet', { page: page.browserPageId, key: 'key' })).toEqual({ key: 'key', value: 'session' })
    expect(await call(h.client, 'storageLocalClear', { page: page.browserPageId, yes: true })).toEqual({ cleared: true })
    expect(await call(h.client, 'storageSessionClear', { page: page.browserPageId, yes: true })).toEqual({ cleared: true })
    expect(await call(h.client, 'storageLocalGet', { page: page.browserPageId, key: 'key' })).toEqual({ key: 'key', value: null })
    expect(await call(h.client, 'storageSessionGet', { page: page.browserPageId, key: 'key' })).toEqual({ key: 'key', value: null })
  } finally { await h.cleanup() }
}, 60_000)

test('SC-09: exec scopes URL navigation, preserves quotes and rejects retargeting', async () => {
  const h = await startBrowserHarness()
  try {
    const a = await newPage(h)
    const b = await newPage(h, `${h.fixtureUrl}first`)
    const emptyArgument = await call(h.client, 'exec', { page: a.browserPageId, command: 'fill "#text" ""' }) as { command: { path: string[]; positionals: string[] }; result: { filled: string } }
    expect(emptyArgument).toMatchObject({ command: { path: ['fill'], positionals: ['#text', ''] }, result: { filled: '#text' } })
    const opened = await call(h.client, 'exec', { page: a.browserPageId, command: `open ${h.fixtureUrl}second` }) as { result: { url: string; title: string } }
    expect(opened.result).toMatchObject({ url: `${h.fixtureUrl}second`, title: 'Second' })
    expect((await call(h.client, 'tabShow', { page: a.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}second`)
    expect((await call(h.client, 'tabShow', { page: b.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}first`)
    const navigated = await call(h.client, 'exec', { page: a.browserPageId, command: `navigate ${h.fixtureUrl}events` }) as { result: { url: string; title: string } }
    expect(navigated.result).toMatchObject({ url: `${h.fixtureUrl}events`, title: 'Events' })
    expect((await call(h.client, 'tabShow', { page: a.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}events`)
    expect((await call(h.client, 'tabShow', { page: b.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}first`)
    await expectReason(h.client, 'exec', { page: a.browserPageId, command: 'eval "unterminated' }, 'invalid_argument')
    for (const command of [
      'open',
      'goto https://example.test --target page-b',
      'goto https://example.test --target=page-b',
      'goto https://example.test --session session-b',
      'goto https://example.test --session=session-b',
      'goto https://example.test --cdp http://127.0.0.1:1',
      'goto https://example.test --cdp=http://127.0.0.1:1',
      'goto https://example.test --endpoint http://127.0.0.1:1',
      'goto https://example.test --endpoint=http://127.0.0.1:1',
      'goto https://example.test --profile default',
      'goto https://example.test --profile=default',
      'goto https://example.test --executable /Applications/Chrome',
      'goto https://example.test --executable=/Applications/Chrome',
      'goto https://example.test --executable-path /Applications/Chrome',
      'goto https://example.test --executable-path=/Applications/Chrome',
      'goto https://example.test --args no-sandbox',
      'goto https://example.test --args=no-sandbox',
      'tab',
      'browser',
      'session',
      'tab switch 0',
      'tab create',
      'tab close',
      'close',
      'connect http://127.0.0.1:9222',
      'session start',
      'browser launch',
      'stream',
      'batch',
      'chat',
      'install'
    ]) await expectReason(h.client, 'exec', { page: a.browserPageId, command }, 'invalid_argument')
    expect((await call(h.client, 'tabShow', { page: a.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}events`)
    expect((await call(h.client, 'tabShow', { page: b.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}first`)
  } finally { await h.cleanup() }
}, 60_000)

test('SC-10: closed work fails without retargeting and helper loss rebuilds a fresh page epoch', async () => {
  const operations = eventQueue<{ pageId: string; method: string }>()
  let control: { crashHelper(profileId: string): Promise<void> } | undefined
  const h = await startBrowserHarness({
    onControl: (value) => { control = value },
    onOperation: (event) => operations.push(event)
  })
  try {
    const page = await newPage(h)
    await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.privateBeforeRestart = \"old\"' })
    operations.clear()
    const operationStarted = operations.next((event) => event.pageId === page.browserPageId && event.method === 'eval')
    const blocked = call(h.client, 'eval', { page: page.browserPageId, expression: 'new Promise(resolve => setTimeout(() => resolve("late"), 20_000))' })
      .then((value) => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
    await operationStarted
    const queued = call(h.client, 'eval', { page: page.browserPageId, expression: '2 + 2' })
      .then((value) => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }))
    await call(h.client, 'tabClose', { page: page.browserPageId, yes: true })
    const [blockedResult, queuedResult] = await Promise.all([blocked, queued])
    expect(blockedResult.status).toBe('rejected')
    expect(queuedResult.status).toBe('rejected')
    const blockedMessage = blockedResult.status === 'rejected' ? String(blockedResult.reason) : ''
    const queuedMessage = queuedResult.status === 'rejected' ? String(queuedResult.reason) : ''
    expect(blockedMessage).toMatch(/browser_tab_closed/)
    expect(queuedMessage).toMatch(/browser_tab_closed/)
    await expectReason(h.client, 'tabShow', { page: page.browserPageId }, 'browser_tab_not_found')

    const recovered = await newPage(h)
    await call(h.client, 'eval', { page: recovered.browserPageId, expression: 'window.privateBeforeRestart = "old"' })
    await call(h.client, 'interceptEnable', { page: recovered.browserPageId, patterns: ['*/one', '*/two'] })
    const expires = Math.floor(Date.now() / 1000) + 86_400
    await call(h.client, 'cookieSet', { page: recovered.browserPageId, name: 'sc10-persistent', value: 'durable-profile', expires })
    expect(control).toBeDefined()
    const oldProjection = await call(h.client, 'snapshot', { page: recovered.browserPageId }) as { refs: Array<{ ref: string; name: string }> }
    const submitRef = oldProjection.refs.find((ref) => ref.name === 'Submit')?.ref
    expect(submitRef).toBeDefined()
    await control!.crashHelper('default')
    await expectReason(h.client, 'eval', { page: recovered.browserPageId, expression: '1 + 1' }, 'browser_tab_changed')
    await expectReason(h.client, 'click', { page: recovered.browserPageId, element: submitRef! }, 'browser_stale_ref')
    expect(await call(h.client, 'eval', { page: recovered.browserPageId, expression: 'window.privateBeforeRestart ?? null' })).toEqual({ value: null })
    expect((await call(h.client, 'interceptList', { page: recovered.browserPageId }) as { patterns: string[] }).patterns).toEqual(['*/one', '*/two'])
    const cookies = await call(h.client, 'cookieGet', { page: recovered.browserPageId }) as { cookies: Array<{ name: string; value: string; expires?: number }> }
    expect(cookies.cookies).toContainEqual(expect.objectContaining({ name: 'sc10-persistent', value: 'durable-profile', expires: expect.any(Number) }))
    expect(cookies.cookies.find((cookie) => cookie.name === 'sc10-persistent')!.expires!).toBeGreaterThan(Math.floor(Date.now() / 1000) + 80_000)
  } finally { await h.cleanup() }
}, 90_000)

test('SC-11 and DF-07: profile lifecycle isolates state, clones cookies, and preserves Default', async () => {
  const h = await startBrowserHarness()
  try {
    const source = await newPage(h)
    await call(h.client, 'cookieSet', { page: source.browserPageId, name: 'login', value: 'default-session' })
    const review = await call(h.client, 'profileCreate', { name: 'Review', scope: 'isolated' }) as { profile: { id: string } }
    const beforeSwitch = await call(h.client, 'snapshot', { page: source.browserPageId }) as { refs: Array<{ name: string; ref: string }> }
    const switchRef = beforeSwitch.refs.find((ref) => ref.name === 'Submit')!.ref
    const assigned = await call(h.client, 'profileSet', { page: source.browserPageId, profile: review.profile.id }) as { browserPageId: string; profileId: string }
    expect(assigned).toMatchObject({ browserPageId: source.browserPageId, profileId: review.profile.id })
    await expectReason(h.client, 'click', { page: source.browserPageId, element: switchRef }, 'browser_stale_ref')
    expect((await call(h.client, 'cookieGet', { page: source.browserPageId }) as { cookies: Array<{ name: string }> }).cookies.some((cookie) => cookie.name === 'login')).toBe(false)
    expect(await call(h.client, 'profileUseDefault', { page: source.browserPageId })).toMatchObject({ browserPageId: source.browserPageId, profileId: 'default', profileLabel: 'Default' })
    const cloneProfile = await call(h.client, 'profileCreate', { name: 'Clone' }) as { profile: { id: string } }
    const cloned = await call(h.client, 'profileClone', { profile: cloneProfile.profile.id, source: source.browserPageId }) as { browserPageId: string; sourceBrowserPageId: string; profileId: string }
    expect(cloned).toMatchObject({ sourceBrowserPageId: source.browserPageId, profileId: cloneProfile.profile.id })
    expect((await call(h.client, 'cookieGet', { page: cloned.browserPageId }) as { cookies: Array<{ name: string; value: string }> }).cookies).toContainEqual(expect.objectContaining({ name: 'login', value: 'default-session' }))
    expect((await call(h.client, 'profileShow', { page: cloned.browserPageId }) as { profileId: string }).profileId).toBe(cloneProfile.profile.id)
    let refused: unknown
    try { await call(h.client, 'profileDelete', { profile: cloneProfile.profile.id }) } catch (error) { refused = error }
    expect(refused).toBeDefined()
    expect((await call(h.client, 'profileList') as { profiles: Array<{ id: string }> }).profiles.map((profile) => profile.id)).toContain(cloneProfile.profile.id)
    await call(h.client, 'profileDelete', { profile: cloneProfile.profile.id, yes: true })
    expect((await call(h.client, 'profileShow', { page: cloned.browserPageId }) as { profileId: string }).profileId).toBe('default')
    expect((await call(h.client, 'profileList') as { profiles: Array<{ id: string }> }).profiles.map((profile) => profile.id)).toContain('default')
  } finally { await h.cleanup() }
}, 90_000)

test('SC-18: full method catalog is schema-declared and CLI dispatch uses the real daemon link', async () => {
  const h = await startBrowserHarness()
  try {
    expect(await call(h.client, 'identityGet')).toEqual({ mode: 'clean', effective: false })
    expect(await call(h.client, 'identitySet', { mode: 'native' })).toEqual({ mode: 'native', effective: false })
    expect(await call(h.client, 'identityGet')).toEqual({ mode: 'native', effective: false })
    expect(await call(h.client, 'identitySet', { mode: 'clean' })).toEqual({ mode: 'clean', effective: false })
    expect(await call(h.client, 'identityGet')).toEqual({ mode: 'clean', effective: false })
    const description = await h.client.callAny('api.describe', {}) as { methods: Array<{ name: string }>; cli: { commands: Array<{ words: string }> } }
    const names = new Set(description.methods.filter((item) => item.name.startsWith('quirky.browser/')).map((item) => item.name.slice('quirky.browser/'.length)))
    for (const name of [
      'tabList', 'tabShow', 'tabCurrent', 'tabCreate', 'tabSwitch', 'tabClose',
      'snapshot', 'screenshot', 'fullScreenshot', 'pdf', 'goto', 'back', 'forward', 'reload',
      'click', 'dblclick', 'fill', 'type', 'keyboardInsertText', 'keypress', 'select', 'check', 'uncheck', 'focus', 'hover',
      'scrollIntoView', 'clear', 'selectAll', 'drag', 'upload', 'scroll', 'wait', 'eval', 'get', 'is', 'find',
      'mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel', 'highlight', 'download', 'console', 'network',
      'captureStart', 'captureStop', 'interceptEnable', 'interceptDisable', 'interceptList',
      'cookieGet', 'cookieSet', 'cookieDelete', 'storageLocalGet', 'storageLocalSet', 'storageLocalClear',
      'storageSessionGet', 'storageSessionSet', 'storageSessionClear', 'viewport', 'geolocation', 'setDevice',
      'setOffline', 'setHeaders', 'setCredentials', 'setMedia', 'clipboardRead', 'clipboardWrite', 'dialogAccept',
      'dialogDismiss', 'profileList', 'profileCreate', 'profileDelete', 'profileShow', 'profileSet', 'profileUseDefault',
      'profileClone', 'detectBrowsers', 'importCookies', 'importStart', 'importGet', 'importList', 'identityGet',
      'identitySet', 'openUrl', 'exec'
    ]) expect(names.has(name)).toBe(true)
    const cliPaths = description.cli.commands.map((entry) => entry.words)
    expect(cliPaths).toContain('browser tab create')
    expect(cliPaths).toContain('browser import detect')

    const result = await runBrowserCli(h, ['browser', 'tab', 'profile', 'list', '--json'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ profiles: expect.arrayContaining([expect.objectContaining({ id: 'default' })]) })
    expect(h.spawnCount()).toBe(0)
  } finally { await h.cleanup() }
}, 60_000)

test('SC-05: nth locators keep index and selector separate across API CLI and exec', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h)
    await call(h.client, 'eval', {
      page: page.browserPageId,
      expression: '(() => { document.body.insertAdjacentHTML("beforeend", \'<button class="nth-item">Alpha</button><button class="nth-item">Beta</button><button class="nth-item">Gamma</button>\'); window.__nthClicks = 0; document.querySelectorAll(".nth-item").forEach(item => item.addEventListener("click", () => window.__nthClicks++)); return true })()'
    })

    expect(await call(h.client, 'find', {
      page: page.browserPageId, locator: 'nth', value: '.nth-item', index: 1, action: 'text'
    })).toEqual({ action: 'text', text: 'Beta' })

    const cli = await runBrowserCli(h, [
      'browser', 'find', '--page', page.browserPageId, '--locator', 'nth', '--value', '.nth-item',
      '--index', '-1', '--action', 'text', '--json'
    ])
    expect(cli.code).toBe(0)
    expect(JSON.parse(cli.stdout)).toEqual({ action: 'text', text: 'Gamma' })

    const executed = await call(h.client, 'exec', {
      page: page.browserPageId,
      command: 'find nth 0 .nth-item text'
    }) as { result: { action: string; text: string } }
    expect(executed.result).toEqual({ action: 'text', text: 'Alpha' })

    await expectReason(h.client, 'find', {
      page: page.browserPageId, locator: 'nth', value: '.nth-item', action: 'click'
    }, 'invalid_argument')
    await expectSchemaFailure(h.client, 'find', {
      page: page.browserPageId, locator: 'nth', value: '.nth-item', index: 1.5, action: 'click'
    })
    await expectReason(h.client, 'find', {
      page: page.browserPageId, locator: 'first', value: '.nth-item', index: 0, action: 'click'
    }, 'invalid_argument')
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__nthClicks' })).toEqual({ value: 0 })
  } finally { await h.cleanup() }
}, 60_000)
