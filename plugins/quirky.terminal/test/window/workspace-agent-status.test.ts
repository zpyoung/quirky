import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { AgentDisplayState, AgentStatusSummary, Session } from '@quirky/protocol'
import { fakeDaemon, loadWorkspace, mountFixture, session, settle, simpleWorkspace, sleep, startRecording, stopRecording, unloadWorkspace, type MountedWorkspace } from './workspace-support'

const MIN = 60_000

let mounted: MountedWorkspace | null = null

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

const summary = (display: AgentDisplayState, label: string, over: Partial<AgentStatusSummary> = {}): AgentStatusSummary => ({
  state: display === 'done' || display === 'failed' || display === 'interrupted' ? 'done' : 'working',
  display,
  label,
  detail: '',
  progress: null,
  stateStartedAt: Date.now(),
  evidenceAt: Date.now(),
  restoredUnconfirmed: false,
  ...over
})

async function open(agentStatus?: AgentStatusSummary | null, status: Session['status'] = 'working') {
  mounted = await mountFixture(fakeDaemon(simpleWorkspace(), { sessions: [session('s-1', { status, ...(agentStatus === undefined ? {} : { agentStatus }) })] }))
  return mounted
}

const glyph = (view: MountedWorkspace) => view.q('.qt-tab .glyph')
const report = (view: MountedWorkspace) => view.last().tabs[0]

const states: [AgentDisplayState, string][] = [
  ['working', 'Working'],
  ['monitoring', 'Monitoring background tasks'],
  ['waiting', 'Waiting for input'],
  ['permission', 'Needs attention'],
  ['blocked', 'Blocked'],
  ['failed', 'Failed'],
  ['interrupted', 'Interrupted'],
  ['done', 'Done'],
  ['unverifiable', 'No recent update'],
  ['idle', 'Idle'],
  ['unconfirmed', "Couldn't confirm"]
]

describe('the tab strip draws the agent-status glyph', () => {
  for (const [display, label] of states) {
    test(`${display} draws glyph-${display} labelled "${label}" and reports it`, async () => {
      const view = await open(summary(display, label))
      const element = glyph(view)!
      expect(element.className).toBe(`glyph glyph-${display}`)
      expect(element.getAttribute('title')).toBe(label)
      expect(element.getAttribute('aria-label')).toBe(label)
      expect(view.q('.qt-tab .qt-dot')).toBeNull()
      expect(report(view)).toMatchObject({ status: 'working', display, label })
    })
  }

  test('a session without a summary keeps the coarse dot and reports no display', async () => {
    const view = await open(undefined, 'running')
    expect(glyph(view)).toBeNull()
    expect(view.q('.qt-tab .qt-dot-running')).not.toBeNull()
    expect(report(view)).not.toHaveProperty('display')
    expect(report(view)).not.toHaveProperty('label')
  })

  test('a null summary also keeps the coarse dot', async () => {
    const view = await open(null)
    expect(glyph(view)).toBeNull()
    expect(view.q('.qt-tab .qt-dot-working')).not.toBeNull()
  })

  test('progress turns a live state into a ring and leaves the others alone', async () => {
    const working = await open(summary('working', 'Working', { progress: 60 }))
    expect(glyph(working)!.className).toBe('glyph glyph-working glyph-ring')
    expect((glyph(working) as HTMLElement).style.getPropertyValue('--progress')).toBe('60%')
    expect(glyph(working)!.getAttribute('aria-label')).toBe('Working')
    await working.unmount()

    const waiting = await open(summary('waiting', 'Waiting for input', { progress: 25.4 }))
    expect(glyph(waiting)!.className).toBe('glyph glyph-waiting glyph-ring')
    expect((glyph(waiting) as HTMLElement).style.getPropertyValue('--progress')).toBe('25%')
    await waiting.unmount()

    const monitoring = await open(summary('monitoring', 'Monitoring background tasks', { progress: 50 }))
    expect(glyph(monitoring)!.className).toBe('glyph glyph-monitoring')
    await monitoring.unmount()

    const done = await open(summary('done', 'Done', { progress: 100 }))
    expect(glyph(done)!.className).toBe('glyph glyph-done')
  })

  test('an unfinished state with no evidence for 30 minutes decays; a done one does not', async () => {
    const stale = Date.now() - 31 * MIN
    const working = await open(summary('working', 'Working', { evidenceAt: stale, progress: 40 }))
    expect(glyph(working)!.className).toBe('glyph glyph-unverifiable')
    expect(glyph(working)!.getAttribute('title')).toBe('No recent update')
    expect(report(working)).toMatchObject({ display: 'unverifiable', label: 'No recent update' })
    await working.unmount()

    const exited = await open(summary('working', 'Working', { evidenceAt: stale }), 'exited')
    expect(glyph(exited)!.className).toBe('glyph glyph-idle')
    expect(glyph(exited)!.getAttribute('aria-label')).toBe('Idle')
    await exited.unmount()

    const done = await open(summary('done', 'Done', { evidenceAt: stale }))
    expect(glyph(done)!.className).toBe('glyph glyph-done')
  })

  test('a restored-unconfirmed summary keeps its glyph past 30 minutes', async () => {
    const view = await open(summary('unconfirmed', "Couldn't confirm", { evidenceAt: Date.now() - 45 * MIN, restoredUnconfirmed: true }))
    expect(glyph(view)!.className).toBe('glyph glyph-unconfirmed')
  })

  test('the glyph follows session events', async () => {
    const first = session('s-1', { status: 'working', agentStatus: summary('working', 'Working') })
    const view = await open(first.agentStatus)
    expect(glyph(view)!.className).toContain('glyph-working')
    const next = { ...first, agentStatus: summary('waiting', 'Waiting for input') }
    view.daemon.sessions[0] = next
    await view.fake.emit({ type: 'quirky.session/changed', data: { session: next } })
    await settle()
    expect(glyph(view)!.className).toContain('glyph-waiting')
    expect(report(view)).toMatchObject({ display: 'waiting', label: 'Waiting for input' })
  })

  test('a one-minute tick shows decay with no event', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'setInterval')!
    const realSetInterval = globalThis.setInterval
    const ticks: (() => void)[] = []
    Object.defineProperty(globalThis, 'setInterval', {
      ...original,
      value: ((callback: () => void, ms?: number) => {
        if (ms === MIN) {
          ticks.push(callback)
          // a real handle, so the unmount's clearInterval cannot clear some other timer
          return realSetInterval(() => {}, 2_000_000_000)
        }
        return realSetInterval(callback, ms)
      }) as typeof setInterval
    })
    try {
      // 400 ms short of stale at mount; the clock is real, so the wait carries it over
      const view = await open(summary('working', 'Working', { evidenceAt: Date.now() - 30 * MIN + 400 }))
      expect(glyph(view)!.className).toBe('glyph glyph-working')
      await sleep(450)
      await act(async () => ticks.forEach((tick) => tick()))
      expect(glyph(view)!.className).toBe('glyph glyph-unverifiable')
    } finally {
      Object.defineProperty(globalThis, 'setInterval', original)
    }
  })
})
