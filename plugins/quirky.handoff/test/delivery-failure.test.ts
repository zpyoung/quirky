import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PluginContext, PluginNotification } from '@quirky/protocol'
import { DeliveryTracker } from '../src/daemon/delivery'

const SETTLED_ROW = { state: 'done', lastHookAt: 1 }

let saved: string | undefined
beforeEach(() => {
  saved = process.env.QUIRKY_TEST_AGENT_TIME_SCALE
  process.env.QUIRKY_TEST_AGENT_TIME_SCALE = '0.01'
})
afterEach(() => {
  if (saved === undefined) delete process.env.QUIRKY_TEST_AGENT_TIME_SCALE
  else process.env.QUIRKY_TEST_AGENT_TIME_SCALE = saved
})

/** A tracker whose agents/deliver call throws and whose child reads as settled, the case that used to earn a retry. */
function failingRig() {
  const delivers: unknown[] = []
  const notes: PluginNotification[] = []
  const emitted: unknown[] = []
  const context = {
    emit: (_name: string, data: unknown) => void emitted.push(data),
    notify: (note: PluginNotification) => void notes.push(note)
  } as unknown as PluginContext
  const tracker = new DeliveryTracker(context, async (method) => {
    if (method === 'quirky.agents/deliver') {
      delivers.push(method)
      throw new Error('agents plugin is busy')
    }
    if (method === 'quirky.agent-status/get') return SETTLED_ROW
    throw new Error(`unexpected call ${method}`)
  })
  tracker.retain('c1', { agent: 'strict-bot', text: 'the brief', lineageId: null })
  return { tracker, delivers, notes, emitted }
}

describe('a delivery call that throws is not evidence the brief was not delivered', () => {
  test('the first delivery is unobservable, is not retried, and asks the user to resend', async () => {
    const { tracker, delivers, notes } = failingRig()
    expect(await tracker.deliver('c1', Date.now())).toBe('unobservable')
    expect(delivers).toHaveLength(1)
    expect(tracker.hasBrief('c1')).toBe(true)
    expect(notes.at(-1)).toMatchObject({ persistent: true, actions: [{ label: 'Resend brief' }] })
  })

  test('a manual resend that throws stays unobservable instead of reporting a failed retry', async () => {
    const { tracker, delivers } = failingRig()
    expect(await tracker.resend('c1')).toBe('unobservable')
    expect(delivers).toHaveLength(1)
  })
})
