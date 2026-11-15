import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { act } from 'react'
import { UI_CONTROL_COMMAND, type FleetControlAction, type FleetControlArgs, type FleetControlResult } from '../src/ui-control'
import type { CommandRequest, CommandResult, FleetRow, FleetSnapshot, WatcherDetail, WatcherTarget, WatcherWorker } from '../src/control-contracts'
import {
  COMMAND_METHOD,
  DEBUG_METHOD,
  DESCRIBE_METHOD,
  DETAIL_METHOD,
  FLEET_METHOD,
  FLEET_VIEW_ID,
  SESSION_VIEW_ID,
  button,
  click,
  deferred,
  flush,
  inputValue,
  latestReport,
  makeDetail,
  makeFixture,
  makeRow,
  makeSnapshot,
  settleUi,
  type Deferred,
  type Fixture
} from './ui-fixture'

const fence = { executionHostId: 'host', schedulerOwner: 'scheduler', workspaceKey: 'workspace', revision: 1 }

async function mountReady(fixture: Fixture, input?: unknown) {
  const mounted = await fixture.mountFleet(input)
  await settleUi()
  return mounted
}

async function disposeMount(fixture: Fixture, mounted: Fixture['mounted'][number]): Promise<void> {
  fixture.mounted.splice(fixture.mounted.indexOf(mounted), 1)
  await act(async () => {
    mounted.cleanup()
    mounted.element.remove()
    await drainResolutionMicrotasks()
  })
}

async function selectRow(root: ParentNode, watcherId: string): Promise<void> {
  const row = [...root.querySelectorAll<HTMLButtonElement>('.ui-list-row__main')].find((item) => item.textContent?.includes(`Watcher ${watcherId}`))
  if (!row) throw new Error(`Fleet row not found: ${watcherId}`)
  await act(async () => { row.click() })
  await settleUi()
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await settleUi()
}

async function emitSnapshot(fixture: Fixture, snapshot: FleetSnapshot): Promise<void> {
  await act(async () => { fixture.emitSnapshot(snapshot); await Promise.resolve() })
  await settleUi()
}
async function drainResolutionMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}
async function resolveDeferred<T>(pending: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    pending.resolve(value)
    await pending.promise
  })
  await settleUi()
}

async function rejectDeferred<T>(pending: Deferred<T>, error: unknown): Promise<void> {
  await act(async () => {
    pending.reject(error)
    try {
      await pending.promise
    } catch {}
  })
  await settleUi()
}

async function resolveConfirm(fixture: Fixture, value: boolean): Promise<void> {
  await act(async () => {
    fixture.answerConfirm(value)
    await Promise.resolve()
  })
  await settleUi()
}

function captureControlDelivery(fixture: Fixture): unknown[] {
  const deliveries: unknown[] = []
  fixture.enqueue('ui.window.command.run', (params: Record<string, unknown>) => {
    const handler = typeof params.id === 'string' ? fixture.provided.get(params.id) : undefined
    if (typeof handler !== 'function') throw new Error('Missing Heimdall UI control handler')
    const result = handler(params.args)
    deliveries.push(result)
    return { result }
  })
  return deliveries
}

function controlArgs(fixture: Fixture, action: FleetControlAction, revision?: number, generation?: string): FleetControlArgs {
  const report = latestReport(fixture)
  const editorRevision = action === 'cancel-concurrency' ? report.concurrencyRevision : report.budgetEditorRevision
  if (!report.generation) throw new Error('A mounted detail must have a selection generation')
  return {
    action,
    instance: report.instance,
    generation: generation ?? report.generation,
    revision: revision ?? editorRevision ?? 0
  }
}

function directControl(fixture: Fixture, args: FleetControlArgs): FleetControlResult {
  const handler = fixture.provided.get(UI_CONTROL_COMMAND)
  if (typeof handler !== 'function') throw new Error('Missing Heimdall UI control command')
  let result!: FleetControlResult
  act(() => { result = handler(args) as FleetControlResult })
  return result
}

function worker(overrides: Partial<WatcherWorker> = {}): WatcherWorker {
  return {
    identity: { dispatchId: 'd-1', sessionId: 's-1', processIncarnation: 'p-1' },
    state: 'live',
    assignmentActive: true,
    ...overrides
  }
}

function rowWith(watcherId: string, target?: WatcherTarget): FleetRow {
  return makeRow(watcherId, { target: target ?? { watcherId } })
}
function visibleDetail(watcherId: string): WatcherDetail {
  const base = makeDetail(watcherId)
  return makeDetail(watcherId, {
    enrollment: { ...base.enrollment, haltReason: `Detail marker ${watcherId}` }
  })
}

async function pressEscape(): Promise<void> {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  await settleUi()
}

function expectNoBackAffordance(root: ParentNode): void {
  const labels = [...root.querySelectorAll('button')].map((entry) => entry.getAttribute('aria-label') ?? entry.textContent?.trim())
  expect(labels).not.toContain('Back')
  expect(labels).not.toContain('Back to fleet')
}

test.skipIf(!existsSync(chromium.executablePath()))('keeps the complete fleet summary inside a narrow panel', async () => {
  const fixture = makeFixture()
  const root = (await mountReady(fixture)).element
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 646, height: 900 } })
    await page.setContent(`<style>* { box-sizing: border-box } body { margin: 0 }</style><div id=\"panel\" style=\"width:116px\">${root.innerHTML}</div>`)
    for (const name of ['compatibility-tokens', 'tokens', 'components']) {
      await page.addStyleTag({ content: readFileSync(resolve(import.meta.dir, `../../../packages/ui/src/design-system/${name}.css`), 'utf8') })
    }
    for (const width of [116, 200, 320]) {
      await page.locator('#panel').evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px` }, width)
      const summary = await page.locator('.ui-badge').evaluate((element) => {
        const panel = document.querySelector('#panel')!.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(element)
        return {
          panel: { left: panel.left, right: panel.right },
          lines: [...range.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right })),
          text: element.textContent,
        }
      })
      expect(summary.text).toContain('0 active')
      expect(summary.text).toContain('0 need attention')
      for (const line of summary.lines) {
        expect(line.left).toBeGreaterThanOrEqual(summary.panel.left)
        expect(line.right).toBeLessThanOrEqual(summary.panel.right)
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)

test('keeps the fleet open without Back controls and retains its snapshot on refresh failure', async () => {
  const fixture = makeFixture()
  let reads = 0
  fixture.setHandler(FLEET_METHOD, () => {
    reads += 1
    if (reads > 1) throw new Error('fleet offline')
    return makeSnapshot()
  })
  const root = (await mountReady(fixture)).element

  expect(root.textContent).toContain('No watchers in the fleet.')
  expectNoBackAffordance(document.body)
  expect(fixture.views.filter((view) => view.id === 'closeView')).toHaveLength(0)
  await click(root, 'Refresh fleet')

  expect(root.querySelector('[role="alert"]')?.textContent).toContain('fleet offline')
  expect(root.querySelector('[role="alert"] .ui-inline-error__message')?.textContent).toBe('Fleet refresh failed; showing the last confirmed snapshot: fleet offline')
  expect(root.textContent).toContain('No watchers in the fleet.')
  expectNoBackAffordance(document.body)
  expect(fixture.views.filter((view) => view.id === 'closeView')).toHaveLength(0)
})

test('returns from a missing initial watcher to the fleet without closing the view', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => null)
  const root = (await mountReady(fixture, { watcherId: 'unavailable-watcher' })).element

  expect(root.textContent).toContain('This watcher is no longer available in the fleet.')
  await click(root, 'Back to fleet')

  expect(root.textContent).toContain('Watcher fleet')
  expect(root.textContent).toContain('No watchers in the fleet.')
  expectNoBackAffordance(document.body)
  expect(fixture.views.filter((view) => view.id === 'closeView')).toHaveLength(0)
})

test('Escape returns from a failed initial detail to the fleet, then closes from the fleet', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => { throw new Error('detail unavailable') })
  const root = (await mountReady(fixture, { watcherId: 'unavailable-watcher' })).element

  expect(root.textContent).toContain('detail unavailable')
  expect(root.querySelector('[role="alert"] .ui-inline-error__message')?.textContent).toBe('Could not load watcher details: detail unavailable')
  await pressEscape()
  expect(root.textContent).toContain('Watcher fleet')
  expect(root.textContent).toContain('No watchers in the fleet.')
  expect(fixture.views.at(-1)).toEqual({ id: FLEET_VIEW_ID, input: undefined, updateInput: true })
  await pressEscape()
  expect(fixture.views.filter((view) => view.id === 'closeView')).toHaveLength(1)
})

test('N8: navigation opens the fleet view without input', async () => {
  const fixture = makeFixture()
  const navigation = await fixture.mountNavigation()
  await settleUi()
  await click(navigation.element, 'Open Heimdall fleet')
  expect(fixture.views).toEqual([{ id: FLEET_VIEW_ID, input: undefined }])
})

test('R1: selecting a fleet row opens the same view with target input and reads that detail', async () => {
  const fixture = makeFixture()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => visibleDetail((target as WatcherTarget).watcherId))
  const mounted = await mountReady(fixture)
  await selectRow(mounted.element, 'a')

  expect(fixture.views).toEqual([{ id: FLEET_VIEW_ID, input: { target: { watcherId: 'a' } }, updateInput: true }])
  expect(fixture.callsFor(DETAIL_METHOD).at(-1)?.params).toEqual({ target: { watcherId: 'a' } })
  expect(mounted.element.textContent).toContain('Detail marker a')
  expect(latestReport(fixture).target).toEqual({ watcherId: 'a' })
})

test('R2: Back routes through fleet view input without closing the view', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Back to fleet')

  expect(fixture.views.at(-1)).toEqual({ id: FLEET_VIEW_ID, input: undefined, updateInput: true })
  expect(mounted.element.textContent).toContain('Watcher fleet')
  expect(fixture.views.filter((view) => view.id === 'closeView')).toHaveLength(0)
})

test('R3: Escape routes detail to the list and Escape on the list closes the view', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await pressEscape()
  expect(fixture.views.at(-1)).toEqual({ id: FLEET_VIEW_ID, input: undefined, updateInput: true })
  expect(fixture.views.filter((view) => view.id === 'closeView')).toHaveLength(0)
  await pressEscape()
  expect(fixture.views.filter((view) => view.id === 'closeView')).toHaveLength(1)
})

test('R4: an equal input object is accepted without re-reading or rotating generation', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  const report = latestReport(fixture)
  const reads = fixture.callsFor(DETAIL_METHOD).length
  let accepted = false
  await act(async () => { accepted = mounted.cleanup.updateInput?.({ target: { watcherId: 'a' } }) ?? false })
  await settleUi()

  expect(accepted).toBe(true)
  expect(fixture.callsFor(DETAIL_METHOD)).toHaveLength(reads)
  expect(latestReport(fixture).generation).toBe(report.generation)
})

test('R5: notification-style watcherId input selects and reads the new detail in place', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, ({ target }) => visibleDetail((target as WatcherTarget).watcherId))
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  await act(async () => { fixture.context.openView(FLEET_VIEW_ID, { watcherId: 'b' }) })
  await settleUi()

  expect(fixture.views.at(-1)).toEqual({ id: FLEET_VIEW_ID, input: { watcherId: 'b' }, updateInput: true })
  expect(fixture.callsFor(DETAIL_METHOD).at(-1)?.params).toEqual({ target: { watcherId: 'b' } })
  expect(mounted.element.textContent).toContain('Detail marker b')
  expect(latestReport(fixture).target).toEqual({ watcherId: 'b' })
})
test('C1: a local command sends the exact owner request without confirmation extras', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Pause')
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params)).toEqual([
    { target: { watcherId: 'a' }, expectedOwner: fence, command: { kind: 'pause' } }
  ])
})

test('C2: remote command includes its pairing target and expected incarnation', async () => {
  const target = { watcherId: 'r', connectionId: 'peer-1', pairingRevision: 3 }
  const detail = makeDetail('r', {
    target,
    ownerIncarnation: 'inc-7',
    enrollment: { ...makeDetail('r').enrollment, paused: true }
  })
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => detail)
  const mounted = await mountReady(fixture, { target })
  await click(mounted.element, 'Resume')
  expect(fixture.callsFor(COMMAND_METHOD).at(-1)?.params).toEqual({
    target,
    expectedOwner: fence,
    command: { kind: 'resume' },
    expectedIncarnation: 'inc-7'
  })
})

test('C3: approving sends the exact captured escalation approval scope', async () => {
  const scope = { actionKind: 'commit', contentIdentity: 'tree-4', evidenceKey: 'review-5', preparedCommitSha: 'abc123' }
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', {
    openEscalations: [{ escalationId: 'esc-1', escalationKind: 'review', status: 'open', foldCount: 1, approvalScope: scope }]
  }))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Approve exact action')
  expect(fixture.callsFor(COMMAND_METHOD).at(-1)?.params).toEqual({
    target: { watcherId: 'a' },
    expectedOwner: fence,
    command: { kind: 'approve', escalationId: 'esc-1', scope }
  })
})

test('C4: unchanged budget fields remain confirmed and zero differs from unlimited', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Edit budget')
  const active = mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!
  const turns = mounted.element.querySelector<HTMLInputElement>('#worker-turn-limit')!
  expect(active.value).toBe('1.5')
  await inputValue(turns, '0')
  await submit(active.closest('form')!)
  await click(mounted.element, 'Edit budget')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#worker-turn-limit')!, '')
  await submit(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!.closest('form')!)
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params)).toEqual([
    {
      target: { watcherId: 'a' },
      expectedOwner: fence,
      command: { kind: 'adjust-budget', budget: { wallClockActiveMs: 90_000, turns: 0 } }
    },
    {
      target: { watcherId: 'a' },
      expectedOwner: fence,
      command: { kind: 'adjust-budget', budget: { wallClockActiveMs: null, turns: null } }
    }
  ])
})

test('C5: objective concurrency accepts the inclusive 1 through 1,024 bounds', async () => {
  const objective = makeDetail('o', { enrollment: { ...makeDetail('o').enrollment, kind: 'objective', kindPayload: { maxConcurrency: 4 } } })
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => objective)
  const mounted = await mountReady(fixture, { target: { watcherId: 'o' } })
  const field = mounted.element.querySelector<HTMLInputElement>('#max-concurrency-o')!
  for (const value of ['1024', '1']) {
    await inputValue(field, value)
    await submit(field.closest('form')!)
  }
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params)).toEqual([
    { target: { watcherId: 'o' }, expectedOwner: fence, command: { kind: 'set-concurrency', maxConcurrency: 1024 } },
    { target: { watcherId: 'o' }, expectedOwner: fence, command: { kind: 'set-concurrency', maxConcurrency: 1 } }
  ])
})

test('C6: delete previews first, confirms the exact owner text, and sends only on confirmation', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { name: 'A watcher' }))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Owner preview: remove A watcher')
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Delete watcher')
  expect(fixture.callsFor(DESCRIBE_METHOD).at(-1)?.params).toEqual({
    target: { watcherId: 'a' }, expectedOwner: fence, command: { kind: 'delete' }
  })
  expect(fixture.callsFor(DESCRIBE_METHOD).at(-1)?.params).not.toHaveProperty('yes')
  expect(fixture.confirms.at(-1)?.body).toBe('Owner preview: remove A watcher')
  await resolveConfirm(fixture, false)
  await flush()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)

  await click(mounted.element, 'Delete watcher')
  await resolveConfirm(fixture, true)
  await flush()
  expect(fixture.callsFor(COMMAND_METHOD).at(-1)?.params).toEqual({
    target: { watcherId: 'a' }, expectedOwner: fence, command: { kind: 'delete' }, yes: true
  })
})

test('C6: a null delete preview refuses without opening confirmation or sending', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(DESCRIBE_METHOD, () => null)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Delete watcher')
  expect(fixture.confirms).toHaveLength(0)
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toEqual([{ title: 'Delete watcher refused', body: expect.any(String), kind: 'warning' }])
})

test('C7: indeterminate owner outcomes are shown once and never retried automatically', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(COMMAND_METHOD, () => ({ kind: 'indeterminate', detail: 'reply lost' } satisfies CommandResult))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Pause')
  await flush()

  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(1)
  expect(fixture.callsFor(COMMAND_METHOD)[0]?.params).toEqual({
    target: { watcherId: 'a' },
    expectedOwner: fence,
    command: { kind: 'pause' }
  })
  expect(mounted.element.querySelector('[role=\"status\"]')?.textContent).toContain('Indeterminate · reply lost')
  expect(mounted.element.querySelector('[role=\"status\"]')?.textContent).toContain('Do not retry automatically')
  expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
})

test('C8: Stop needs an exact process identity and answers the captured worker question', async () => {
  const incomplete = makeDetail('a', { workers: [worker({ identity: { dispatchId: 'd-1', sessionId: 's-1' } })] })
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => incomplete)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  expect(button(mounted.element, 'Stop').disabled).toBe(true)

  const identity = { dispatchId: 'd-1', sessionId: 's-1', processIncarnation: 'p-1', pid: 14, startTime: 'started', terminalHandle: 'term' }
  const full = makeDetail('a', { workers: [worker({ identity, question: { messageId: 'm-1', body: 'Proceed?' } })] })
  fixture.setHandler(DETAIL_METHOD, () => full)
  await act(async () => { fixture.emitSnapshot(makeSnapshot([], 2)) })
  await settleUi()
  await click(mounted.element, 'Stop')
  await inputValue(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!, 'yes please')
  await click(mounted.element, 'Send answer')
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params)).toEqual([
    { target: { watcherId: 'a' }, expectedOwner: fence, command: { kind: 'stop-worker', identity } },
    { target: { watcherId: 'a' }, expectedOwner: fence, command: { kind: 'answer-question', messageId: 'm-1', body: 'yes please' } }
  ])
})

test('C9: local worker terminal opens its worktree and remote terminal stays disabled', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', {
    enrollment: { ...makeDetail('a').enrollment, worktreeId: 'wt-1' },
    workers: [worker({ identity: { dispatchId: 'd-1', sessionId: 's-1', processIncarnation: 'p-1' } })]
  }))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Open terminal')
  expect(fixture.views.at(-1)).toEqual({ id: SESSION_VIEW_ID, input: { worktree: 'wt-1', session: 's-1' } })

  const remoteTarget = { watcherId: 'r', connectionId: 'peer-1', pairingRevision: 3 }
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('r', {
    target: remoteTarget,
    ownerIncarnation: 'inc-7',
    workers: [worker({ identity: { dispatchId: 'd-r', sessionId: 's-r', processIncarnation: 'p-r' } })]
  }))
  await act(async () => { fixture.context.openView(FLEET_VIEW_ID, { target: remoteTarget }) })
  await settleUi()
  expect(button(mounted.element, 'Open terminal').disabled).toBe(true)
})

test('C10: debug report copies pretty JSON for the captured target', async () => {
  const report = { watcherId: 'a', state: { seen: true } }
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(DEBUG_METHOD, () => report)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Copy debug report')
  expect(fixture.callsFor(DEBUG_METHOD).at(-1)?.params).toEqual({ target: { watcherId: 'a' } })
  expect(fixture.clipboardWrites).toEqual([JSON.stringify(report, null, 2)])
})

test('L1: a late applied delete to A cannot clear selected B or attach feedback to B', async () => {
  const fixture = makeFixture()
  const deleteResult = deferred<unknown>()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => visibleDetail((target as WatcherTarget).watcherId))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Delete A')
  fixture.setHandler(COMMAND_METHOD, () => deleteResult.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Delete watcher')
  await resolveConfirm(fixture, true)
  await flush()
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  await resolveDeferred(deleteResult, { kind: 'applied', appliedAtMs: 5 })
  await flush()

  expect(mounted.element.textContent).toContain('Detail marker b')
  expect(latestReport(fixture).target).toEqual({ watcherId: 'b' })
  expect(fixture.callsFor(DETAIL_METHOD).at(-1)?.params).toEqual({ target: { watcherId: 'b' } })
  expect(mounted.element.textContent).not.toContain('Delete watcher applied')
  expect(fixture.toasts.filter((toast) => toast.title === 'Delete watcher applied')).toHaveLength(1)
})

test('L2: a late detail response for A cannot replace B', async () => {
  const fixture = makeFixture()
  const aDetail = deferred<unknown>()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => (target as WatcherTarget).watcherId === 'a' ? aDetail.promise : visibleDetail('b'))
  const mounted = await mountReady(fixture)
  await selectRow(mounted.element, 'a')
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  await resolveDeferred(aDetail, visibleDetail('a'))
  await flush()

  expect(mounted.element.textContent).toContain('Detail marker b')
  expect(mounted.element.textContent).not.toContain('Detail marker a')
  expect(latestReport(fixture).target).toEqual({ watcherId: 'b' })
})

test('L3: a late debug report for A neither copies nor toasts after B is selected', async () => {
  const fixture = makeFixture()
  const report = deferred<unknown>()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => makeDetail((target as WatcherTarget).watcherId))
  fixture.setHandler(DEBUG_METHOD, () => report.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Copy debug report')
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  await resolveDeferred(report, { watcherId: 'a' })
  await flush()
  expect(fixture.clipboardWrites).toEqual([])
  expect(fixture.toasts).toEqual([])
})

test('L4: a late session lookup for A cannot open a terminal after B is selected', async () => {
  const lookup = deferred<unknown>()
  const fixture = makeFixture()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => makeDetail((target as WatcherTarget).watcherId, {
    workers: [worker({ identity: { dispatchId: `d-${(target as WatcherTarget).watcherId}`, sessionId: 's-a', processIncarnation: 'p-a' } })]
  }))
  fixture.setHandler('quirky.session/get', () => lookup.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Open terminal')
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  await resolveDeferred(lookup, { worktreeId: 'wt-1' })
  await flush()
  expect(fixture.views.filter((view) => view.id === SESSION_VIEW_ID)).toEqual([])
})

test('L5: a delete confirmation that resolves after selection changes sends no command', async () => {
  const fixture = makeFixture()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => makeDetail((target as WatcherTarget).watcherId))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Delete A')
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Delete watcher')
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  await resolveConfirm(fixture, true)
  await flush()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
})

test('L6: command reservations disable only the matching target/epoch and release by token', async () => {
  const fixture = makeFixture()
  const first = deferred<unknown>()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => makeDetail((target as WatcherTarget).watcherId))
  fixture.enqueue(COMMAND_METHOD, first.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Pause')
  expect(button(mounted.element, 'Pause').disabled).toBe(true)
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  expect(button(mounted.element, 'Pause').disabled).toBe(false)
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'a')
  expect(button(mounted.element, 'Pause').disabled).toBe(true)

  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  await resolveDeferred(first, { kind: 'applied', appliedAtMs: 1 })
  await flush()
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'a')
  expect(button(mounted.element, 'Pause').disabled).toBe(false)
  expect(mounted.element.textContent).not.toContain('Pause watcher applied')
})

test('I1: answer draft is partitioned by question identity', async () => {
  let detailReads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => {
    detailReads += 1
    const question = detailReads === 1 ? { messageId: 'm1', body: 'First?' } : { messageId: 'm2', body: 'Second?' }
    return makeDetail('a', { workers: [worker({ question })] })
  })
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  const answer = mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!
  await inputValue(answer, 'for m1')
  await emitSnapshot(fixture, makeSnapshot([], 2))
  expect(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!.value).toBe('')
  expect(button(mounted.element, 'Send answer').disabled).toBe(true)
  await inputValue(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!, 'for m2')
  await click(mounted.element, 'Send answer')
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params)).toEqual([{
    target: { watcherId: 'a' },
    expectedOwner: fence,
    command: { kind: 'answer-question', messageId: 'm2', body: 'for m2' }
  }])
})

test('I2: submit refuses a question answered by the latest held detail', async () => {
  const latest = deferred<unknown>()
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => {
    reads += 1
    return reads === 1
      ? makeDetail('a', { workers: [worker({ question: { messageId: 'm1', body: 'Question?' } })] })
      : latest.promise
  })
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await inputValue(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!, 'ok')
  let submitButton: HTMLButtonElement | undefined
  await act(async () => {
    fixture.emitSnapshot(makeSnapshot([], 2))
    latest.resolve(makeDetail('a', { workers: [worker({ question: { messageId: 'm1', body: 'Question?', answered: true } })] }))
    await latest.promise
    await drainResolutionMicrotasks()
    submitButton = button(mounted.element, 'Send answer')
    submitButton.click()
  })
  await settleUi()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toEqual([{ title: 'Answer worker question d-1 not sent', body: "The worker's question changed; review it and try again.", kind: 'error' }])
})

test('I3: process replacement clears answer draft and refuses a stale Stop receipt', async () => {
  const latest = deferred<unknown>()
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => {
    reads += 1
    return reads === 1
      ? makeDetail('a', { workers: [worker({ question: { messageId: 'm1', body: 'Question?' } })] })
      : latest.promise
  })
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await inputValue(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!, 'old answer')
  await act(async () => {
    fixture.emitSnapshot(makeSnapshot([], 2))
    latest.resolve(makeDetail('a', { workers: [worker({ identity: { dispatchId: 'd-1', sessionId: 's-1', processIncarnation: 'p-2' }, question: { messageId: 'm1', body: 'Question?' } })] }))
    await latest.promise
    await drainResolutionMicrotasks()
    button(mounted.element, 'Stop').click()
    button(mounted.element, 'Send answer').click()
  })
  await settleUi()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!.value).toBe('')
  expect(fixture.toasts).toContainEqual({ title: 'Stop worker d-1 not sent', body: "The worker's process changed; review it and try again.", kind: 'error' })
})

test('I3: a current Stop sends the changed process identity', async () => {
  const identity = { dispatchId: 'd-1', sessionId: 's-1', processIncarnation: 'p-2' }
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { workers: [worker({ identity })] }))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Stop')
  expect(fixture.callsFor(COMMAND_METHOD).at(-1)?.params).toEqual({
    target: { watcherId: 'a' },
    expectedOwner: fence,
    command: { kind: 'stop-worker', identity }
  })
})

test('I3: a session replacement makes a captured answer ineligible', async () => {
  const latest = deferred<unknown>()
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => ++reads === 1
    ? makeDetail('a', { workers: [worker({ question: { messageId: 'm1', body: 'Question?' } })] })
    : latest.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await inputValue(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!, 'ok')
  await act(async () => {
    fixture.emitSnapshot(makeSnapshot([], 2))
    latest.resolve(makeDetail('a', { workers: [worker({ identity: { dispatchId: 'd-1', sessionId: 's-2', processIncarnation: 'p-1' }, question: { messageId: 'm1', body: 'Question?' } })] }))
    await latest.promise
    await drainResolutionMicrotasks()
    button(mounted.element, 'Send answer').click()
  })
  await settleUi()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toContainEqual({ title: 'Answer worker question d-1 not sent', body: "The worker's process changed; review it and try again.", kind: 'error' })
})

test('I4: approval refuses a changed prepared-commit scope', async () => {
  const latest = deferred<unknown>()
  let reads = 0
  const oldScope = { actionKind: 'commit', contentIdentity: 'tree', evidenceKey: 'proof', preparedCommitSha: 'c1' }
  const newScope = { ...oldScope, preparedCommitSha: 'c2' }
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => ++reads === 1
    ? makeDetail('a', { openEscalations: [{ escalationId: 'esc-1', escalationKind: 'awaiting-approval', status: 'open', foldCount: 1, approvalScope: oldScope }] })
    : latest.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await act(async () => {
    fixture.emitSnapshot(makeSnapshot([], 2))
    latest.resolve(makeDetail('a', { openEscalations: [{ escalationId: 'esc-1', escalationKind: 'awaiting-approval', status: 'open', foldCount: 1, approvalScope: newScope }] }))
    await latest.promise
    await drainResolutionMicrotasks()
    button(mounted.element, 'Approve exact action').click()
  })
  await settleUi()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toContainEqual({ title: 'Approve awaiting-approval not sent', body: 'The approval scope changed; review it and try again.', kind: 'error' })
})
test('I4: an escalation closed in the latest detail cannot be approved', async () => {
  const latest = deferred<unknown>()
  let reads = 0
  const scope = { actionKind: 'commit', contentIdentity: 'tree', evidenceKey: 'proof', preparedCommitSha: 'c1' }
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => ++reads === 1
    ? makeDetail('a', { openEscalations: [{ escalationId: 'esc-1', escalationKind: 'awaiting-approval', status: 'open', foldCount: 1, approvalScope: scope }] })
    : latest.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await act(async () => {
    fixture.emitSnapshot(makeSnapshot([], 2))
    latest.resolve(makeDetail('a', { openEscalations: [{ escalationId: 'esc-1', escalationKind: 'awaiting-approval', status: 'closed', foldCount: 1, approvalScope: scope }] }))
    await latest.promise
    await drainResolutionMicrotasks()
    button(mounted.element, 'Approve exact action').click()
  })
  await settleUi()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toContainEqual({ title: 'Approve awaiting-approval not sent', body: 'The approval scope changed; review it and try again.', kind: 'error' })
})

test('submit revalidates command gates against the latest detail before dispatch', async () => {
  const baseEnrollment = makeDetail('a').enrollment
  const blockedDetails = [
    makeDetail('a', { readOnly: true }),
    makeDetail('a', { ownerContact: 'unverifiable' }),
    makeDetail('a', { enrollment: { ...baseEnrollment, malformed: 'bad payload' } }),
    makeDetail('a', { pendingControls: ['already pending'] })
  ]
  for (const blocked of blockedDetails) {
    const latest = deferred<unknown>()
    let reads = 0
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => ++reads === 1 ? makeDetail('a') : latest.promise)
    const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
    await act(async () => {
      fixture.emitSnapshot(makeSnapshot([], 2))
      latest.resolve(blocked)
      await latest.promise
      await drainResolutionMicrotasks()
      button(mounted.element, 'Pause').click()
    })
    await settleUi()
    expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  }
})

test('delete revalidates the latest command gate after confirmation', async () => {
  const fixture = makeFixture()
  let current = makeDetail('a')
  fixture.setHandler(DETAIL_METHOD, () => current)
  fixture.setHandler(DESCRIBE_METHOD, () => 'Delete watcher a')
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Delete watcher')
  current = makeDetail('a', { readOnly: true })
  await emitSnapshot(fixture, makeSnapshot([], 2))
  await resolveConfirm(fixture, true)

  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
})

test('I5: owner epoch changes reset editor, drafts, validation, and feedback; revision-only changes do not', async () => {
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(COMMAND_METHOD, () => ({ kind: 'refused', reason: 'stale-revision', detail: 'revision moved' }))
  fixture.setHandler(DETAIL_METHOD, () => {
    reads += 1
    const base = makeDetail('r', {
      target: { watcherId: 'r', connectionId: 'peer-1', pairingRevision: 3 },
      ownerIncarnation: reads >= 3 ? 'inc-8' : 'inc-7',
      ownerFence: { ...fence, revision: reads >= 2 ? 2 : 1 },
      enrollment: { ...makeDetail('r').enrollment, kind: 'objective', kindPayload: { maxConcurrency: reads >= 3 ? 8 : 4 } },
      workers: [worker({ question: { messageId: 'm1', body: 'Question?' } })]
    })
    return base
  })
  const target = { watcherId: 'r', connectionId: 'peer-1', pairingRevision: 3 }
  const mounted = await mountReady(fixture, { target })
  const generation = latestReport(fixture).generation
  await click(mounted.element, 'Edit budget')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '7')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#max-concurrency-r')!, '9')
  await inputValue(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!, 'draft')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#worker-turn-limit')!, '1.5')
  await submit(mounted.element.querySelector<HTMLInputElement>('#worker-turn-limit')!.closest('form')!)
  expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain('Worker-turn limit must be a non-negative integer')
  await click(mounted.element, 'Pause')
  await flush()

  await emitSnapshot(fixture, makeSnapshot([], 2))
  expect(latestReport(fixture).generation).toBe(generation)
  expect(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')?.value).toBe('7')
  expect(mounted.element.querySelector<HTMLInputElement>('#max-concurrency-r')?.value).toBe('9')
  expect(mounted.element.querySelector<HTMLInputElement>('#worker-turn-limit')?.value).toBe('1.5')
  expect(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')?.value).toBe('draft')
  expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain('Worker-turn limit must be a non-negative integer')
  expect(mounted.element.querySelector('[role="status"]')?.textContent).toContain('Pause watcher')

  const confirmedAtEight = { ...makeDetail('r').enrollment, kind: 'objective', kindPayload: { maxConcurrency: 8 } }
  const rowAtEight = makeRow('r', {
    target,
    ownerFence: { ...fence, revision: 2 },
    enrollment: confirmedAtEight,
    maxConcurrency: 8
  })
  await emitSnapshot(fixture, makeSnapshot([rowAtEight], 3))
  expect(latestReport(fixture).generation).toBe(generation)
  expect(mounted.element.querySelector('#active-time-limit')).toBeNull()
  expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
  expect(mounted.element.querySelector('[role="status"]')?.textContent ?? '').not.toContain('Pause watcher')
  expect(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')?.value).toBe('')
  await click(mounted.element, 'Edit budget')
  expect(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')?.value).toBe('1.5')
  expect(mounted.element.querySelector<HTMLInputElement>('#max-concurrency-r')?.value).toBe('8')
})

test('I6: remote delete sends the captured preview request verbatim plus yes', async () => {
  const target = { watcherId: 'r', connectionId: 'peer-1', pairingRevision: 3 }
  const detail = makeDetail('r', { target, ownerIncarnation: 'inc-7' })
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => detail)
  fixture.setHandler(DESCRIBE_METHOD, () => 'Preview')
  const mounted = await mountReady(fixture, { target })
  await click(mounted.element, 'Delete watcher')
  await resolveConfirm(fixture, true)
  await flush()
  const request = { target, expectedOwner: fence, command: { kind: 'delete' }, expectedIncarnation: 'inc-7' } satisfies CommandRequest
  expect(fixture.callsFor(DESCRIBE_METHOD).at(-1)?.params).toEqual(request)
  expect(fixture.callsFor(COMMAND_METHOD).at(-1)?.params).toEqual({ ...request, yes: true })
})

test('I7: a fence change during delete preview prevents confirmation and reports stale ownership', async () => {
  const preview = deferred<unknown>()
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { ownerFence: { ...fence, revision: ++reads > 1 ? 2 : 1 } }))
  fixture.setHandler(DESCRIBE_METHOD, () => preview.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Delete watcher')
  await emitSnapshot(fixture, makeSnapshot([], 2))
  await resolveDeferred(preview, 'Preview')
  await flush()
  expect(fixture.confirms).toHaveLength(0)
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toContainEqual({ title: 'Delete watcher not sent', body: "The watcher's owner changed; review it and try again.", kind: 'warning' })
})

test('I8: an incarnation change during remote confirmation refuses the captured delete', async () => {
  let reads = 0
  const target = { watcherId: 'r', connectionId: 'peer-1', pairingRevision: 3 }
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('r', { target, ownerIncarnation: ++reads > 1 ? 'inc-8' : 'inc-7' }))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Preview')
  const mounted = await mountReady(fixture, { target })
  await click(mounted.element, 'Delete watcher')
  await emitSnapshot(fixture, makeSnapshot([], 2))
  await resolveConfirm(fixture, true)
  await flush()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toContainEqual({ title: 'Delete watcher not sent', body: "The watcher's owner changed; review it and try again.", kind: 'warning' })
})

test('I8: a fence revision change during local confirmation refuses the captured delete', async () => {
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { ownerFence: { ...fence, revision: ++reads > 1 ? 2 : 1 } }))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Preview')
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Delete watcher')
  await emitSnapshot(fixture, makeSnapshot([], 2))
  await resolveConfirm(fixture, true)
  await flush()
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  expect(fixture.toasts).toContainEqual({ title: 'Delete watcher not sent', body: "The watcher's owner changed; review it and try again.", kind: 'warning' })
})

test('I9: latest-detail ref rejects the old answer receipt before React commits a refreshed question', async () => {
  for (const nextIdentity of [
    { dispatchId: 'd-1', sessionId: 's-1', processIncarnation: 'p-2' },
    { dispatchId: 'd-1', sessionId: 's-2', processIncarnation: 'p-1' }
  ]) {
    const nextDetail = deferred<unknown>()
    let reads = 0
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => ++reads === 1
      ? makeDetail('a', { workers: [worker({ question: { messageId: 'm1', body: 'Question?' } })] })
      : nextDetail.promise)
    const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
    await inputValue(mounted.element.querySelector<HTMLTextAreaElement>('#worker-answer-d-1')!, 'ok')
    await act(async () => {
      fixture.emitSnapshot(makeSnapshot([], 2))
      nextDetail.resolve(makeDetail('a', { workers: [worker({ identity: nextIdentity, question: { messageId: 'm1', body: 'Question?' } })] }))
      await nextDetail.promise
      await drainResolutionMicrotasks()
      button(mounted.element, 'Send answer').click()
    })
    await settleUi()
    expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
    expect(fixture.toasts).toContainEqual({ title: 'Answer worker question d-1 not sent', body: "The worker's process changed; review it and try again.", kind: 'error' })
  }
})

test('I10: late old-epoch delete cannot reload or overwrite the new epoch or release its reservation', async () => {
  const oldDelete = deferred<unknown>()
  const newPause = deferred<unknown>()
  const target = { watcherId: 'r', connectionId: 'peer-1', pairingRevision: 3 }
  let detailReads = 0
  let commands = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => {
    detailReads += 1
    return makeDetail('r', {
      target,
      ownerIncarnation: detailReads > 1 ? 'inc-8' : 'inc-7',
      ownerLabel: detailReads > 1 ? 'Owner at inc-8' : 'Owner at inc-7'
    })
  })
  fixture.setHandler(DESCRIBE_METHOD, () => 'Preview')
  fixture.setHandler(COMMAND_METHOD, () => ++commands === 1 ? oldDelete.promise : newPause.promise)
  const mounted = await mountReady(fixture, { target })
  await click(mounted.element, 'Delete watcher')
  await resolveConfirm(fixture, true)
  await flush()
  await emitSnapshot(fixture, makeSnapshot([], 2))
  const readCount = fixture.callsFor(DETAIL_METHOD).length
  await click(mounted.element, 'Pause')
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(2)
  await resolveDeferred(oldDelete, { kind: 'applied', appliedAtMs: 1 })
  await flush()

  expect(fixture.callsFor(DETAIL_METHOD)).toHaveLength(readCount)
  expect(mounted.element.textContent).toContain('Owner at inc-8')
  expect(latestReport(fixture).target).toEqual(target)
  expect(fixture.callsFor(DETAIL_METHOD).at(-1)?.params).toEqual({ target })
  expect(mounted.element.querySelector('[role="status"]')?.textContent).not.toContain('Delete watcher')
  expect(button(mounted.element, 'Pause').disabled).toBe(true)
  expect(fixture.toasts.filter((toast) => toast.title === 'Delete watcher applied')).toHaveLength(1)
  await resolveDeferred(newPause, { kind: 'applied', appliedAtMs: 2 })
  await flush()
})

test('I11: debug copy after owner epoch changes stays silent', async () => {
  const report = deferred<unknown>()
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { ownerFence: { ...fence, schedulerOwner: ++reads > 1 ? 'scheduler-2' : 'scheduler' } }))
  fixture.setHandler(DEBUG_METHOD, () => report.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Copy debug report')
  await emitSnapshot(fixture, makeSnapshot([], 2))
  await resolveDeferred(report, { watcherId: 'a' })
  await flush()
  expect(fixture.clipboardWrites).toEqual([])
  expect(fixture.toasts).toEqual([])
})

test('I12: terminal lookup after owner epoch changes cannot open the worktree', async () => {
  const lookup = deferred<unknown>()
  let reads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', {
    ownerFence: { ...fence, schedulerOwner: ++reads > 1 ? 'scheduler-2' : 'scheduler' },
    workers: [worker({ identity: { dispatchId: 'd-1', sessionId: 's-1', processIncarnation: 'p-1' } })]
  }))
  fixture.setHandler('quirky.session/get', () => lookup.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Open terminal')
  await emitSnapshot(fixture, makeSnapshot([], 2))
  await resolveDeferred(lookup, { worktreeId: 'wt-1' })
  await flush()
  expect(fixture.views.filter((view) => view.id === SESSION_VIEW_ID)).toEqual([])
})

test('I13: a revision-only command update preserves drafts and command completion', async () => {
  const pause = deferred<unknown>()
  let detailReads = 0
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', {
    ownerFence: { ...fence, revision: ++detailReads > 1 ? 2 : 1 }
  }))
  fixture.setHandler(COMMAND_METHOD, () => pause.promise)
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Edit budget')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '7')
  await click(mounted.element, 'Pause')
  const callsBeforeRevision = fixture.callsFor(DETAIL_METHOD).length
  await emitSnapshot(fixture, makeSnapshot([rowWith('a')], 2))
  const callsBeforeCompletion = fixture.callsFor(DETAIL_METHOD).length
  await resolveDeferred(pause, { kind: 'applied', appliedAtMs: 5 })
  await flush()

  expect(callsBeforeCompletion).toBe(callsBeforeRevision + 1)
  expect(fixture.callsFor(DETAIL_METHOD)).toHaveLength(callsBeforeCompletion + 1)
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params)).toEqual([
    { target: { watcherId: 'a' }, expectedOwner: fence, command: { kind: 'pause' } }
  ])
  expect(mounted.element.textContent).toContain('Applied by the owner at')
  expect(button(mounted.element, 'Pause').disabled).toBe(false)
  expect(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')?.value).toBe('7')
})

test('M1: Edit budget uses the exact-window control command and reports its editor revision', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  const before = latestReport(fixture)
  const deliveries = captureControlDelivery(fixture)
  await click(mounted.element, 'Edit budget')
  const self = fixture.callsFor('ui.window.self').at(-1)
  const routed = fixture.callsFor('ui.window.command.run').at(-1)
  expect(self?.params).toEqual({})
  expect(routed?.params).toEqual({
    connId: 7,
    id: UI_CONTROL_COMMAND,
    args: { action: 'edit-budget', instance: before.instance, generation: before.generation, revision: 0 }
  })
  expect(deliveries[0]).toEqual({
    action: 'edit-budget',
    instance: before.instance,
    generation: before.generation,
    revision: 0,
    delivered: 1
  })
  expect(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')?.value).toBe('1.5')
  expect(latestReport(fixture)).toMatchObject({ budgetEditor: 'open', budgetEditorRevision: 1 })
})

test('M2: cancel budget restores its draft; cancel concurrency advances once per dirty transition', async () => {
  const objective = makeDetail('o', { enrollment: { ...makeDetail('o').enrollment, kind: 'objective', kindPayload: { maxConcurrency: 4 } } })
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => objective)
  const mounted = await mountReady(fixture, { target: { watcherId: 'o' } })
  await click(mounted.element, 'Edit budget')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '9')
  const budgetForm = mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!.closest('form')!
  const budgetDeliveries = captureControlDelivery(fixture)
  await click(budgetForm, 'Cancel')
  expect(mounted.element.querySelector('#active-time-limit')).toBeNull()
  expect(budgetDeliveries[0]).toMatchObject({ action: 'cancel-budget', revision: 1, delivered: 1 })
  expect(latestReport(fixture).budgetEditorRevision).toBe(2)

  const concurrency = mounted.element.querySelector<HTMLInputElement>('#max-concurrency-o')!
  await inputValue(concurrency, '9')
  await inputValue(concurrency, '12')
  expect(latestReport(fixture).concurrencyRevision).toBe(1)
  const args = controlArgs(fixture, 'cancel-concurrency', 1)
  let result!: FleetControlResult
  await act(async () => { result = await fixture.control(args) })
  await settleUi()
  expect(result).toMatchObject({ delivered: 1 })
  expect(concurrency.value).toBe('4')
  expect(latestReport(fixture).concurrencyRevision).toBe(2)
})

test('M3: stale, unknown, disabled, and list-session controls deliver zero without mutation', async () => {
  const fixture = makeFixture()
  fixture.setHandler(FLEET_METHOD, () => makeSnapshot([rowWith('a'), rowWith('b')]))
  fixture.setHandler(DETAIL_METHOD, ({ target }) => makeDetail((target as WatcherTarget).watcherId))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  const stale = controlArgs(fixture, 'edit-budget')
  expect(directControl(fixture, { ...stale, instance: 'unknown' })).toMatchObject({ delivered: 0 })
  expect(directControl(fixture, { ...stale, revision: 9 })).toMatchObject({ delivered: 0 })
  await click(mounted.element, 'Back to fleet')
  await selectRow(mounted.element, 'b')
  expect(directControl(fixture, stale)).toMatchObject({ delivered: 0 })
  const current = controlArgs(fixture, 'cancel-budget')
  expect(directControl(fixture, current)).toMatchObject({ delivered: 0 })
  expect(latestReport(fixture).budgetEditor).toBe('closed')

  const readOnlyFixture = makeFixture()
  readOnlyFixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { readOnly: true }))
  await mountReady(readOnlyFixture, { target: { watcherId: 'a' } })
  expect(directControl(readOnlyFixture, controlArgs(readOnlyFixture, 'edit-budget'))).toMatchObject({ delivered: 0 })

  const objective = makeDetail('o', { enrollment: { ...makeDetail('o').enrollment, kind: 'objective', kindPayload: { maxConcurrency: 4 } } })
  const cleanFixture = makeFixture()
  cleanFixture.setHandler(DETAIL_METHOD, () => objective)
  const clean = await mountReady(cleanFixture, { target: { watcherId: 'o' } })
  expect(directControl(cleanFixture, controlArgs(cleanFixture, 'cancel-concurrency'))).toMatchObject({ delivered: 0 })

  const pending = deferred<unknown>()
  cleanFixture.setHandler(COMMAND_METHOD, () => pending.promise)
  await click(clean.element, 'Pause')
  expect(directControl(cleanFixture, controlArgs(cleanFixture, 'edit-budget'))).toMatchObject({ delivered: 0 })
  await resolveDeferred(pending, { kind: 'applied', appliedAtMs: 1 })
  await flush()

  const listControl = controlArgs(cleanFixture, 'edit-budget')
  await click(clean.element, 'Back to fleet')
  expect(directControl(cleanFixture, listControl)).toMatchObject({ delivered: 0 })
})

test('M5: the registered UI control handler returns synchronously', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  await mountReady(fixture, { target: { watcherId: 'a' } })
  const handler = fixture.provided.get(UI_CONTROL_COMMAND)
  if (typeof handler !== 'function') throw new Error('Missing UI control handler')
  let result: unknown
  act(() => { result = handler(controlArgs(fixture, 'edit-budget')) })
  expect(result).not.toBeInstanceOf(Promise)
  expect(result).toMatchObject({ delivered: 1 })
})

test('M6: current-session control transport failures and delivered zero show an error toast', async () => {
  const scenarios: { setup(fixture: Fixture): void; message: string }[] = [
    { setup: (fixture) => fixture.answerNextSelf(new Error('no window')), message: 'no window' },
    { setup: (fixture) => fixture.enqueue('ui.window.command.run', new Error('run offline')), message: 'run offline' },
    {
      setup: (fixture) => fixture.enqueue('ui.window.command.run', {
        result: {
          action: 'edit-budget',
          instance: latestReport(fixture).instance,
          generation: latestReport(fixture).generation,
          revision: 0,
          delivered: 0
        }
      }),
      message: 'The watcher view changed before the control arrived.'
    }
  ]
  for (const scenario of scenarios) {
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
    const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
    scenario.setup(fixture)
    await click(mounted.element, 'Edit budget')
    expect(fixture.toasts.at(-1)).toEqual({ title: 'Could not edit the budget', body: scenario.message, kind: 'error' })
    expect(mounted.element.querySelector('#active-time-limit')).toBeNull()
  }
})

test('M7: reports expose exact detail/list state and per-mount instances', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const first = await mountReady(fixture, { target: { watcherId: 'a' } })
  const detailReport = latestReport(fixture)
  expect(detailReport).toEqual({
    view: 'detail',
    instance: expect.any(String),
    generation: expect.any(String),
    target: { watcherId: 'a' },
    budgetEditor: 'closed',
    budgetEditorRevision: 0,
    concurrencyDraft: 'unavailable',
    concurrencyRevision: 0
  })
  await click(first.element, 'Back to fleet')
  expect(latestReport(fixture)).toEqual({
    view: 'fleet',
    instance: detailReport.instance,
    generation: null,
    target: null,
    budgetEditor: 'unavailable',
    budgetEditorRevision: null,
    concurrencyDraft: 'unavailable',
    concurrencyRevision: null
  })

  await fixture.mountFleet({ target: { watcherId: 'a' } })
  await settleUi()
  expect(latestReport(fixture).instance).not.toBe(detailReport.instance)
})

test('M8: a delayed budget cancel cannot close a newer editor session', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(COMMAND_METHOD, () => ({ kind: 'refused', reason: 'stale-revision', detail: 'revision moved' }))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Edit budget')
  const initial = latestReport(fixture)
  const held = fixture.holdNextSelf()
  await click(mounted.element, 'Cancel')
  expect(latestReport(fixture).budgetEditorRevision).toBe(1)

  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '2')
  await click(mounted.element, 'Apply budget')
  expect(latestReport(fixture).budgetEditorRevision).toBe(2)
  await click(mounted.element, 'Edit budget')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '7')
  const toastCount = fixture.toasts.length
  const deliveries = captureControlDelivery(fixture)
  await resolveDeferred(held, { connId: 7 })

  expect(deliveries[0]).toMatchObject({
    action: 'cancel-budget',
    instance: initial.instance,
    generation: initial.generation,
    revision: 1,
    delivered: 0
  })
  expect(latestReport(fixture).budgetEditorRevision).toBe(3)
  expect(latestReport(fixture).budgetEditor).toBe('open')
  expect(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')?.value).toBe('7')
  expect(fixture.toasts).toHaveLength(toastCount)
})

test('M8: delayed concurrency cancel cannot erase a clean-then-changed draft', async () => {
  const fixture = makeFixture()
  const objective = makeDetail('o', { enrollment: { ...makeDetail('o').enrollment, kind: 'objective', kindPayload: { maxConcurrency: 4 } } })
  fixture.setHandler(DETAIL_METHOD, () => objective)
  const mounted = await mountReady(fixture, { target: { watcherId: 'o' } })
  const concurrency = mounted.element.querySelector<HTMLInputElement>('#max-concurrency-o')!
  await inputValue(concurrency, '9')
  const initial = latestReport(fixture)
  const held = fixture.holdNextSelf()
  await click(mounted.element, 'Cancel')
  await inputValue(concurrency, '4')
  expect(latestReport(fixture).concurrencyRevision).toBe(2)
  await inputValue(concurrency, '9')
  expect(latestReport(fixture).concurrencyRevision).toBe(3)
  const toastCount = fixture.toasts.length
  const deliveries = captureControlDelivery(fixture)

  await resolveDeferred(held, { connId: 7 })

  expect(deliveries[0]).toMatchObject({
    action: 'cancel-concurrency',
    instance: initial.instance,
    generation: initial.generation,
    revision: 1,
    delivered: 0
  })
  expect(latestReport(fixture).concurrencyRevision).toBe(3)
  expect(concurrency.value).toBe('9')
  expect(fixture.toasts).toHaveLength(toastCount)
})

test('M9: obsolete budget cancel failure is silent and preserves the successor draft', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(COMMAND_METHOD, () => ({ kind: 'refused', reason: 'stale-revision', detail: 'revision moved' }))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  await click(mounted.element, 'Edit budget')
  const held = fixture.holdNextSelf()
  await click(mounted.element, 'Cancel')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '2')
  await click(mounted.element, 'Apply budget')
  await click(mounted.element, 'Edit budget')
  await inputValue(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!, '7')
  const toastCount = fixture.toasts.length

  await rejectDeferred(held, new Error('old window lookup failed'))

  expect(fixture.toasts).toHaveLength(toastCount)
  expect(latestReport(fixture).budgetEditorRevision).toBe(3)
  expect(latestReport(fixture).budgetEditor).toBe('open')
  expect(mounted.element.querySelector<HTMLInputElement>('#active-time-limit')?.value).toBe('7')
})

test('M9: epoch reset makes a held concurrency cancel failure obsolete', async () => {
  const initial = makeDetail('o', {
    enrollment: { ...makeDetail('o').enrollment, kind: 'objective', kindPayload: { maxConcurrency: 4 } }
  })
  let current = initial
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => current)
  const mounted = await mountReady(fixture, { target: { watcherId: 'o' } })
  const generation = latestReport(fixture).generation
  const concurrency = mounted.element.querySelector<HTMLInputElement>('#max-concurrency-o')!
  await inputValue(concurrency, '9')
  const held = fixture.holdNextSelf()
  await click(mounted.element, 'Cancel')

  const replacement = makeDetail('o', {
    ownerFence: { ...fence, schedulerOwner: 'scheduler-2' },
    enrollment: {
      ...makeDetail('o').enrollment,
      schedulerOwner: 'scheduler-2',
      kind: 'objective',
      kindPayload: { maxConcurrency: 8 }
    }
  })
  current = replacement
  const row = makeRow('o', {
    ownerFence: replacement.ownerFence,
    enrollment: replacement.enrollment,
    maxConcurrency: 8
  })
  await emitSnapshot(fixture, makeSnapshot([row], 2))

  expect(latestReport(fixture).generation).toBe(generation)
  expect(latestReport(fixture).concurrencyDraft).toBe('clean')
  expect(mounted.element.querySelector<HTMLInputElement>('#max-concurrency-o')?.value).toBe('8')
  await inputValue(concurrency, '9')
  expect(latestReport(fixture).concurrencyRevision).toBe(3)
  const toastCount = fixture.toasts.length

  await rejectDeferred(held, new Error('obsolete concurrency lookup failed'))

  expect(fixture.toasts).toHaveLength(toastCount)
  expect(latestReport(fixture).concurrencyRevision).toBe(3)
  expect(concurrency.value).toBe('9')
})

test('M10: delayed edit cannot reopen after its original revision was opened and closed', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { target: { watcherId: 'a' } })
  const initial = latestReport(fixture)
  const held = fixture.holdNextSelf()
  await click(mounted.element, 'Edit budget')
  const revisionZero = controlArgs(fixture, 'edit-budget', 0)
  expect(directControl(fixture, revisionZero)).toMatchObject({ delivered: 1 })
  expect(directControl(fixture, { ...revisionZero, action: 'cancel-budget', revision: 1 })).toMatchObject({ delivered: 1 })
  const deliveries = captureControlDelivery(fixture)
  await resolveDeferred(held, { connId: 7 })

  expect(deliveries[0]).toMatchObject({
    action: 'edit-budget',
    instance: initial.instance,
    generation: initial.generation,
    revision: 0,
    delivered: 0
  })
  expect(latestReport(fixture).budgetEditor).toBe('closed')
  expect(latestReport(fixture).budgetEditorRevision).toBe(2)
  expect(mounted.element.querySelector('#active-time-limit')).toBeNull()
  expect(fixture.toasts).toHaveLength(0)
})

test('disposal revokes captured control and input handlers before queued unmount', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  const args = controlArgs(fixture, 'edit-budget')
  const callCount = fixture.calls.length
  fixture.mounted.splice(fixture.mounted.indexOf(mounted), 1)
  await act(async () => {
    mounted.cleanup()
    expect(directControl(fixture, args)).toMatchObject({ delivered: 0 })
    expect(mounted.cleanup.updateInput?.({ watcherId: 'b' })).toBe(false)
    await drainResolutionMicrotasks()
    mounted.element.remove()
  })
  expect(fixture.calls).toHaveLength(callCount)
  expect(fixture.toasts).toEqual([])
})

test('a debug report queued before disposal cannot copy or toast afterward', async () => {
  const fixture = makeFixture()
  const report = deferred<unknown>()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(DEBUG_METHOD, () => report.promise)
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  await click(mounted.element, 'Copy debug report')
  const callCount = fixture.calls.length
  fixture.mounted.splice(fixture.mounted.indexOf(mounted), 1)
  await act(async () => {
    report.resolve({ watcherId: 'a' })
    mounted.cleanup()
    mounted.element.remove()
    await drainResolutionMicrotasks()
  })
  expect(fixture.clipboardWrites).toEqual([])
  expect(fixture.toasts).toEqual([])
  expect(fixture.calls).toHaveLength(callCount)
})

test('a terminal lookup settling after disposal cannot open a view', async () => {
  const fixture = makeFixture()
  const lookup = deferred<unknown>()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { workers: [worker()] }))
  fixture.setHandler('quirky.session/get', () => lookup.promise)
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  await click(mounted.element, 'Open terminal')
  const callCount = fixture.calls.length
  await disposeMount(fixture, mounted)
  await resolveDeferred(lookup, { worktreeId: 'wt-1' })
  expect(fixture.views).toEqual([])
  expect(fixture.toasts).toEqual([])
  expect(fixture.calls).toHaveLength(callCount)
})

test('a pending delete confirmation cannot submit after disposal', async () => {
  const fixture = makeFixture()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Delete A')
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  await click(mounted.element, 'Delete watcher')
  expect(fixture.confirms).toHaveLength(1)
  const callCount = fixture.calls.length
  await disposeMount(fixture, mounted)
  await resolveConfirm(fixture, true)
  expect(fixture.callsFor(COMMAND_METHOD)).toEqual([])
  expect(fixture.calls).toHaveLength(callCount)
  expect(fixture.toasts).toEqual([])
  expect(fixture.views).toEqual([])
})

test('an already-sent delete keeps its outcome toast without reopening a disposed fleet', async () => {
  const fixture = makeFixture()
  const result = deferred<unknown>()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Delete A')
  fixture.setHandler(COMMAND_METHOD, () => result.promise)
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  await click(mounted.element, 'Delete watcher')
  await resolveConfirm(fixture, true)
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(1)
  const callCount = fixture.calls.length
  await disposeMount(fixture, mounted)
  await resolveDeferred(result, { kind: 'applied', appliedAtMs: 5 })
  expect(fixture.views).toEqual([])
  expect(fixture.calls).toHaveLength(callCount)
  expect(fixture.toasts.map((toast) => toast.title)).toEqual(['Delete watcher applied'])
})

test('a pending delete preview cannot open confirmation after disposal', async () => {
  const fixture = makeFixture()
  const preview = deferred<unknown>()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.setHandler(DESCRIBE_METHOD, () => preview.promise)
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  await click(mounted.element, 'Delete watcher')
  const callCount = fixture.calls.length
  await disposeMount(fixture, mounted)
  await resolveDeferred(preview, 'Delete A')
  expect(fixture.confirms).toEqual([])
  expect(fixture.calls).toHaveLength(callCount)
  expect(fixture.toasts).toEqual([])
})

test('a disposed control lookup cannot send its second RPC or report transport errors', async () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
    const mounted = await mountReady(fixture, { watcherId: 'a' })
    const lookup = fixture.holdNextSelf()
    await click(mounted.element, 'Edit budget')
    expect(fixture.callsFor('ui.window.self')).toHaveLength(1)
    await disposeMount(fixture, mounted)
    if (outcome === 'resolve') await resolveDeferred(lookup, { connId: 7 })
    else await rejectDeferred(lookup, new Error('window closed'))
    expect(fixture.callsFor('ui.window.command.run')).toEqual([])
    expect(fixture.toasts).toEqual([])
    expect(fixture.views).toEqual([])
  }
})

test('a disposed control delivery stays silent on refusal or transport failure', async () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
    const mounted = await mountReady(fixture, { watcherId: 'a' })
    const args = controlArgs(fixture, 'edit-budget')
    const delivery = deferred<unknown>()
    fixture.enqueue('ui.window.command.run', delivery.promise)
    await click(mounted.element, 'Edit budget')
    expect(fixture.callsFor('ui.window.command.run')).toHaveLength(1)
    const callCount = fixture.calls.length
    await disposeMount(fixture, mounted)
    if (outcome === 'resolve') await resolveDeferred(delivery, { result: { ...args, delivered: 0 } })
    else await rejectDeferred(delivery, new Error('delivery lost'))
    expect(fixture.calls).toHaveLength(callCount)
    expect(fixture.toasts).toEqual([])
    expect(fixture.views).toEqual([])
  }
})

test('an old mount completion cannot mutate or unlock its replacement in the same context', async () => {
  const fixture = makeFixture()
  const oldDelete = deferred<unknown>()
  const newPause = deferred<unknown>()
  fixture.setHandler(DETAIL_METHOD, () => visibleDetail('a'))
  fixture.setHandler(DESCRIBE_METHOD, () => 'Delete A')
  fixture.enqueue(COMMAND_METHOD, oldDelete.promise, newPause.promise)
  const previous = await mountReady(fixture, { watcherId: 'a' })
  const oldReport = latestReport(fixture)
  await click(previous.element, 'Delete watcher')
  await resolveConfirm(fixture, true)
  await disposeMount(fixture, previous)
  const replacement = await mountReady(fixture, { watcherId: 'a' })
  const replacementReport = latestReport(fixture)
  expect(replacementReport.instance).not.toBe(oldReport.instance)
  await click(replacement.element, 'Pause')
  const readCount = fixture.callsFor(DETAIL_METHOD).length
  await resolveDeferred(oldDelete, { kind: 'applied', appliedAtMs: 5 })
  expect(fixture.views).toEqual([])
  expect(latestReport(fixture).generation).toBe(replacementReport.generation)
  expect(latestReport(fixture).target).toEqual({ watcherId: 'a' })
  expect(replacement.element.textContent).toContain('Detail marker a')
  expect(replacement.element.querySelector('[role="status"]')?.textContent).not.toContain('Delete watcher')
  expect(fixture.callsFor(DETAIL_METHOD)).toHaveLength(readCount)
  expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(2)
  expect(button(replacement.element, 'Pause').disabled).toBe(true)
  expect(fixture.toasts.map((toast) => toast.title)).toEqual(['Delete watcher applied'])
  await resolveDeferred(newPause, { kind: 'applied', appliedAtMs: 6 })
  expect(button(replacement.element, 'Pause').disabled).toBe(false)
})

test('same-turn Pause and Disarm reserve one owner command until its settlement', async () => {
  const fixture = makeFixture()
  const result = deferred<unknown>()
  fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
  fixture.enqueue(COMMAND_METHOD, result.promise)
  const mounted = await mountReady(fixture, { watcherId: 'a' })
  await act(async () => {
    button(mounted.element, 'Pause').click()
    button(mounted.element, 'Disarm').click()
  })
  await settleUi()
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params.command)).toEqual([{ kind: 'pause' }])
  expect(button(mounted.element, 'Pause').disabled).toBe(true)
  expect(button(mounted.element, 'Disarm').disabled).toBe(true)
  await resolveDeferred(result, { kind: 'applied', appliedAtMs: 5 })
  expect(button(mounted.element, 'Pause').disabled).toBe(false)
  expect(button(mounted.element, 'Disarm').disabled).toBe(false)
  await click(mounted.element, 'Disarm')
  expect(fixture.callsFor(COMMAND_METHOD).map((call) => call.params.command)).toEqual([{ kind: 'pause' }, { kind: 'disarm' }])
})
