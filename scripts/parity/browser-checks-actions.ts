import type { BrowserCheck, CheckContext } from './browser-run'
import { BrowserFailure, type CliReceipt } from './browser-world'

type NavigationResult = { url: string; title: string }
type SnapshotRef = { ref: string; role: string; name: string }
type SnapshotResult = {
  browserPageId: string
  projectionId: string
  url: string
  title: string
  snapshot: string
  refs: SnapshotRef[]
}
type ValueResult<T> = { value: T }
type PageTextState = { value: string | null; result: string | null }
type RecordedEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'down' | 'up'; button: number }
  | { type: 'wheel'; deltaY: number }
type ExecResult = {
  command: { path: string[]; positionals: string[]; flags: Record<string, string | boolean> }
  result: Record<string, unknown>
}

function fixtureUrl(c: CheckContext, pathname: string): string {
  return new URL(pathname, c.world.fixture.origin).toString()
}

async function resetPage(c: CheckContext): Promise<NavigationResult> {
  await c.call<NavigationResult>('goto', { url: 'about:blank' })
  const page = await c.call<NavigationResult>('goto', { url: fixtureUrl(c, '/page') })
  c.equal(page.url, fixtureUrl(c, '/page'), 'A must be reset to the local fixture page')
  c.equal(page.title, 'Parity fixture', 'A must be reset to the fixture title')
  return page
}

function snapshotRef(snapshot: SnapshotResult, role: string, name: string): SnapshotRef {
  const ref = snapshot.refs.find(candidate => candidate.role === role && candidate.name === name)
  if (!ref) throw new Error(`snapshot did not expose ${role} named ${name}`)
  return ref
}

function refusalText(receipt: CliReceipt): string {
  return `${receipt.stderrTail}\n${JSON.stringify(receipt.result) ?? String(receipt.result)}`
}

function assertRefused(c: CheckContext, receipt: CliReceipt, pattern: RegExp, message: string): void {
  c.assert(receipt.exitCode !== 0, `${message} unexpectedly succeeded`)
  c.assert(pattern.test(refusalText(receipt)), `${message} failed without its expected refusal evidence`)
}

async function observeInput(c: CheckContext, page?: string): Promise<string> {
  return await c.observe<string>('document.querySelector("#text").value', page)
}
type WaitCondition = { selector: string } | { text: string } | { fn: string } | { url: string } | { load: 'load' }
type SettledWait =
  | { ok: true; receipt: CliReceipt }
  | { ok: false; error: unknown }
const NAVIGATION_WAIT_GAP = 'a wait fulfilled by a navigation is rejected with browser_tab_changed. Follow-up: Let a pending browser wait finish when the navigation it waits for lands'

function requireWaitSuccess(receipt: CliReceipt): void {
  if (receipt.exitCode !== 0) throw new BrowserFailure('cli-nonzero', `wait: ${JSON.stringify(receipt.result)}`, receipt.stderrTail)
  const result = receipt.result
  if (!result || typeof result !== 'object' || !('waited' in result) || result.waited !== true) throw new BrowserFailure('malformed-cli-json', 'wait returned no successful condition result')
}

function navigationWaitOutcome(receipt: CliReceipt): Record<string, unknown> {
  if (receipt.exitCode === 0) {
    requireWaitSuccess(receipt)
    return { waitResult: receipt.result }
  }
  const result = receipt.result
  if (receipt.exitCode === 1 && result && typeof result === 'object' && 'error' in result) {
    const error = result.error
    if (error && typeof error === 'object' && 'code' in error && error.code === 'conflict' &&
      'message' in error && error.message === 'browser_tab_changed: browser page identity changed during the operation') {
      return { gap: NAVIGATION_WAIT_GAP, waitResult: result }
    }
  }
  throw new BrowserFailure('cli-nonzero', `unexpected navigation wait failure: ${JSON.stringify(result)}`, receipt.stderrTail)
}

async function assertPageBUnchanged(c: CheckContext, message: string): Promise<void> {
  c.equal(await c.observe<string>('location.href', c.state.pageB), fixtureUrl(c, '/page'), `${message}: B URL`)
  c.equal(await c.observe<string>('document.title', c.state.pageB), 'Parity fixture', `${message}: B title`)
}

async function waitBehindGate(c: CheckContext, key: string, condition: WaitCondition, label: string): Promise<CliReceipt> {
  await c.world.fixture.waitForGate(key)
  let settled = false
  const pending = c.probe('wait', { ...condition, timeout: 10_000 }, c.state.pageA).then(
    receipt => {
      settled = true
      return { ok: true, receipt } as const
    },
    error => {
      settled = true
      return { ok: false, error } as const
    }
  )

  let barrierFailed = false
  let barrierError: unknown
  try {
    await assertPageBUnchanged(c, `${label} controller barrier`)
    c.assert(!settled, `${label} wait completed while its fixture gate was held`)
  } catch (error) {
    barrierFailed = true
    barrierError = error
  } finally {
    c.world.fixture.releaseGate(key)
  }

  const outcome: SettledWait = await pending
  if (barrierFailed) throw barrierError
  if (!outcome.ok) throw outcome.error
  await assertPageBUnchanged(c, `${label} result`)
  return outcome.receipt
}

async function startGatedEffect(c: CheckContext, key: string, effect: string): Promise<void> {
  const gateUrl = new URL('/wait-gate', c.world.fixture.origin)
  gateUrl.searchParams.set('key', key)
  const expression = `(()=>{void fetch(${JSON.stringify(gateUrl.href)}).then(response=>{if(!response.ok)throw new Error('wait gate response failed');${effect}}).catch(error=>{window.__parityWaitEffectError=String(error)});return true})()`
  const started = await c.call<ValueResult<boolean>>('eval', { expression }, c.state.pageA)
  c.equal(started.value, true, `${key} fixture effect must be scheduled through the CLI`)
}


export const actionChecks: BrowserCheck[] = [
  {
    id: 'snapshot',
    async run(c) {
      const page = await resetPage(c)
      const snapshot = await c.call<SnapshotResult>('snapshot')
      c.equal(snapshot.browserPageId, c.state.pageA, 'snapshot must identify A')
      c.equal(snapshot.url, page.url, 'snapshot must describe the reset URL')
      c.equal(snapshot.title, 'Parity fixture')
      const text = snapshotRef(snapshot, 'textbox', 'Text field')
      const apply = snapshotRef(snapshot, 'button', 'Apply')
      const filled = await c.call<{ filled: string }>('fill', { element: text.ref, value: 'hello λ' })
      c.equal(filled.filled, text.ref, 'fill must use the returned named textbox reference')
      c.equal(await observeInput(c), 'hello λ', 'the named reference must fill A')
      const beforeB = await c.observe<PageTextState>(
        '({value:document.querySelector("#text").value,result:document.querySelector("#result").textContent})',
        c.state.pageB
      )
      c.equal(beforeB, { value: 'seed', result: '' }, 'B must retain its independent fixture state')
      const wrongPage = await c.probe('click', { element: text.ref }, c.state.pageB)
      assertRefused(c, wrongPage, /browser_stale_ref|snapshot reference is stale or belongs to another page/i, 'cross-page snapshot reference')
      const afterWrongPage = await c.observe<PageTextState>(
        '({value:document.querySelector("#text").value,result:document.querySelector("#result").textContent})',
        c.state.pageB
      )
      c.equal(afterWrongPage, beforeB, 'a wrong-page reference must not mutate B')
      const applied = await c.call<{ clicked: string }>('click', { element: apply.ref })
      c.equal(applied.clicked, apply.ref, 'click must use the returned named button reference')
      c.equal(await c.observe<string>('document.querySelector("#result").textContent'), 'applied:hello λ')
      const afterClickB = await c.observe<PageTextState>(
        '({value:document.querySelector("#text").value,result:document.querySelector("#result").textContent})',
        c.state.pageB
      )
      c.equal(afterClickB, beforeB, 'clicking A must leave B unchanged')
      await c.call<NavigationResult>('goto', { url: fixtureUrl(c, '/second') })
      const staleRef = await c.probe('click', { element: apply.ref })
      assertRefused(c, staleRef, /browser_stale_ref|snapshot reference is stale or belongs to another page/i, 'stale snapshot reference after navigation')
      const afterStale = await c.observe<PageTextState>(
        '({value:document.querySelector("#text").value,result:document.querySelector("#result").textContent})',
        c.state.pageB
      )
      c.equal(afterStale, beforeB, 'a stale reference must not mutate B')
      return { pageId: snapshot.browserPageId, projectionId: snapshot.projectionId, namedRefs: { text, apply }, filled: 'hello λ', applied: 'applied:hello λ', wrongPageExitCode: wrongPage.exitCode, staleRefExitCode: staleRef.exitCode, pageB: afterStale }
    }
  },
  {
    id: 'eval',
    async run(c) {
      await resetPage(c)
      const evaluated = await c.call<ValueResult<{ answer: number }>>('eval', { expression: '({answer:6*7})' })
      c.equal(evaluated.value, { answer: 42 }, 'eval must return the serializable page value')
      const title = await c.call<ValueResult<string>>('get', { what: 'title' })
      c.equal(title.value, 'Parity fixture', 'eval must remain scoped to A')
      return { value: evaluated.value, pageTitle: title.value }
    }
  },
  {
    id: 'get',
    async run(c) {
      await resetPage(c)
      await c.call<{ filled: string }>('fill', { element: '#text', value: 'found' })
      await c.call<{ clicked: string }>('click', { element: '#apply' })
      const result = await c.call<ValueResult<string>>('get', { what: 'text', element: '#result' })
      c.equal(result.value, 'applied:found')
      const direct = await c.observe<string>('document.querySelector("#result").textContent')
      c.equal(direct, result.value, 'get text must match the page DOM')
      return { value: result.value, domText: direct }
    }
  },
  {
    id: 'is',
    async run(c) {
      await resetPage(c)
      const visible = await c.call<ValueResult<boolean>>('is', { what: 'visible', element: '#apply' })
      c.equal(visible.value, true)
      const rendered = await c.observe<boolean>('(() => { const e=document.querySelector("#apply"); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; })()')
      c.equal(rendered, visible.value, 'is visible must reflect rendered DOM state')
      return { visible: visible.value, rendered }
    }
  },
  {
    id: 'wait',
    async run(c) {
      await resetPage(c)
      c.equal(await c.observe<boolean>('document.querySelector("#permanently-absent") !== null'), false, 'timeout condition must be absent')
      const started = Date.now()
      const receipt = await c.probe('wait', { selector: '#permanently-absent', timeout: 100 })
      assertRefused(c, receipt, /browser_timeout|timed? ?out|timeout/i, 'absent-selector wait timeout')
      return { absent: true, timeoutElapsedMs: Date.now() - started, timeoutExitCode: receipt.exitCode }
    }
  },
  {
    id: 'wait-selector',
    async run(c) {
      await resetPage(c)
      c.equal(await c.observe<boolean>('document.querySelector("#selector-proof") !== null'), false, 'selector condition must start absent')
      c.equal(await c.observe<boolean>('document.querySelector("#footer") !== null'), false, 'footer condition must start absent')
      await c.call('click', { element: '#readyButton' })
      requireWaitSuccess(await waitBehindGate(c, 'selector', { selector: '#selector-proof' }, 'selector'))
      const selectorProof = await c.observe<string | null>('document.querySelector("#selector-proof")?.textContent ?? null')
      c.equal(selectorProof, 'Selector gate proof')
      c.equal(await c.observe<string>('document.querySelector("#ready").textContent'), 'Ready')
      c.equal(await c.observe<boolean>('document.querySelector("#footer") !== null'), false, 'footer must remain absent before its gate')
      requireWaitSuccess(await waitBehindGate(c, 'footer', { selector: '#footer' }, 'footer selector'))
      c.equal(await c.observe<boolean>('document.querySelector("#footer") !== null'), true)
      return { pendingBeforeRelease: true, selectorProof, footerPresentAfterRelease: true }
    }
  },
  {
    id: 'wait-text',
    async run(c) {
      await resetPage(c)
      c.equal(await c.observe<boolean>('document.body.innerText.includes("Gate text proof")'), false, 'text condition must start absent')
      await startGatedEffect(c, 'text', `const proof=document.createElement('output');proof.id='wait-text';proof.textContent='Gate text proof';document.querySelector('main').append(proof);`)
      requireWaitSuccess(await waitBehindGate(c, 'text', { text: 'Gate text proof' }, 'text'))
      const text = await c.observe<string | null>('document.querySelector("#wait-text")?.textContent ?? null')
      c.equal(text, 'Gate text proof')
      return { pendingBeforeRelease: true, text }
    }
  },
  {
    id: 'wait-js',
    async run(c) {
      await resetPage(c)
      c.equal(await c.observe<boolean>('window.__parityWaitFnReady === true'), false, 'JS condition must start false')
      await startGatedEffect(c, 'fn', 'window.__parityWaitFnReady=true;')
      requireWaitSuccess(await waitBehindGate(c, 'fn', { fn: 'window.__parityWaitFnReady === true' }, 'JS condition'))
      const ready = await c.observe<boolean>('window.__parityWaitFnReady === true')
      c.equal(ready, true)
      return { pendingBeforeRelease: true, ready }
    }
  },
  {
    id: 'wait-url',
    async run(c) {
      await resetPage(c)
      const target = fixtureUrl(c, '/second')
      const before = await c.call<ValueResult<string>>('get', { what: 'url' })
      c.assert(before.value !== target, 'URL condition must start false')
      await startGatedEffect(c, 'url', `location.assign(${JSON.stringify(target)});`)
      const receipt = await waitBehindGate(c, 'url', { url: target }, 'URL')
      const observed = await c.call<ValueResult<string>>('get', { what: 'url' })
      c.equal(observed.value, target, 'navigation must satisfy the requested URL after release')
      return { ...navigationWaitOutcome(receipt), pendingBeforeRelease: true, before: before.value, url: observed.value }
    }
  },
  {
    id: 'wait-load',
    async run(c) {
      await resetPage(c)
      const target = new URL('/wait-load?key=load', c.world.fixture.origin).href
      await startGatedEffect(c, 'load-navigation', `location.assign(${JSON.stringify(target)});`)
      await c.world.fixture.waitForGate('load-navigation')
      c.world.fixture.releaseGate('load-navigation')
      await c.world.fixture.waitForGate('load')
      const requestIndex = c.world.fixture.requests.findIndex(request => request.path === '/wait-load')
      const gateIndex = c.world.fixture.requests.map(request => request.path).lastIndexOf('/wait-gate')
      c.assert(requestIndex >= 0 && gateIndex > requestIndex, 'committed page must be blocked on its parser script')
      c.equal(await c.observe<string>('document.readyState'), 'loading', 'load condition must start false')
      const receipt = await waitBehindGate(c, 'load', { load: 'load' }, 'load')
      const readyState = await c.observe<string>('document.readyState')
      c.equal(readyState, 'complete')
      c.equal(await c.observe<boolean>('window.__parityWaitGateReleased === true'), true)
      c.equal((await c.call<ValueResult<string>>('get', { what: 'url' })).value, target)
      return { ...navigationWaitOutcome(receipt), pendingBeforeRelease: true, readyState, url: target }
    }
  },
  {
    id: 'click',
    async run(c) {
      await resetPage(c)
      await c.call<{ filled: string }>('fill', { element: '#text', value: 'clicked' })
      const snapshot = await c.call<SnapshotResult>('snapshot')
      const apply = snapshotRef(snapshot, 'button', 'Apply')
      const clicked = await c.call<{ clicked: string }>('click', { element: apply.ref })
      c.equal(clicked.clicked, apply.ref)
      const result = await c.observe<string>('document.querySelector("#result").textContent')
      c.equal(result, 'applied:clicked', 'click must trigger the fixture button effect')
      return { buttonRef: apply, result }
    }
  },
  {
    id: 'dblclick',
    async run(c) {
      await resetPage(c)
      const clicked = await c.call<{ clicked: string }>('dblclick', { element: '#double' })
      c.equal(clicked.clicked, '#double')
      const count = await c.observe<string>('document.querySelector("#doubleResult").textContent')
      c.equal(count, '1', 'double-click must increment the fixture counter once')
      return { result: count }
    }
  },
  {
    id: 'fill',
    async run(c) {
      await resetPage(c)
      const filled = await c.call<{ filled: string }>('fill', { element: '#text', value: 'filled' })
      c.equal(filled.filled, '#text')
      const value = await observeInput(c)
      c.equal(value, 'filled', 'fill must replace the input value')
      return { value }
    }
  },
  {
    id: 'type',
    async run(c) {
      await resetPage(c)
      await c.call<{ filled: string }>('fill', { element: '#text', value: 'filled' })
      await c.call<{ focused: string }>('focus', { element: '#text' })
      const typed = await c.call<{ typed: boolean }>('type', { input: '-typed' })
      c.equal(typed.typed, true)
      const value = await observeInput(c)
      c.equal(value, 'filled-typed', 'type must append to the focused value')
      return { value }
    }
  },
  {
    id: 'select',
    async run(c) {
      await resetPage(c)
      const selected = await c.call<{ selected: string }>('select', { element: '#choice', value: 'b' })
      c.equal(selected.selected, 'b')
      const value = await c.observe<string>('document.querySelector("#choice").value')
      c.equal(value, 'b', 'select must change the native select value')
      return { value }
    }
  },
  {
    id: 'hover',
    async run(c) {
      await resetPage(c)
      const hovered = await c.call<{ hovered: string }>('hover', { element: '#hover' })
      c.equal(hovered.hovered, '#hover')
      const result = await c.observe<string>('document.querySelector("#hoverResult").textContent')
      c.equal(result, 'hovered', 'hover must trigger the fixture hover effect')
      return { result }
    }
  },
  {
    id: 'keypress',
    async run(c) {
      await resetPage(c)
      await c.call<{ cleared: string }>('clear', { element: '#text' })
      await c.call<{ focused: string }>('focus', { element: '#text' })
      await c.call<{ inserted: boolean }>('inserttext', { text: '@file:not-a-file λ' })
      await c.call<{ selected: string }>('select-all', { element: '#text' })
      const pressed = await c.call<{ pressed: string }>('keypress', { key: 'Backspace' })
      c.equal(pressed.pressed, 'Backspace')
      const value = await observeInput(c)
      c.equal(value, '', 'Backspace after selecting all text must clear the focused input')
      return { value }
    }
  },
  {
    id: 'scroll',
    async run(c) {
      await resetPage(c)
      const down = await c.call<{ scrolled: string }>('scroll', { direction: 'down', amount: 120 })
      c.equal(down.scrolled, 'down')
      const afterDown = await c.observe<number>('window.scrollY')
      c.equal(afterDown, 120, 'scroll down must move the fixture viewport by 120px')
      const up = await c.call<{ scrolled: string }>('scroll', { direction: 'up', amount: 120 })
      c.equal(up.scrolled, 'up')
      const afterUp = await c.observe<number>('window.scrollY')
      c.equal(afterUp, 0, 'scroll up must return the fixture viewport to the origin')
      return { afterDown, afterUp }
    }
  },
  {
    id: 'check',
    async run(c) {
      await resetPage(c)
      const checked = await c.call<{ checked: boolean }>('check', { element: '#check' })
      c.equal(checked.checked, true)
      const state = await c.call<ValueResult<boolean>>('is', { what: 'checked', element: '#check' })
      c.equal(state.value, true, 'check must change the checkbox state')
      const domState = await c.observe<boolean>('document.querySelector("#check").checked')
      c.equal(domState, true)
      return { checked: state.value, domChecked: domState }
    }
  },
  {
    id: 'uncheck',
    async run(c) {
      await resetPage(c)
      await c.call<{ checked: boolean }>('check', { element: '#check' })
      const unchecked = await c.call<{ checked: boolean }>('uncheck', { element: '#check' })
      c.equal(unchecked.checked, false)
      const state = await c.call<ValueResult<boolean>>('is', { what: 'checked', element: '#check' })
      c.equal(state.value, false, 'uncheck must clear the checkbox state')
      return { checked: state.value }
    }
  },
  {
    id: 'focus',
    async run(c) {
      await resetPage(c)
      const focused = await c.call<{ focused: string }>('focus', { element: '#text' })
      c.equal(focused.focused, '#text')
      const active = await c.observe<string>('document.activeElement.id')
      c.equal(active, 'text', 'focus must move the page active element')
      return { activeElement: active }
    }
  },
  {
    id: 'clear',
    async run(c) {
      await resetPage(c)
      await c.call<{ filled: string }>('fill', { element: '#text', value: 'to-clear' })
      const cleared = await c.call<{ cleared: string }>('clear', { element: '#text' })
      c.equal(cleared.cleared, '#text')
      const value = await observeInput(c)
      c.equal(value, '', 'clear must empty the input')
      return { value }
    }
  },
  {
    id: 'drag',
    async run(c) {
      await resetPage(c)
      const dragged = await c.call<{ dragged: { from: string; to: string } }>('drag', { from: '#dragSource', to: '#dragTarget' })
      c.equal(dragged.dragged, { from: '#dragSource', to: '#dragTarget' })
      const result = await c.observe<string>('document.querySelector("#dragResult").textContent')
      c.equal(result, 'dragged', 'drag must deposit the fixture payload at the drop target')
      return { result }
    }
  },
  {
    id: 'scrollintoview',
    async run(c) {
      await resetPage(c)
      c.equal(await c.observe<boolean>('document.querySelector("#footer") !== null'), false, 'scroll footer must start absent')
      await startGatedEffect(c, 'scroll-footer', `const footer=document.createElement('footer');footer.id='footer';footer.textContent='Fixture footer';document.body.append(footer);`)
      requireWaitSuccess(await waitBehindGate(c, 'scroll-footer', { selector: '#footer' }, 'scroll footer'))
      const scrolled = await c.call<{ scrolledIntoView: string }>('scrollintoview', { element: '#footer' })
      c.equal(scrolled.scrolledIntoView, '#footer')
      const rect = await c.observe<{ top: number; bottom: number; viewportHeight: number; scrollY: number }>(
        '(() => { const r=document.querySelector("#footer").getBoundingClientRect(); return {top:r.top,bottom:r.bottom,viewportHeight:window.innerHeight,scrollY:window.scrollY}; })()'
      )
      c.assert(rect.top >= 0 && rect.bottom <= rect.viewportHeight && rect.scrollY > 0, 'scrollintoview must bring the footer fully into the viewport')
      return { rect }
    }
  },
  {
    id: 'inserttext',
    async run(c) {
      await resetPage(c)
      await c.call<{ cleared: string }>('clear', { element: '#text' })
      await c.call<{ focused: string }>('focus', { element: '#text' })
      const inserted = await c.call<{ inserted: boolean }>('inserttext', { text: '@file:not-a-file λ' })
      c.equal(inserted.inserted, true)
      const value = await observeInput(c)
      c.equal(value, '@file:not-a-file λ', 'inserttext must insert the literal file-like text')
      return { value }
    }
  },
  {
    id: 'select-all',
    async run(c) {
      await resetPage(c)
      await c.call<{ cleared: string }>('clear', { element: '#text' })
      await c.call<{ focused: string }>('focus', { element: '#text' })
      await c.call<{ inserted: boolean }>('inserttext', { text: '@file:not-a-file λ' })
      const selected = await c.call<{ selected: string }>('select-all', { element: '#text' })
      c.equal(selected.selected, '#text')
      const selection = await c.observe<{ id: string; value: string; selected: string }>(
        '(() => { const e=document.activeElement; return {id:e.id,value:e.value,selected:e.value.slice(e.selectionStart,e.selectionEnd)}; })()'
      )
      c.equal(selection, { id: 'text', value: '@file:not-a-file λ', selected: '@file:not-a-file λ' }, 'select-all must select the complete literal value')
      return { selection }
    }
  },
  {
    id: 'find',
    async run(c) {
      await resetPage(c)
      const labelFind = await c.call<{ action: string; performed: boolean }>('find', { locator: 'label', value: 'Text field', action: 'fill', text: 'found' })
      c.equal(labelFind, { action: 'fill', performed: true })
      const labelValue = await observeInput(c)
      c.equal(labelValue, 'found', 'label find must fill its associated input')
      const textFind = await c.call<{ action: string; performed: boolean }>('find', { locator: 'text', value: 'Apply', action: 'click' })
      c.equal(textFind, { action: 'click', performed: true })
      const result = await c.observe<string>('document.querySelector("#result").textContent')
      c.equal(result, 'applied:found', 'text find must click Apply after the semantic fill')
      return { labelValue, result }
    }
  },
  {
    id: 'mouse-move',
    async run(c) {
      await resetPage(c)
      const moved = await c.call<{ moved: { x: number; y: number } }>('mouse move', { x: 20, y: 20 })
      c.equal(moved.moved, { x: 20, y: 20 })
      const events = await c.observe<RecordedEvent[]>('window.parityEvents')
      c.equal(events, [{ type: 'move', x: 20, y: 20 }], 'the DOM must record the mouse coordinates')
      return { events }
    }
  },
  {
    id: 'mouse-down',
    async run(c) {
      await resetPage(c)
      await c.call<{ moved: { x: number; y: number } }>('mouse move', { x: 20, y: 20 })
      const down = await c.call<{ button: string; down: boolean }>('mouse down', { button: 'left' })
      c.equal(down, { button: 'left', down: true })
      const events = await c.observe<RecordedEvent[]>('window.parityEvents')
      c.equal(events[events.length - 1], { type: 'down', button: 0 }, 'the DOM must record left-button down as button 0')
      await c.call<{ button: string; down: boolean }>('mouse up', { button: 'left' })
      return { events }
    }
  },
  {
    id: 'mouse-up',
    async run(c) {
      await resetPage(c)
      await c.call<{ moved: { x: number; y: number } }>('mouse move', { x: 20, y: 20 })
      await c.call<{ button: string; down: boolean }>('mouse down', { button: 'left' })
      const up = await c.call<{ button: string; down: boolean }>('mouse up', { button: 'left' })
      c.equal(up, { button: 'left', down: false })
      const events = await c.observe<RecordedEvent[]>('window.parityEvents')
      c.equal(events[events.length - 1], { type: 'up', button: 0 }, 'the DOM must record left-button up as button 0')
      return { events }
    }
  },
  {
    id: 'mouse-wheel',
    async run(c) {
      await resetPage(c)
      const wheel = await c.call<{ scrolled: { dx: number; dy: number } }>('mouse wheel', { dy: 40 })
      c.equal(wheel.scrolled, { dx: 0, dy: 40 })
      const eventWait = await c.call<{ waited: boolean }>('wait', { fn: 'window.parityEvents.some(e => e.type === "wheel")', timeout: 2_000 })
      c.equal(eventWait.waited, true, 'the wheel event must be delivered before inspecting the DOM log')
      const events = await c.observe<RecordedEvent[]>('window.parityEvents')
      c.equal(events, [{ type: 'wheel', deltaY: 40 }], 'the DOM must record the wheel delta')
      return { events }
    }
  },
  {
    id: 'highlight',
    async run(c) {
      await resetPage(c)
      const highlighted = await c.call<{ highlighted: string }>('highlight', { selector: '#apply' })
      c.equal(highlighted.highlighted, '#apply')
      const rendered = await c.observe<{ outlineWidth: string; outlineStyle: string; outlineColor: string; outlineOffset: string; rect: { x: number; y: number; width: number; height: number } }>(
        '(() => { const e=document.querySelector("#apply"); const s=getComputedStyle(e); const r=e.getBoundingClientRect(); return {outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,outlineColor:s.outlineColor,outlineOffset:s.outlineOffset,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}; })()'
      )
      c.equal(rendered.outlineWidth, '2px', 'helper highlight must render its 2px outline on the target')
      c.equal(rendered.outlineStyle, 'solid')
      c.equal(rendered.outlineColor, 'rgb(255, 0, 0)')
      c.equal(rendered.outlineOffset, '2px')
      c.assert(rendered.rect.width > 0 && rendered.rect.height > 0, 'highlighted target must have a rendered page rectangle')
      return { rendered }
    }
  },
  {
    id: 'exec',
    async run(c) {
      await resetPage(c)
      const allowed = await c.call<ExecResult>('exec', { command: 'fill #text exec-value' })
      c.equal(allowed.result, { filled: '#text' }, 'typed exec fill must return the closed command result')
      const value = await observeInput(c)
      c.equal(value, 'exec-value', 'typed exec fill must mutate the owned page')
      const refusals: Array<{ command: string; expected: RegExp }> = [
        { command: 'launch', expected: /exec cannot invoke browser or process lifecycle commands/i },
        { command: 'connect 9222', expected: /exec cannot invoke browser or process lifecycle commands/i },
        { command: 'fill #text forbidden --cdp-url ws://127.0.0.1:9222/devtools/browser/foreign', expected: /--cdp-url/i },
        { command: 'fill #text forbidden --session foreign', expected: /--session/i }
      ]
      const refusalEvidence: Array<{ command: string; exitCode: number }> = []
      for (const refusal of refusals) {
        const receipt = await c.probe('exec', { command: refusal.command })
        assertRefused(c, receipt, refusal.expected, `exec ${refusal.command}`)
        c.equal(await observeInput(c), 'exec-value', `refused exec command must preserve A (${refusal.command})`)
        refusalEvidence.push({ command: refusal.command, exitCode: receipt.exitCode })
      }
      return { command: allowed.command, value, refusals: refusalEvidence }
    }
  }
]
