import type { BrowserCheck, CheckContext } from './browser-run'
import type { CliReceipt } from './browser-world'

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
      await c.call<{ clicked: string }>('click', { element: '#readyButton' })
      const selectorWait = await c.call<{ waited: boolean }>('wait', { selector: '#ready', timeout: 10_000 })
      c.equal(selectorWait.waited, true)
      const readyText = await c.observe<string>('document.querySelector("#ready").textContent')
      c.equal(readyText, 'Ready', 'selector wait must complete after the controlled response reveals Ready')
      const footerWait = await c.call<{ waited: boolean }>('wait', { selector: '#footer', timeout: 10_000 })
      c.equal(footerWait.waited, true)
      const readyRequests = c.world.fixture.requests.filter(request => request.path === '/ready')
      c.assert(readyRequests.length > 0, 'the wait fixture must serve the local controlled response')
      const textWait = await c.call<{ waited: boolean }>('wait', { text: 'Ready', timeout: 10_000 })
      c.equal(textWait.waited, true)
      c.equal(await c.observe<boolean>('document.body.innerText.includes("Ready")'), true, 'text wait must match rendered page text')
      const functionWait = await c.call<{ waited: boolean }>('wait', { fn: 'document.querySelector("#footer") !== null', timeout: 10_000 })
      c.equal(functionWait.waited, true)
      c.equal(await c.observe<boolean>('document.querySelector("#footer") !== null'), true, 'JS-condition wait must be true on the page')
      const navigation = await c.call<NavigationResult>('goto', { url: fixtureUrl(c, '/second') })
      const urlWait = await c.call<{ waited: boolean }>('wait', { url: '**/second', timeout: 10_000 })
      c.equal(urlWait.waited, true)
      const currentUrl = await c.call<ValueResult<string>>('get', { what: 'url' })
      c.equal(currentUrl.value, navigation.url, 'URL wait must match the navigated local URL')
      const loadWait = await c.call<{ waited: boolean }>('wait', { load: 'load', timeout: 10_000 })
      c.equal(loadWait.waited, true)
      const readyState = await c.observe<string>('document.readyState')
      c.equal(readyState, 'complete', 'load wait must observe a completed document')
      const timeoutStarted = Date.now()
      const timeoutReceipt = await c.probe('wait', { selector: '#permanently-absent', timeout: 100 })
      const timeoutElapsedMs = Date.now() - timeoutStarted
      assertRefused(c, timeoutReceipt, /browser_timeout|timed? ?out|timeout/i, 'absent-selector wait timeout')
      return { selector: readyText, footerWait: footerWait.waited, localReadyRequests: readyRequests.length, textWait: textWait.waited, functionWait: functionWait.waited, url: currentUrl.value, loadState: readyState, timeoutElapsedMs, timeoutExitCode: timeoutReceipt.exitCode }
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
      await c.call<{ clicked: string }>('click', { element: '#readyButton' })
      const revealed = await c.call<{ waited: boolean }>('wait', { selector: '#footer', timeout: 10_000 })
      c.equal(revealed.waited, true, 'the local response must reveal the footer before scrolling')
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
