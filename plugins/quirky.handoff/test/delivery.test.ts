import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { CURSOR_ON, HandoffRig, PASTE_END, PASTE_ON, PASTE_START } from './support'

let rig: HandoffRig
const stoppers: (() => void)[] = []
afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop()
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

type Started = { child: { session: string; tab: string; worktreeId: string }; lineageId: string | null; delivery: string }
type Notify = Extract<QuirkyEvent, { type: 'notify' }>

const start = (params: Record<string, unknown>) => rig.call('quirky.handoff/start', params) as Promise<Started>
const resend = (session: string) => rig.call('quirky.handoff/resend', { session }) as Promise<{ delivery: string }>

async function opened() {
  rig = await HandoffRig.start()
  const s = await rig.session('w')
  rig.setHistory(['some output'])
  return s
}

const handoff = (source: string, agent: string, extra: Record<string, unknown> = {}) =>
  start({ source: { session: source }, controls: { agent }, wait: true, ...extra })

/** Shows a ready composer on a session. */
const ready = (id: string) => rig.h.pty.emit(id, PASTE_ON + CURSOR_ON)

/** Makes each agent that starts settle its status row, as an agent with hooks installed does. */
function settleOnSpawn() {
  stoppers.push(rig.onSpawn((id) => void rig.eventually(() => rig.turn(id, 'earlier work', 'done'))))
}

const toastsFor = (child: string): Notify[] => rig.notifications().filter((event) => event.key === `handoff:${child}`)
const lastToast = async (child: string, count = 1): Promise<Notify> => {
  await rig.waitFor(() => toastsFor(child).length >= count, 4000)
  return toastsFor(child).at(-1)!
}
const pastes = (id: string) => rig.h.pty.inputs.filter((input) => input.sessionId === id && input.text.startsWith(PASTE_START))

const RESEND_ACTION = (session: string) => ({ label: 'Resend brief', command: 'command:quirky.handoff/resend-confirm', args: { session }, keepOpen: true })
const DISCARD = (session: string) => ({ command: 'command:quirky.handoff/discard', args: { session } })

describe('SC-48: a confirmed delivery shows a success toast', () => {
  test('the brief is pasted once, the outcome is delivered and the toast replaces itself by key', async () => {
    const s = await opened()
    stoppers.push(rig.autoReady())
    const result = await handoff(s.id, 'strict-bot')

    expect(result.delivery).toBe('delivered')
    expect(pastes(result.child.session)).toHaveLength(1)
    const toast = await lastToast(result.child.session)
    expect(toast).toMatchObject({
      type: 'notify',
      kind: 'success',
      title: 'The handoff brief was sent.',
      key: `handoff:${result.child.session}`,
      desktop: false
    })
    expect(toast.persistent).toBeFalsy()
    expect(toast.actions).toBeUndefined()
    expect(rig.pluginEvents('delivery')).toContainEqual({ child: result.child.session, lineageId: result.lineageId, outcome: 'delivered' })

    const error = await rig.failure('quirky.handoff/resend', { session: result.child.session })
    expect(error.data).toEqual({ reason: 'no-brief' })
  })

  test('a pasted brief on a blind-paste agent that then starts a turn is delivered', async () => {
    const s = await opened()
    stoppers.push(
      rig.onSpawn((id) => {
        setTimeout(() => void rig.eventually(() => rig.startTurn(id, 'the handed off brief')), 450)
      })
    )
    const result = await handoff(s.id, 'blind-bot')
    expect(result.delivery).toBe('delivered')
    expect(pastes(result.child.session)).toHaveLength(1)
    expect((await lastToast(result.child.session)).title).toBe('The handoff brief was sent.')
  })
})

describe('SC-49: a failed delivery is retried once by itself', () => {
  test('(a) the retry lands: one toast says the brief was resent', async () => {
    const s = await opened()
    settleOnSpawn()
    stoppers.push(rig.onSpawn((id) => void rig.waitFor(() => rig.logs.some((line) => line.includes(`session ${id} (strict-bot) not-delivered`)), 4000).then(() => ready(id))))
    const result = await handoff(s.id, 'strict-bot')

    expect(result.delivery).toBe('resent')
    expect(pastes(result.child.session)).toHaveLength(1)
    const toast = await lastToast(result.child.session)
    expect(toast).toMatchObject({ kind: 'warning', title: 'The initial delivery failed, then Quirky resent the brief.' })
    expect(toast.persistent).toBeFalsy()
    expect(rig.pluginEvents('delivery')).toContainEqual({ child: result.child.session, lineageId: result.lineageId, outcome: 'resent' })
    expect((await rig.failure('quirky.handoff/resend', { session: result.child.session })).data).toEqual({ reason: 'no-brief' })
  })

  test('(b) the retry fails too: a persistent toast offers Resend brief and discards on dismiss', async () => {
    const s = await opened()
    settleOnSpawn()
    const result = await handoff(s.id, 'strict-bot')

    expect(result.delivery).toBe('retry-failed')
    expect(pastes(result.child.session)).toHaveLength(0)
    const toast = await lastToast(result.child.session)
    expect(toast).toMatchObject({
      kind: 'error',
      title: 'Brief delivery and the automatic retry failed.',
      persistent: true,
      actions: [RESEND_ACTION(result.child.session)],
      onDismiss: DISCARD(result.child.session)
    })
  })

  test('a manual resend after the failure delivers and replaces the persistent toast by key', async () => {
    const s = await opened()
    settleOnSpawn()
    const result = await handoff(s.id, 'strict-bot')
    expect(result.delivery).toBe('retry-failed')
    ready(result.child.session)

    expect(await resend(result.child.session)).toEqual({ delivery: 'delivered' })

    const toasts = toastsFor(result.child.session)
    await rig.waitFor(() => toastsFor(result.child.session).length === 2, 3000)
    expect(toastsFor(result.child.session).at(-1)).toMatchObject({ kind: 'success', title: 'The handoff brief was sent.' })
    expect(toasts[0]!.onDismiss).toBeDefined()
    expect(toastsFor(result.child.session).at(-1)!.onDismiss).toBeUndefined()
    expect(pastes(result.child.session)).toHaveLength(1)
    expect((await rig.failure('quirky.handoff/resend', { session: result.child.session })).data).toEqual({ reason: 'no-brief' })
  })
})

describe('SC-50: an unconfirmed delivery asks before resending', () => {
  test('the toast is persistent with the evidence note; Send again delivers and replaces it', async () => {
    const s = await opened()
    const result = await handoff(s.id, 'blind-bot')

    expect(result.delivery).toBe('unobservable')
    expect(pastes(result.child.session)).toHaveLength(1)
    const toast = await lastToast(result.child.session)
    expect(toast).toMatchObject({
      kind: 'warning',
      title: 'Brief delivery could not be confirmed.',
      detail: 'Resend is manual because the target Agent does not expose delivery evidence.',
      persistent: true,
      actions: [RESEND_ACTION(result.child.session)],
      onDismiss: DISCARD(result.child.session)
    })

    ready(result.child.session)
    expect(await resend(result.child.session)).toEqual({ delivery: 'delivered' })
    await rig.waitFor(() => toastsFor(result.child.session).length === 2, 3000)
    expect(toastsFor(result.child.session).at(-1)).toMatchObject({ kind: 'success', title: 'The handoff brief was sent.' })
    expect(pastes(result.child.session)).toHaveLength(2)
  })

  test('a resend that still cannot be confirmed keeps the brief and the persistent toast', async () => {
    const s = await opened()
    const result = await handoff(s.id, 'blind-bot')
    expect(await resend(result.child.session)).toEqual({ delivery: 'unobservable' })
    expect((await lastToast(result.child.session, 2)).persistent).toBe(true)
    expect(await resend(result.child.session)).toEqual({ delivery: 'unobservable' })
  })

  test('concurrent resends share one delivery', async () => {
    const s = await opened()
    const result = await handoff(s.id, 'blind-bot')
    const before = pastes(result.child.session).length
    ready(result.child.session)
    const outcomes = await Promise.all([resend(result.child.session), resend(result.child.session), resend(result.child.session)])
    expect(outcomes).toEqual([{ delivery: 'delivered' }, { delivery: 'delivered' }, { delivery: 'delivered' }])
    expect(pastes(result.child.session)).toHaveLength(before + 1)
  })
})

describe('SC-51: a retained brief goes away with its toast or its session', () => {
  test('(a) discarding drops the brief', async () => {
    const s = await opened()
    const result = await handoff(s.id, 'blind-bot')
    expect(await rig.call('quirky.handoff/discard', { session: result.child.session })).toEqual({ discarded: true })
    expect(await rig.call('quirky.handoff/discard', { session: result.child.session })).toEqual({ discarded: false })
    const error = await rig.failure('quirky.handoff/resend', { session: result.child.session })
    expect(error.data).toEqual({ reason: 'no-brief' })
    expect(error.code).toBe(RpcErrorCode.NotFound)
  })

  test('(b) closing the child drops the brief', async () => {
    const s = await opened()
    const result = await handoff(s.id, 'blind-bot')
    await rig.call('quirky.session/close', { session: result.child.session })
    await rig.settle()
    const error = await rig.failure('quirky.handoff/resend', { session: result.child.session })
    expect(error.data).toEqual({ reason: 'no-brief' })
  })

  test('a resend that finds the session gone is a failure, not a hang', async () => {
    const s = await opened()
    const result = await handoff(s.id, 'blind-bot')
    rig.h.pty.exit(result.child.session, 0)
    await rig.settle(150)
    expect(['retry-failed', 'unobservable']).toContain((await resend(result.child.session)).delivery)
  })
})

describe('H2: delivery outcome rules', () => {
  test('a paste that landed unconfirmed is not retried even when the row is settled', async () => {
    const s = await opened()
    settleOnSpawn()
    const result = await handoff(s.id, 'blind-bot')
    expect(result.delivery).toBe('unobservable')
    expect(pastes(result.child.session)).toHaveLength(1)
  })

  test('a working row after the launch proves delivery even when the paste was only unconfirmed', async () => {
    const s = await opened()
    stoppers.push(
      rig.onSpawn((id) => {
        void rig.eventually(() => rig.turn(id, 'earlier work', 'done'))
        setTimeout(() => void rig.eventually(() => rig.startTurn(id, 'brief')), 450)
      })
    )
    const result = await handoff(s.id, 'blind-bot')
    expect(result.delivery).toBe('delivered')
  })

  test('the delivery event carries a null lineage id when no record was written', async () => {
    const s = await opened()
    rig.refuseLineageWrites()
    stoppers.push(rig.autoReady())
    const result = await handoff(s.id, 'strict-bot')
    expect(result.lineageId).toBeNull()
    expect(rig.pluginEvents('delivery')).toContainEqual({ child: result.child.session, lineageId: null, outcome: 'delivered' })
  })

  test('the pasted text is the brief, a blank line, then the locked notice', async () => {
    const s = await opened()
    stoppers.push(rig.autoReady())
    const result = await start({ source: { session: s.id }, controls: { agent: 'strict-bot', note: 'n' }, wait: true })
    const [paste] = pastes(result.child.session)
    expect(paste!.text.startsWith(PASTE_START)).toBe(true)
    expect(paste!.text.endsWith(PASTE_END)).toBe(true)
    expect(paste!.text).toContain('\r\r## Locked Quirky handoff notice\r')
  })
})
