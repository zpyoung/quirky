import { expect, test } from 'bun:test'
import type { Ask, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { ASK_RESULT_FLASH_MS, type AskResolutionFlash } from '../src/presentation-types'
import { createAskStore } from '../src/store'

const ask: Ask = {
  id: 'ask_timeout',
  spec: { title: 'Deploy?', questions: [{ id: 'go', type: 'confirm', question: 'Go?' }] },
  sessionId: 'session_1',
  worktreeId: 'worktree_1',
  createdAt: 10,
  envelope: { status: 'pending', askId: 'ask_timeout', answers: {}, skipped: [], summary: '' },
  seq: 1,
  queued: false,
  partial: {},
  expiresAt: null
}

test('Q2: a timeout summary is retained for four seconds outside the pending badge', async () => {
  let now = 500
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const badges: (number | null)[] = []
  const initialized = Promise.withResolvers<void>()
  const clock = {
    now: () => now,
    setTimeout(run: () => void, delay: number) {
      const timer = ++nextTimer
      timers.set(timer, { at: now + delay, run })
      return timer
    },
    clearTimeout(timer: unknown) {
      timers.delete(timer as number)
    },
    advance(delay: number) {
      now += delay
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.run()
      }
    }
  }
  const context = {
    pluginId: 'quirky.ask',
    log() {},
    async call(method: string) {
      if (method !== 'quirky.ask/list') throw new Error(`unexpected ${method}`)
      return [ask]
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onConnection() {
      return () => {}
    },
    setPanelBadge(_id: string, count: number | null) {
      badges.push(count)
      initialized.resolve()
    }
  } as unknown as UiPluginContext
  const store = createAskStore(context, clock)
  await initialized.promise

  const envelope: Ask['envelope'] = {
    status: 'timed_out',
    askId: ask.id,
    answers: { go: { value: true, source: 'default' } },
    skipped: [],
    summary: 'Go?: Yes'
  }
  for (const listener of listeners) await listener({ type: 'quirky.ask/resolved', data: { askId: ask.id, envelope, seq: 2 } })

  const [flash] = store.flashes() as readonly AskResolutionFlash[]
  expect(flash).toMatchObject({ ask: { id: ask.id, envelope: { status: 'timed_out', summary: 'Go?: Yes' } }, dismissAt: 500 + ASK_RESULT_FLASH_MS })
  expect(store.get()).toEqual([])
  expect(badges.at(-1)).toBeNull()

  clock.advance(ASK_RESULT_FLASH_MS - 1)
  expect(store.flashes()).toHaveLength(1)
  clock.advance(1)
  expect(store.flashes()).toEqual([])
  expect(badges.at(-1)).toBeNull()
  store.dispose()
  expect(timers.size).toBe(0)
})
