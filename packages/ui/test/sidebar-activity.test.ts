import { afterEach, expect, test } from 'bun:test'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

afterEach(closeWindows)

const BASE = 'acme.sidebar-base'
const OVERRIDE = 'acme.sidebar-override'
const ACTIVITY_ITEM = `activity-item:${BASE}/source-control`
const SOURCE_CONTROL_PANEL = `panel:${BASE}/source-control`
const PROBLEMS_PANEL = `panel:${BASE}/problems`
const activitySlot = `[data-plugin-slot="${ACTIVITY_ITEM}"]`

type ActivitySlotState = {
  id: string
  kind: string
  plugin: string
  title: string
  shown: boolean
  report?: unknown
}

type WindowUiState = {
  layout: { panel: string | null }
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

test('activity items mount outside closed panels, swap owners, clean up on disable, and preserve D10 panels', async () => {
  const env = await bootWindow((installed) => {
    installUiPlugin(
      installed,
      BASE,
      {
        'activity-item': [{ id: 'source-control', title: 'Source Control', order: 10 }],
        panel: [
          { id: 'source-control', title: 'Source Control', order: 10 },
          { id: 'problems', title: 'Problems', order: 20 }
        ]
      },
      [
        provide(
          ACTIVITY_ITEM,
          `const button = document.createElement('button');
           button.id = 'base-source-control-activity';
           button.setAttribute('aria-label', 'Open Source Control');
           button.textContent = 'Source Control';
           button.addEventListener('click', () => context.togglePanel(${JSON.stringify(SOURCE_CONTROL_PANEL)}));
           element.append(button);
           props.report({ owner: 'base', count: 0, available: true });`
        ),
        provide(SOURCE_CONTROL_PANEL, "element.textContent = 'Source Control panel'"),
        provide(PROBLEMS_PANEL, "element.textContent = 'Problems panel'")
      ].join('\n')
    )
    installUiPlugin(
      installed,
      OVERRIDE,
      {},
      provide(
        ACTIVITY_ITEM,
        `const button = document.createElement('button');
         button.id = 'override-source-control-activity';
         button.setAttribute('aria-label', 'Open Source Control');
         button.textContent = 'Source Control';
         button.addEventListener('click', () => context.togglePanel(${JSON.stringify(SOURCE_CONTROL_PANEL)}));
         element.append(button);
         props.report({ owner: 'override', count: 2, available: true });`
      ),
      { overrides: [{ id: ACTIVITY_ITEM, title: 'Team Source Control', order: 5 }] }
    )
  })
  const { win, agent } = env

  expect(await agent.callAny('ui.contributions', {})).toMatchObject({
    activityItems: [{ id: ACTIVITY_ITEM, plugin: OVERRIDE, title: 'Team Source Control' }]
  })

  await win.waitFor(() => win.document.querySelector('#override-source-control-activity'))
  await win.waitFor(async () => (await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)?.report !== undefined)
  expect(win.document.querySelector(`${activitySlot} #base-source-control-activity`)).toBeNull()
  expect(win.document.querySelector(activitySlot)?.closest('[data-region="panel"]')).toBeNull()
  expect(win.document.querySelector('.plugin-panel')).toBeNull()
  expect((await readUiState(env)).layout.panel).toBeNull()
  expect((await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)).toMatchObject({
    kind: 'activity-item',
    plugin: OVERRIDE,
    title: 'Team Source Control',
    shown: true,
    report: { owner: 'override', count: 2, available: true }
  })

  const headerButtons = () => Array.from(win.document.querySelectorAll('.main-header button')) as HTMLButtonElement[]
  await win.waitFor(() => headerButtons().length === 2)
  expect(headerButtons().map((button) => button.textContent?.trim())).toEqual(['Source Control', 'Problems'])
  expect(headerButtons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false'])

  await win.click('#override-source-control-activity')
  await win.waitFor(async () => (await readUiState(env)).layout.panel === SOURCE_CONTROL_PANEL)
  await win.waitFor(() => win.document.querySelector(`[data-region="panel"] [data-plugin-slot="${SOURCE_CONTROL_PANEL}"]`))
  const firstPanel = win.document.querySelector('[data-region="panel"]')!
  const layout = win.document.querySelector('.layout')!
  expect(firstPanel.tagName).toBe('ASIDE')
  expect(firstPanel.parentElement).toBe(layout)
  expect(layout.lastElementChild).toBe(firstPanel)
  expect(win.document.querySelectorAll('.plugin-panel')).toHaveLength(1)
  expect(headerButtons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])

  await win.click('.main-header button[aria-pressed="false"]')
  await win.waitFor(async () => (await readUiState(env)).layout.panel === PROBLEMS_PANEL)
  expect(win.document.querySelector(`[data-region="panel"] [data-plugin-slot="${PROBLEMS_PANEL}"]`)?.textContent).toContain('Problems panel')
  expect(win.document.querySelector(`[data-region="panel"] [data-plugin-slot="${SOURCE_CONTROL_PANEL}"]`)).toBeNull()
  expect(win.document.querySelectorAll('.plugin-panel')).toHaveLength(1)
  expect(headerButtons().map((button) => [button.textContent?.trim(), button.getAttribute('aria-pressed')])).toEqual([
    ['Source Control', 'false'],
    ['Problems', 'true']
  ])

  await win.click('.main-header button[aria-pressed="true"]')
  await win.waitFor(async () => (await readUiState(env)).layout.panel === null)
  expect(win.document.querySelector('[data-region="panel"]')).toBeNull()
  expect(headerButtons()).toHaveLength(2)
  expect(win.document.querySelector(activitySlot)).not.toBeNull()

  await agent.callAny('plugin.disable', { id: OVERRIDE })
  await win.waitFor(() =>
    win.document.querySelector('#base-source-control-activity') !== null &&
    win.document.querySelector('#override-source-control-activity') === null
  )
  await win.waitFor(async () => reportOwner((await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)) === 'base')
  expect((await readUiState(env)).slots.find((slot) => slot.id === ACTIVITY_ITEM)).toMatchObject({
    plugin: BASE,
    title: 'Source Control',
    report: { owner: 'base', count: 0, available: true }
  })

  await agent.callAny('plugin.disable', { id: BASE })
  await win.waitFor(() => win.document.querySelector(activitySlot) === null)
  await win.waitFor(async () => !(await readUiState(env)).slots.some((slot) => slot.id === ACTIVITY_ITEM))
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
