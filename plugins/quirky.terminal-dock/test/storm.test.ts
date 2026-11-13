import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { DockState } from '../src/types'
import { enableDock, launchFakeClaude, launchShell, paneOf, postClaudeHook, reconcileCount, startDockE2E, type DockHarness } from './support'
import { waitFor } from '../../quirky.terminal/test/e2e-support'

let harness: DockHarness
let agent: string
let shell: string
let pane: string
const triggerTypes: Record<string, true> = {
  'quirky.session/changed': true,
  'quirky.session/removed': true,
  'quirky.agent-status/changed': true,
  'quirky.terminal/layout': true,
  'quirky.terminal/floating': true
}
const hook = { hook_event_name: 'PreToolUse', session_id: 'storm-provider', tool_name: 'Read', tool_input: { file_path: '/tmp/example' } }

function dockEvents() {
  return harness.events.flatMap((event) => event.type === 'quirky.terminal-dock/changed' && 'data' in event
    ? [event.data as { pane: string; state: DockState }] : [])
}

async function quiet(): Promise<void> {
  let lastCount = -1
  let lastEvents = -1
  let changedAt = Date.now()
  // the daemon and PTY run in separate processes, so their settling uses the platform clock
  await waitFor('600 ms without a dock event, trigger, or reconcile pass', () => {
    const count = reconcileCount(harness)
    const events = harness.events.filter((event) => triggerTypes[event.type] || event.type === 'quirky.terminal-dock/changed').length
    if (count !== lastCount || events !== lastEvents) {
      lastCount = count
      lastEvents = events
      changedAt = Date.now()
    }
    return Date.now() - changedAt >= 600 ? true : undefined
  }, 20_000)
}

beforeAll(async () => {
  harness = await startDockE2E({ countReconciles: true })
  agent = (await launchFakeClaude(harness)).id
  shell = (await launchShell(harness)).id
  await launchShell(harness)
  pane = await paneOf(harness, agent)
  await enableDock(harness)
  await harness.connect()
  await postClaudeHook(harness, agent, { hook_event_name: 'UserPromptSubmit', session_id: 'storm-provider', prompt: 'hello' })
  await quiet()
}, 90_000)
afterAll(async () => { await harness?.cleanup() })

test('a repeated unchanged hook has triggers but no dock publication', async () => {
  await postClaudeHook(harness, agent, hook)
  await quiet()
  const start = harness.events.length
  await postClaudeHook(harness, agent, hook)
  await quiet()
  const events = harness.events.slice(start)
  const triggers = events.filter((event) => triggerTypes[event.type]).length
  const changed = events.filter((event) => event.type === 'quirky.terminal-dock/changed').length
  console.log(`unchanged hook: ${triggers} triggers, ${changed} dock events`)
  expect(triggers).toBeGreaterThan(0)
  expect(changed).toBe(0)
}, 30_000)

test('twenty concurrent hooks take at most ten reconcile passes', async () => {
  const before = reconcileCount(harness)
  await Promise.all(Array.from({ length: 20 }, () => postClaudeHook(harness, agent, hook)))
  await quiet()
  const passes = reconcileCount(harness) - before
  console.log(`20 hooks: ${passes} reconcile passes`)
  expect(passes).toBeGreaterThan(0)
  expect(passes).toBeLessThanOrEqual(10)
}, 30_000)

test('forty title changes take at most ten reconcile passes', async () => {
  const before = reconcileCount(harness)
  await harness.run(shell, `for i in {1..40}; do printf '\\033]0;storm-%s\\007' "$i"; done`)
  await quiet()
  const passes = reconcileCount(harness) - before
  console.log(`40 titles: ${passes} reconcile passes`)
  expect(passes).toBeGreaterThan(0)
  expect(passes).toBeLessThanOrEqual(10)
}, 30_000)

test('a real edit is announced and consecutive pane publications never repeat', async () => {
  const previous = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
  const written = await harness.call<DockState>('quirky.terminal-dock/set', { pane, revision: previous.revision, draft: 'hello' })
  await quiet()
  expect(dockEvents().filter((event) => event.pane === pane).at(-1)?.state).toMatchObject({ draft: 'hello', revision: written.revision })
  const last = new Map<string, string>()
  for (const event of dockEvents()) {
    const serialized = JSON.stringify(event.state)
    expect(serialized).not.toBe(last.get(event.pane))
    last.set(event.pane, serialized)
  }
}, 30_000)
