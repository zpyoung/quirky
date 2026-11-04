import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { AvatarSettings, Mandate, SheetRow } from '../src/contracts'

let createRoot: typeof import('react-dom/client').createRoot
let Sheet: typeof import('../src/ui/Sheet').default
let SettingsSection: typeof import('../src/ui/SettingsSection').default

type Recorded = { method: string; params?: Record<string, unknown> }

const settings: AvatarSettings = {
  defaultLevel: 'full', switches: { messaging: false, historyRewrite: false, deploys: false }, houseRules: ['Use bun'],
  allowCommands: [], denyCommands: [], deployCommands: [], brainAgent: 'claude', brainModel: null, judgmentTimeoutSeconds: 55
}

function row(worktreeId: string, over: Partial<SheetRow> = {}): SheetRow {
  return {
    worktreeId, name: worktreeId, projectId: 'quirky', projectName: 'quirky', groupId: 'desktop', groupName: 'Desktop',
    agent: 'claude', running: true, handedOff: false, eligible: true, reason: null, ungatedNote: null, ...over
  }
}

const sheetRows: SheetRow[] = [
  row('provider-host', { agent: 'codex', ungatedNote: "Codex's hosted tools aren't gated" }),
  row('fix-desktop'),
  row('sa-browser', { handedOff: true }),
  row('agent-tabs', { projectId: 'orca', projectName: 'orca', running: false, agent: null }),
  row('main', { projectId: 'orca', projectName: 'orca', running: false, agent: null, eligible: false, reason: "Can't hand off: a Heimdall watcher supervises it" })
]
const storedMandate: Mandate = {
  worktreeId: 'sa-browser', goal: 'Fix the 2 failing checks', doneWhen: 'CI green on the PR', doneWhenKind: 'prose', guidelines: ['No snapshot updates'],
  level: 'own-branch', switches: { messaging: false, historyRewrite: false, deploys: false }, agent: null, sharedGoalId: null, notes: '', allowSplit: false, updatedAt: 1
}

let container: HTMLElement
let root: Root
let calls: Recorded[]
let toasts: unknown[][]
let status: unknown
let handoffResult: Promise<unknown>
let savedSettings: AvatarSettings

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Sheet = (await import('../src/ui/Sheet')).default
  SettingsSection = (await import('../src/ui/SettingsSection')).default
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  calls = []
  toasts = []
  status = { handoffs: [], needsYouCount: 0 }
  handoffResult = Promise.resolve({ results: [] })
  savedSettings = settings
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function makeContext(): UiPluginContext {
  return {
    pluginId: 'quirky.avatar',
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'quirky.avatar/eligibility') return sheetRows
      if (method === 'quirky.avatar/settings') return savedSettings
      if (method === 'quirky.avatar/status') return status
      if (method === 'quirky.avatar/mandate') return params?.worktreeId === 'sa-browser' ? storedMandate : null
      if (method === 'quirky.avatar/handoff') return handoffResult
      if (method === 'quirky.avatar/setSettings') return { ...savedSettings, ...params }
      if (method === 'quirky.agents/list') {
        return {
          defaultAgent: 'codex', agents: [
            { id: 'claude', label: 'Claude', installed: true, enabled: true },
            { id: 'codex', label: 'Codex', installed: true, enabled: true },
            { id: 'gemini', label: 'Gemini', installed: false, enabled: true }
          ]
        }
      }
      throw new Error(`no fake for ${method}`)
    },
    toast: (...args: unknown[]) => toasts.push(args)
  } as unknown as UiPluginContext
}

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() })

async function renderSheet(input?: unknown): Promise<{ closed: () => number }> {
  let closes = 0
  await act(async () => root.render(<Sheet context={makeContext()} input={input} onClose={() => { closes += 1 }} />))
  await settle()
  return { closed: () => closes }
}

function find<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function byLabel<T extends HTMLElement>(label: string): T {
  return find<T>(`[aria-label="${label}"]`)
}

function buttonText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button ${text}`)
  return button
}

function labelled<T extends HTMLElement>(text: string): T {
  const label = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === text)
  const target = label?.htmlFor ? container.querySelector<T>(`#${CSS.escape(label.htmlFor)}`) : label?.querySelector<T>('input')
  if (!target) throw new Error(`Missing field ${text}`)
  return target
}

async function click(element: HTMLElement) {
  await act(async () => element.click())
}

async function type(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('hand-off sheet', () => {
  test('lists rows by group and project, with ineligible rows disabled and showing their reason', async () => {
    await renderSheet()
    expect(find('[data-avatar-group="desktop"]').textContent).toContain('Desktop')
    expect(find('[data-avatar-project="orca"]').textContent).toContain('orca')
    expect(byLabel<HTMLInputElement>('Select main').disabled).toBe(true)
    expect(find('[data-avatar-row="main"]').textContent).toContain("Can't hand off: a Heimdall watcher supervises it")
    expect(find('[data-avatar-row="provider-host"]').textContent).toContain("Codex's hosted tools aren't gated")
    expect(calls.some((call) => call.method === 'quirky.avatar/eligibility')).toBe(true)
  })

  test('SC-1: project select, one row to own branch, goals filled, Hand off sends three items and closes at once', async () => {
    let release!: (value: unknown) => void
    handoffResult = new Promise((resolve) => { release = resolve })
    const sheet = await renderSheet()
    await click(byLabel('Select project quirky'))
    expect(find('[role="group"][aria-label="Bulk edit"]').textContent).toContain('3 selected')
    await type(byLabel('Level for sa-browser'), 'own-branch')
    await type(byLabel('Goal for provider-host'), 'Finish restart handling')
    await type(byLabel('Done when for provider-host'), 'bun scripts/suite.ts plugins/quirky.agents')
    await type(byLabel('Goal for fix-desktop'), 'Show command badges')
    await type(byLabel('Done when for fix-desktop'), 'tab badges render')
    await type(byLabel('Goal for sa-browser'), 'Fix the 2 failing checks')
    await type(byLabel('Done when for sa-browser'), 'CI green on the PR')
    expect(buttonText('Hand off 3 worktrees').disabled).toBe(false)
    await click(buttonText('Hand off 3 worktrees'))
    expect(sheet.closed()).toBe(1)
    const call = calls.find((entry) => entry.method === 'quirky.avatar/handoff')
    const items = call?.params?.items as { worktreeId: string; level: string; doneWhenKind: string }[]
    expect(items.map((item) => [item.worktreeId, item.level])).toEqual([['provider-host', 'full'], ['fix-desktop', 'full'], ['sa-browser', 'own-branch']])
    expect(items[0].doneWhenKind).toBe('command')
    release({ results: [] })
    await settle()
  })

  test('SC-2: project select skips the ineligible row', async () => {
    await renderSheet()
    await click(byLabel('Select project orca'))
    expect(byLabel<HTMLInputElement>('Select agent-tabs').checked).toBe(true)
    expect(byLabel<HTMLInputElement>('Select main').checked).toBe(false)
    expect(find('[role="group"][aria-label="Bulk edit"]').textContent).toContain('1 selected')
  })

  test('missing goal or done when blocks Hand off and names the field', async () => {
    const sheet = await renderSheet()
    await click(byLabel('Select fix-desktop'))
    await click(buttonText('Hand off 1 worktree'))
    expect(sheet.closed()).toBe(0)
    expect(calls.some((entry) => entry.method === 'quirky.avatar/handoff')).toBe(false)
    expect(container.textContent).toContain('Goal is required')
    expect(container.textContent).toContain('Done when is required')
  })

  test('the bulk bar sets level, switches and a shared goal for the selection', async () => {
    await renderSheet()
    await click(byLabel('Select fix-desktop'))
    await click(byLabel('Select agent-tabs'))
    await type(labelled('Set level'), 'local')
    await click(labelled('Message people for all selected'))
    await click(buttonText('Give one shared goal…'))
    await type(labelled('Shared goal'), 'Ship tab badges')
    await type(labelled('Shared done when'), 'bun test badges')
    await click(buttonText('Apply shared goal'))
    expect(byLabel<HTMLInputElement>('Goal for fix-desktop').value).toBe('Ship tab badges')
    await click(buttonText('Hand off 2 worktrees'))
    const items = calls.find((entry) => entry.method === 'quirky.avatar/handoff')?.params?.items as { level: string; switches: { messaging: boolean }; sharedGoal: { id: string; goal: string } }[]
    expect(items.map((item) => item.level)).toEqual(['local', 'local'])
    expect(items.every((item) => item.switches.messaging)).toBe(true)
    expect(items[0].sharedGoal.goal).toBe('Ship tab badges')
    expect(items[0].sharedGoal.id).toBe(items[1].sharedGoal.id)
  })

  test('input preselects a one-row sheet and opens it with guidelines, switches and the default agent', async () => {
    await renderSheet({ worktreeIds: ['agent-tabs'] })
    expect(byLabel<HTMLInputElement>('Select agent-tabs').checked).toBe(true)
    expect(byLabel<HTMLInputElement>('Select fix-desktop').checked).toBe(false)
    expect(find('[data-avatar-details="agent-tabs"]')).toBeTruthy()
    await type(labelled('Guidelines for agent-tabs'), 'Keep the API\nRebase on main')
    expect(labelled<HTMLSelectElement>('Agent to start for agent-tabs').value).toBe('codex')
    await type(byLabel('Goal for agent-tabs'), 'Badges')
    await type(byLabel('Done when for agent-tabs'), 'CI green')
    await click(buttonText('Hand off 1 worktree'))
    const [item] = calls.find((entry) => entry.method === 'quirky.avatar/handoff')?.params?.items as { guidelines: string[]; agent: string }[]
    expect(item).toMatchObject({ guidelines: ['Keep the API', 'Rebase on main'], agent: 'codex' })
  })

  test('an already handed-off row opens with its stored mandate', async () => {
    await renderSheet({ worktreeIds: ['sa-browser'] })
    expect(byLabel<HTMLInputElement>('Goal for sa-browser').value).toBe('Fix the 2 failing checks')
    expect(byLabel<HTMLInputElement>('Done when for sa-browser').value).toBe('CI green on the PR')
    expect(byLabel<HTMLSelectElement>('Level for sa-browser').value).toBe('own-branch')
    expect(labelled<HTMLTextAreaElement>('Guidelines for sa-browser').value).toBe('No snapshot updates')
    expect(find('[data-avatar-row="sa-browser"]').textContent).toContain('Handed off')
  })

  test('filter and the running-only toggle narrow the rows', async () => {
    await renderSheet()
    await type(labelled('Filter'), 'codex')
    expect(container.querySelector('[data-avatar-row="provider-host"]')).toBeTruthy()
    expect(container.querySelector('[data-avatar-row="fix-desktop"]')).toBeNull()
    await type(labelled('Filter'), '')
    await click(labelled('Only with a running agent'))
    expect(container.querySelector('[data-avatar-row="agent-tabs"]')).toBeNull()
    expect(container.querySelector('[data-avatar-row="fix-desktop"]')).toBeTruthy()
  })

  test('warns about sleep only when the status method reports a power hint', async () => {
    await renderSheet()
    expect(container.querySelector('[role="status"]')).toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    status = { handoffs: [], needsYouCount: 0, powerState: { onBattery: true, externalDisplay: null } }
    await renderSheet()
    expect(find('[role="status"]').textContent).toContain('On battery')
  })

  test('a per-item failure from the avatar is reported in a toast after the sheet has closed', async () => {
    handoffResult = Promise.resolve({ results: [{ worktreeId: 'fix-desktop', ok: false, error: 'not-eligible: gone' }] })
    const sheet = await renderSheet({ worktreeIds: ['fix-desktop'] })
    await type(byLabel('Goal for fix-desktop'), 'g')
    await type(byLabel('Done when for fix-desktop'), 'd')
    await click(buttonText('Hand off 1 worktree'))
    await settle()
    expect(sheet.closed()).toBe(1)
    expect(toasts[0]).toEqual(['Could not hand off fix-desktop', 'not-eligible: gone', { kind: 'warning' }])
  })
})

describe('Settings, Avatar', () => {
  async function renderSettings() {
    await act(async () => root.render(<SettingsSection context={makeContext()} />))
    await settle()
  }

  test('shows the stored settings and keeps edits local until Save', async () => {
    await renderSettings()
    expect(labelled<HTMLSelectElement>('Default level').value).toBe('full')
    expect(labelled<HTMLTextAreaElement>('House rules').value).toBe('Use bun')
    await type(labelled('House rules'), 'Use bun\nNever skip tests')
    await click(labelled('Message people (PR comments, reviews, issues, chat)'))
    expect(calls.some((entry) => entry.method === 'quirky.avatar/setSettings')).toBe(false)
    await click(buttonText('Save'))
    const call = calls.find((entry) => entry.method === 'quirky.avatar/setSettings')
    expect(call?.params).toMatchObject({
      houseRules: ['Use bun', 'Never skip tests'], switches: { messaging: true, historyRewrite: false, deploys: false },
      defaultLevel: 'full', brainAgent: 'claude', brainModel: null, judgmentTimeoutSeconds: 55
    })
  })

  test('shows the Codex note only while the brain agent is codex', async () => {
    await renderSettings()
    const note = "Codex can't fully turn off its shell; the avatar interrupts any tool it starts."
    expect(container.textContent).not.toContain(note)
    await type(labelled('Brain agent'), 'codex')
    expect(container.textContent).toContain(note)
    await type(labelled('Brain agent'), 'pi')
    expect(container.textContent).not.toContain(note)
  })

  test('the Codex note shows on load when the stored brain agent is codex', async () => {
    savedSettings = { ...settings, brainAgent: 'codex' }
    await renderSettings()
    expect(container.textContent).toContain("Codex can't fully turn off its shell")
  })

  test('command lists, model and timeout are saved as typed values and a bad timeout blocks Save', async () => {
    await renderSettings()
    await type(labelled('Always-allowed commands'), 'bun test\n\n bun run lint ')
    await type(labelled('Brain model'), 'claude-opus-5-5')
    await type(labelled('Judgment timeout (seconds)'), '0')
    expect(buttonText('Save').disabled).toBe(true)
    await type(labelled('Judgment timeout (seconds)'), '40')
    await click(buttonText('Save'))
    expect(calls.find((entry) => entry.method === 'quirky.avatar/setSettings')?.params).toMatchObject({
      allowCommands: ['bun test', 'bun run lint'], brainModel: 'claude-opus-5-5', judgmentTimeoutSeconds: 40
    })
  })

  test('Save stays disabled until something changes', async () => {
    await renderSettings()
    expect(buttonText('Save').disabled).toBe(true)
    await type(labelled('Default level'), 'local')
    expect(buttonText('Save').disabled).toBe(false)
  })
})
