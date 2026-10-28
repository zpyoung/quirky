import { afterEach, expect, test } from 'bun:test'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

afterEach(closeWindows)

const BASE = 'acme.sidebar-base'
const OVERRIDE = 'acme.sidebar-override'
const ACTIVITY_ITEM = `activity-item:${BASE}/source-control`
const activitySlot = `[data-plugin-slot="${ACTIVITY_ITEM}"]`
const activityToolPanel = `[data-tool-panel="${ACTIVITY_ITEM}"]`

type ActivitySlotState = {
  id: string
  kind: string
  plugin: string
  title: string
  shown: boolean
  report?: unknown
}

type WindowUiState = {
  layout: { tools: { open: Record<string, string | null> } }
  slots: ActivitySlotState[]
}

async function readUiState(env: WindowEnv): Promise<WindowUiState> {
  return (await env.agent.callAny('ui.state', {})) as WindowUiState
}

function reportOwner(slot: ActivitySlotState | undefined): string | undefined {
  const report = slot?.report
  if (typeof report !== 'object' || report === null || !('owner' in report)) return undefined
  return typeof report.owner === 'string' ? report.owner : undefined
}

test('activity tool contributions swap owners and unmount when disabled', async () => {
  const env = await bootWindow((installed) => {
    installUiPlugin(
      installed,
      BASE,
      { 'activity-item': [{ id: 'source-control', title: 'Source Control', order: 10 }] },
      provide(ACTIVITY_ITEM, "element.textContent = 'Source Control'; props.report({ owner: 'base', count: 0, available: true })")
    )
    installUiPlugin(
      installed,
      OVERRIDE,
      {},
      provide(ACTIVITY_ITEM, "element.textContent = 'Team Source Control'; props.report({ owner: 'override', count: 2, available: true })"),
      { overrides: [{ id: ACTIVITY_ITEM, title: 'Team Source Control', order: 5 }] }
    )
  })
  const { win, agent } = env

  expect(await agent.callAny('ui.contributions', {})).toMatchObject({
    activityItems: [{ id: ACTIVITY_ITEM, plugin: OVERRIDE, title: 'Team Source Control' }]
  })

  await agent.callAny('ui.tool.open', { id: ACTIVITY_ITEM })
  await win.waitFor(() => win.document.querySelector(`${activityToolPanel} ${activitySlot}`))
  await win.waitFor(async () => (await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)?.report !== undefined)
  await win.waitFor(async () => Object.values((await readUiState(env)).layout.tools.open).includes(ACTIVITY_ITEM))
  expect(win.document.querySelector(`${activityToolPanel} ${activitySlot}`)).not.toBeNull()
  expect((await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)).toMatchObject({
    kind: 'activity-item',
    plugin: OVERRIDE,
    title: 'Team Source Control',
    shown: true,
    report: { owner: 'override', count: 2, available: true }
  })

  await agent.callAny('plugin.disable', { id: OVERRIDE })
  await win.waitFor(() => win.document.querySelector(`${activityToolPanel} ${activitySlot}`)?.textContent?.trim() === 'Source Control')
  await win.waitFor(async () => reportOwner((await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)) === 'base')
  expect((await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)).toMatchObject({
    plugin: BASE,
    title: 'Source Control',
    report: { owner: 'base', count: 0, available: true }
  })

  await agent.callAny('plugin.disable', { id: BASE })
  await win.waitFor(() => win.document.querySelector(activitySlot) === null)
  const uiState = await win.waitFor(async () => {
    const state = await readUiState(env)
    return state.slots.some((slot) => slot.id === ACTIVITY_ITEM) ? undefined : state
  })
  expect(Object.values(uiState.layout.tools.open)).not.toContain(ACTIVITY_ITEM)
})

test('the Settings window renders generic category and section metadata and saves the declared setting', async () => {
  const settingId = 'setting:acme.preferences/sidebarSectionSeparators'
  const dividerTitle = 'Show divider lines between top-level projects and groups'
  const env = await bootWindow((installed) => {
    installUiPlugin(
      installed,
      'acme.preferences',
      {
        setting: [
          {
            id: 'sidebarSectionSeparators',
            type: 'boolean',
            title: dividerTitle,
            default: true,
            category: 'Appearance',
            section: 'Window & Sidebar'
          }
        ]
      },
      ''
    )
    installUiPlugin(
      installed,
      'acme.editor',
      { setting: [{ id: 'fontSize', type: 'number', title: 'Font size', default: 13 }] },
      ''
    )
  })
  const { win, agent } = env

  await win.click('button[aria-label="Settings"]')
  await win.waitFor(() => win.document.querySelector('[role="dialog"]')?.textContent?.includes(dividerTitle))
  const dialog = win.document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Appearance')
  expect(dialog.textContent).toContain('Window & Sidebar')
  expect(dialog.textContent).toContain(dividerTitle)
  expect(dialog.textContent).toContain('Font size')
  expect(Array.from(dialog.querySelectorAll('fieldset > legend')).map((legend) => legend.textContent?.trim())).toContain('acme.editor')

  const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement
  expect(checkbox.checked).toBe(true)
  await win.click('[role="dialog"] input[type="checkbox"]')
  await win.waitFor(() => !(win.document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement | null)?.checked)
  await win.click('[role="dialog"] button[type="submit"]')
  await win.waitFor(() => win.document.querySelector('[role="dialog"]') === null)
  expect(await agent.callAny('setting.get', { id: settingId })).toMatchObject({
    value: false,
    stored: { value: false, valid: true }
  })

  await win.click('button[aria-label="Settings"]')
  await win.waitFor(() => {
    const restored = win.document.querySelector('[role="dialog"]')
    const saved = restored?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    return saved?.checked === false
  })
  const reopened = win.document.querySelector('[role="dialog"]')!
  expect(reopened.textContent).toContain('Appearance')
  expect(reopened.textContent).toContain('Window & Sidebar')
  expect((reopened.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false)
})
