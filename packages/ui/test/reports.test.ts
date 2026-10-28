import { afterEach, expect, test } from 'bun:test'
import type { PluginInfo, UiState } from '@quirky/protocol'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

afterEach(async () => {
  await closeWindows()
  delete (globalThis as { __reports?: unknown }).__reports
})

const NOTES = 'acme.notes'
const SECTION = `sidebar-section:${NOTES}/list`
const OUTLINE = `panel:${NOTES}/outline`
const PAGE = `view:${NOTES}/page`

/**
 * Each slot reports `{slot, n: 1}` when it mounts and leaves its `report` function in
 * `globalThis.__reports` (shared with the headless window) for the test to call later.
 */
function writeNotes(installed: string): void {
  const reportOnMount = (slot: string) => `
    const reports = (globalThis.__reports ??= {})
    reports[${JSON.stringify(slot)}] = props.report
    props.report({ slot: ${JSON.stringify(slot)}, n: 1 })`
  installUiPlugin(
    installed,
    NOTES,
    {
      'sidebar-section': [{ id: 'list', title: 'Notes' }],
      panel: [{ id: 'outline', title: 'Outline' }],
      view: [{ id: 'page', title: 'Page' }]
    },
    [SECTION, OUTLINE, PAGE].map((slot) => provide(slot, reportOnMount(slot))).join('\n')
  )
}

type Reporter = (state: unknown) => void
const reporter = (slot: string): Reporter => (globalThis as unknown as { __reports: Record<string, Reporter> }).__reports[slot]!

const slotState = async (env: WindowEnv, id: string) =>
  ((await env.agent.callAny('ui.state', {})) as UiState).slots.find((slot) => slot.id === id)

async function closeTool(env: WindowEnv, id: string): Promise<void> {
  const state = (await env.agent.callAny('ui.state', {})) as UiState
  const slot = state.layout.tools?.placements[id]
  if (!slot) throw new Error(`no tool placement for ${id}`)
  await env.agent.callAny('ui.tool.close', { slot })
}

test('a mounted slot reports on mount, and ui.state shows it', async () => {
  const env = await bootWindow(writeNotes)
  await env.agent.callAny('ui.tool.open', { id: SECTION })
  await env.win.waitFor(async () => (await slotState(env, SECTION))?.report !== undefined)
  expect((await slotState(env, SECTION))?.report).toEqual({ slot: SECTION, n: 1 })
})

test('SC-42: a later report replaces the earlier one', async () => {
  const env = await bootWindow(writeNotes)
  await env.agent.callAny('ui.tool.open', { id: SECTION })
  await env.win.waitFor(() => (globalThis as { __reports?: unknown }).__reports)
  reporter(SECTION)({ n: 2 })
  reporter(SECTION)({ n: 3 })
  await env.win.waitFor(async () => JSON.stringify((await slotState(env, SECTION))?.report) === '{"n":3}')
})

test('SC-42: a report over the cap is refused, the previous one stays and the plugin is warned', async () => {
  const env = await bootWindow(writeNotes)
  await env.agent.callAny('ui.tool.open', { id: SECTION })
  await env.win.waitFor(() => (globalThis as { __reports?: unknown }).__reports)
  reporter(SECTION)({ n: 2 })
  await env.win.waitFor(async () => JSON.stringify((await slotState(env, SECTION))?.report) === '{"n":2}')

  reporter(SECTION)('x'.repeat(100 * 1024))
  const warned = await env.win.waitFor(async () => {
    const plugin = ((await env.agent.callAny('plugin.list', {})) as PluginInfo[]).find((item) => item.id === NOTES)!
    return plugin.diagnostics.some((item) => item.level === 'warning' && item.message.includes(SECTION))
  })
  expect(warned).toBe(true)
  expect((await slotState(env, SECTION))?.report).toEqual({ n: 2 })
})

test('SC-42: closing a panel clears its report', async () => {
  const env = await bootWindow(writeNotes)
  await env.agent.callAny('ui.tool.open', { id: OUTLINE })
  await env.win.waitFor(async () => (await slotState(env, OUTLINE))?.report !== undefined)
  expect((await slotState(env, OUTLINE))?.report).toEqual({ slot: OUTLINE, n: 1 })

  await closeTool(env, OUTLINE)
  await env.win.waitFor(async () => (await slotState(env, OUTLINE))?.report === undefined)
})

test('SC-42: a view that changes input reports afresh, and closing the view clears the report', async () => {
  const env = await bootWindow(writeNotes)
  await env.agent.callAny('ui.view.open', { id: PAGE, input: { a: 1 } })
  await env.win.waitFor(async () => (await slotState(env, PAGE))?.report !== undefined)

  reporter(PAGE)({ tabs: ['one'] })
  await env.win.waitFor(async () => JSON.stringify((await slotState(env, PAGE))?.report) === '{"tabs":["one"]}')
  await env.agent.callAny('ui.view.open', { id: PAGE, input: { a: 2 } })
  await env.win.waitFor(async () => JSON.stringify((await slotState(env, PAGE))?.report) === `{"slot":"${PAGE}","n":1}`)

  await env.agent.callAny('ui.view.close', {})
  await env.win.waitFor(async () => (await slotState(env, PAGE))?.report === undefined)
})

test('a report sent after its slot unmounted is dropped', async () => {
  const env = await bootWindow(writeNotes)
  await env.agent.callAny('ui.tool.open', { id: OUTLINE })
  await env.win.waitFor(async () => (await slotState(env, OUTLINE))?.report !== undefined)
  const stale = reporter(OUTLINE)
  await closeTool(env, OUTLINE)
  await env.win.waitFor(async () => (await slotState(env, OUTLINE))?.report === undefined)

  stale({ late: true })
  await Bun.sleep(100)
  expect((await slotState(env, OUTLINE))?.report).toBeUndefined()
})
