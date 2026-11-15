import { describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { CommandResult } from '../src/control-contracts'
import {
  COMMAND_METHOD,
  DETAIL_METHOD,
  FLEET_METHOD,
  click,
  deferred,
  flush,
  inputValue,
  makeFixture,
  makeDetail,
  makeRow,
  makeSnapshot,
  settleUi
} from './ui-fixture'

function alert(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[role="alert"]')
}
function alertMessage(root: ParentNode): string | undefined {
  return root.querySelector('.ui-inline-error__message')?.textContent ?? undefined
}

function retryButton(root: ParentNode, label: string): HTMLButtonElement {
  const error = alert(root)
  if (!error) throw new Error('Expected an InlineError')
  const button = [...error.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)
  if (!button) throw new Error(`Retry button not found: ${label}`)
  return button
}


const activeSnapshot = () => makeSnapshot([makeRow('a', { status: { state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }, runningWorkers: 1 })])

describe('Heimdall navigation shared states', () => {
  test('N1: pending fleet read shows shared loading without unconfirmed counts', async () => {
    const fixture = makeFixture()
    const pending = deferred<unknown>()
    fixture.setHandler(FLEET_METHOD, () => pending.promise)
    const mounted = await fixture.mountNavigation()
    await settleUi()

    expect(mounted.element.querySelector('.ui-notice-line')?.textContent).toBe('Loading fleet…')
    expect(mounted.element.textContent).not.toContain('Needs you')
    expect(alert(mounted.element)).toBeNull()
    expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()

    pending.resolve(makeSnapshot())
    await flush()
  })

  test('N2: failed initial fleet read is an actionable shared error without counts', async () => {
    const fixture = makeFixture()
    fixture.setHandler(FLEET_METHOD, () => { throw new Error('daemon offline') })
    const mounted = await fixture.mountNavigation()
    await settleUi()

    expect(alertMessage(mounted.element)).toBe('Could not load the Heimdall fleet: daemon offline')
    expect(retryButton(mounted.element, 'Retry')).not.toBeNull()
    expect(mounted.element.textContent).not.toContain('Needs you')
    expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()
  })

  test('N3: malformed fleet reply is reported as an invalid snapshot', async () => {
    const fixture = makeFixture()
    fixture.enqueue(FLEET_METHOD, {})
    const mounted = await fixture.mountNavigation()
    await settleUi()

    expect(alertMessage(mounted.element)).toBe('Could not load the Heimdall fleet: The fleet response was not a valid snapshot.')
  })

  test('N4: retry replaces the navigation error with confirmed fleet counts', async () => {
    const fixture = makeFixture()
    let reads = 0
    fixture.setHandler(FLEET_METHOD, () => {
      reads += 1
      if (reads === 1) throw new Error('daemon offline')
      return activeSnapshot()
    })
    const mounted = await fixture.mountNavigation()
    await settleUi()
    await act(async () => { retryButton(mounted.element, 'Retry').click() })
    await settleUi()

    expect(fixture.callsFor(FLEET_METHOD)).toHaveLength(2)
    expect(alert(mounted.element)).toBeNull()
    expect(mounted.element.querySelector('button')?.textContent).toContain('Needs you 0 · Lost contact 0 · Active 1')
  })

  test('N5: a confirmed empty fleet uses EmptyState and no counts', async () => {
    const fixture = makeFixture()
    const mounted = await fixture.mountNavigation()
    await settleUi()

    expect(mounted.element.querySelector('.ui-empty-state')?.textContent).toBe('No watchers yet.')
    expect(mounted.element.textContent).not.toContain('Needs you')
  })

  test('N6: refresh failure retains counts from the last confirmed fleet', async () => {
    const fixture = makeFixture()
    let reads = 0
    fixture.setHandler(FLEET_METHOD, () => {
      reads += 1
      if (reads === 1) return activeSnapshot()
      throw new Error('socket closed')
    })
    const mounted = await fixture.mountNavigation()
    await settleUi()
    await act(async () => { fixture.reconnect() })
    await settleUi()

    expect(mounted.element.querySelector('button')?.textContent).toContain('Needs you 0 · Lost contact 0 · Active 1')
    expect(alertMessage(mounted.element)).toBe('Could not refresh the Heimdall fleet; showing the last confirmed counts: socket closed')
  })

  test('N7: an older rejected read cannot replace a newer navigation snapshot', async () => {
    const fixture = makeFixture()
    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    let reads = 0
    fixture.setHandler(FLEET_METHOD, () => ++reads === 1 ? older.promise : newer.promise)
    const mounted = await fixture.mountNavigation()
    await act(async () => { fixture.reconnect() })
    newer.resolve(activeSnapshot())
    await settleUi()
    older.reject(new Error('stale failure'))
    await settleUi()

    expect(alert(mounted.element)).toBeNull()
    expect(mounted.element.querySelector('button')?.textContent).toContain('Active 1')
  })
})

describe('Heimdall fleet and detail shared states', () => {
  test('V1: a pending fleet read uses NoticeLine', async () => {
    const fixture = makeFixture()
    const pending = deferred<unknown>()
    fixture.setHandler(FLEET_METHOD, () => pending.promise)
    const mounted = await fixture.mountFleet()
    await settleUi()

    expect(mounted.element.querySelector('.ui-notice-line')?.textContent).toBe('Loading Heimdall fleet…')
    expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()
    pending.resolve(makeSnapshot())
    await flush()
  })

  test('V2: initial fleet failure has a Retry action and no empty state', async () => {
    const fixture = makeFixture()
    fixture.setHandler(FLEET_METHOD, () => { throw new Error('fleet offline') })
    const mounted = await fixture.mountFleet()
    await settleUi()

    expect(alertMessage(mounted.element)).toBe('Could not load the Heimdall fleet: fleet offline')
    expect(retryButton(mounted.element, 'Retry')).not.toBeNull()
    expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()
  })

  test('V3: failed refresh retains confirmed empty snapshot and Retry reloads it', async () => {
    const fixture = makeFixture()
    let reads = 0
    fixture.setHandler(FLEET_METHOD, () => {
      reads += 1
      if (reads === 1) return makeSnapshot()
      if (reads === 2) throw new Error('fleet offline')
      return makeSnapshot([], 2)
    })
    const mounted = await fixture.mountFleet()
    await settleUi()
    await click(mounted.element, 'Refresh fleet')

    expect(alertMessage(mounted.element)).toBe('Fleet refresh failed; showing the last confirmed snapshot: fleet offline')
    expect(mounted.element.querySelector('.ui-empty-state')?.textContent).toBe('No watchers in the fleet.')
    await act(async () => { retryButton(mounted.element, 'Retry').click() })
    await settleUi()
    expect(fixture.callsFor(FLEET_METHOD)).toHaveLength(3)
    expect(alert(mounted.element)).toBeNull()
  })

  test('V4: pending detail and fleet reads never claim empty history', async () => {
    const fixture = makeFixture()
    const fleet = deferred<unknown>()
    const detail = deferred<unknown>()
    fixture.setHandler(FLEET_METHOD, () => fleet.promise)
    fixture.setHandler(DETAIL_METHOD, () => detail.promise)
    const mounted = await fixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()

    expect(mounted.element.querySelectorAll('.ui-notice-line').length).toBeGreaterThan(0)
    expect(mounted.element.textContent).toContain('Loading watcher details…')
    expect(mounted.element.textContent).not.toContain('No persisted watcher action attempts yet.')
    expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()
    fleet.resolve(makeSnapshot())
    detail.resolve(makeDetail('a'))
    await flush()
  })

  test('V5: a missing watcher is a confirmed EmptyState with Back', async () => {
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => null)
    const mounted = await fixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()

    expect(mounted.element.querySelector('.ui-empty-state')?.textContent).toBe('This watcher is no longer available in the fleet.')
    expect(alert(mounted.element)).toBeNull()
    expect(mounted.element.textContent).toContain('Back to fleet')
  })

  test('V6: first detail failure has a Retry details action with the exact target', async () => {
    const fixture = makeFixture()
    let reads = 0
    fixture.setHandler(DETAIL_METHOD, ({ target }) => {
      reads += 1
      if (reads === 1) throw new Error('detail unavailable')
      expect(target).toEqual({ watcherId: 'a' })
      return makeDetail('a')
    })
    const mounted = await fixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()

    expect(alertMessage(mounted.element)).toBe('Could not load watcher details: detail unavailable')
    await act(async () => { retryButton(mounted.element, 'Retry details').click() })
    await settleUi()
    expect(fixture.callsFor(DETAIL_METHOD)).toHaveLength(2)
    expect(alert(mounted.element)).toBeNull()
    expect(mounted.element.textContent).toContain('Delete watcher')
  })

  test('V7: a detail refresh error keeps the last confirmed controls and budget panel', async () => {
    const fixture = makeFixture()
    let detailReads = 0
    fixture.setHandler(DETAIL_METHOD, () => {
      detailReads += 1
      if (detailReads === 1) return makeDetail('a')
      throw new Error('owner offline')
    })
    const mounted = await fixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()
    await act(async () => { fixture.emitSnapshot(makeSnapshot([makeRow('a')], 2)) })
    await settleUi()

    expect(mounted.element.textContent).toContain('Delete watcher')
    expect(mounted.element.textContent).toContain('Active time')
    expect(mounted.element.textContent).toContain('Worker turns')
    expect(alertMessage(mounted.element)).toBe('Could not refresh watcher details; showing the last confirmed state: owner offline')
  })

  test('V8: objective concurrency rejects out-of-range values inside its form', async () => {
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => makeDetail('o', { enrollment: { ...makeDetail('o').enrollment, kind: 'objective', kindPayload: { maxConcurrency: 4 } } }))
    const mounted = await fixture.mountFleet({ target: { watcherId: 'o' } })
    await settleUi()

    const field = mounted.element.querySelector<HTMLInputElement>('#max-concurrency-o')!
    for (const invalid of ['0', '1025']) {
      await inputValue(field, invalid)
      const form = field.closest('form')!
      await act(async () => { form.requestSubmit() })
      await settleUi()
      expect(form.querySelector('.ui-inline-error')?.textContent).toBe('Objective concurrency must be an integer from 1 through 1,024.')
    }
    expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  })

  test('V8: budget validation errors remain inside the budget form', async () => {
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
    const mounted = await fixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()
    await click(mounted.element, 'Edit budget')
    const active = mounted.element.querySelector<HTMLInputElement>('#active-time-limit')!
    const turns = mounted.element.querySelector<HTMLInputElement>('#worker-turn-limit')!
    const form = active.closest('form')!

    await inputValue(active, '-1')
    await act(async () => { form.requestSubmit() })
    await settleUi()
    expect(form.querySelector('.ui-inline-error')?.textContent).toBe('Active-time limit must be a finite non-negative number of minutes, or blank for unlimited.')
    await inputValue(active, '1.5')
    await inputValue(turns, '1.5')
    await act(async () => { form.requestSubmit() })
    await settleUi()
    expect(form.querySelector('.ui-inline-error')?.textContent).toBe('Worker-turn limit must be a non-negative integer, or blank for unlimited.')
    expect(fixture.callsFor(COMMAND_METHOD)).toHaveLength(0)
  })

  test('V9: malformed enrollment controls use InlineError without hiding its detail row', async () => {
    const detail = makeDetail('a', { enrollment: { ...makeDetail('a').enrollment, malformed: 'bad payload' } })
    const fixture = makeFixture()
    fixture.setHandler(DETAIL_METHOD, () => detail)
    const mounted = await fixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()

    expect(alert(mounted.element)?.textContent).toBe('Controls are unavailable for this malformed enrollment.')
    expect(mounted.element.textContent).toContain('Malformed enrollment')
    expect(mounted.element.textContent).toContain('bad payload')
  })

  test('V10: read-only and unverifiable notices stay advisory; refused results stay status', async () => {
    const readOnlyFixture = makeFixture()
    readOnlyFixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { readOnly: true }))
    const readOnly = await readOnlyFixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()
    expect(readOnly.element.textContent).toContain('This enrollment is read-only. Controls are unavailable.')
    expect(alert(readOnly.element)).toBeNull()
    expect([...readOnly.element.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Edit budget')?.disabled).toBe(true)

    const unverifiableFixture = makeFixture()
    unverifiableFixture.setHandler(DETAIL_METHOD, () => makeDetail('a', { ownerContact: 'unverifiable' }))
    const unverifiable = await unverifiableFixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()
    expect(unverifiable.element.textContent).toContain('Owner contact is unverifiable; this is the last confirmed state.')
    expect(alert(unverifiable.element)).toBeNull()
    expect([...unverifiable.element.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Edit budget')?.disabled).toBe(true)

    const refusedFixture = makeFixture()
    refusedFixture.setHandler(DETAIL_METHOD, () => makeDetail('a'))
    refusedFixture.setHandler(COMMAND_METHOD, () => ({ kind: 'refused', reason: 'stale-revision', detail: 'revision moved' } satisfies CommandResult))
    const refused = await refusedFixture.mountFleet({ target: { watcherId: 'a' } })
    await settleUi()
    await click(refused.element, 'Pause')
    expect(refused.element.querySelector('[role="status"]')?.textContent).toContain('Refused · stale-revision: revision moved')
    expect(alert(refused.element)).toBeNull()
  })

  test('V11: refreshing label disables the button while retaining the snapshot', async () => {
    const fixture = makeFixture()
    const pending = deferred<unknown>()
    let reads = 0
    fixture.setHandler(FLEET_METHOD, () => ++reads === 1 ? makeSnapshot() : pending.promise)
    const mounted = await fixture.mountFleet()
    await settleUi()
    const refresh = mounted.element.querySelector<HTMLButtonElement>('button')!
    await act(async () => { refresh.click() })
    await settleUi()

    const button = [...mounted.element.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Refreshing…')!
    expect(button.disabled).toBe(true)
    expect(mounted.element.querySelector('.ui-empty-state')?.textContent).toBe('No watchers in the fleet.')
    pending.resolve(makeSnapshot([], 2))
    await flush()
  })
})
