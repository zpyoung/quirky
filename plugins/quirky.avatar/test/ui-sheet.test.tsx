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
  row('main', { projectId: 'orca', projectName: 'orca', running: false, agent: null, eligible: false, reason: "Can't hand off: a Heimdall watcher supervises it" }),
  row('main', { worktreeId: 'harbor-main', projectId: 'harbor', projectName: 'harbor-api', running: false, agent: null }),
  row('taken-back', { projectId: 'harbor', projectName: 'harbor-api', running: false, agent: null }),
  row('ui-review', { projectId: 'fixture', projectName: 'ui-review-fixture', running: false, agent: null, eligible: false, reason: "Can't hand off: its agent runs in a terminal the avatar can't gate" })
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
      if (method === 'quirky.avatar/mandate') {
        if (params?.worktreeId === 'sa-browser') return storedMandate
        return params?.worktreeId === 'taken-back' ? { ...storedMandate, worktreeId: 'taken-back', goal: 'Kept goal' } : null
      }
      if (method === 'quirky.avatar/handoff') return handoffResult
      if (method === 'quirky.avatar/setSettings') return { ...savedSettings, ...params }
      if (method === 'quirky.agents/list') {
        return {
          defaultAgent: 'codex', agents: [
            { id: 'claude', label: 'Claude', installed: true, enabled: true },
            { id: 'codex', label: 'Codex', installed: true, enabled: true },
            { id: 'rovodev', label: 'Rovo Dev', installed: true, enabled: true },
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

function ownText(button: HTMLElement): string {
  return [...button.childNodes].filter((node) => !(node instanceof HTMLElement && node.tagName === 'KBD')).map((node) => node.textContent).join('').trim()
}

function buttonText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')].find((candidate) => ownText(candidate) === text)
  if (!button) throw new Error(`Missing button ${text}`)
  return button
}

function labelled<T extends HTMLElement>(text: string): T {
  const label = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === text)
  const target = label?.htmlFor ? container.querySelector<T>(`#${CSS.escape(label.htmlFor)}`) : label?.querySelector<T>('input')
  if (!target) throw new Error(`Missing field ${text}`)
  return target
}

function radio(group: string, name: string): HTMLButtonElement {
  const found = [...byLabel(group).querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((candidate) => candidate.textContent?.trim() === name)
  if (!found) throw new Error(`Missing ${name} in ${group}`)
  return found
}

const checkedLevel = (group: string) => [...byLabel(group).querySelectorAll('[role="radio"]')].find((candidate) => candidate.getAttribute('aria-checked') === 'true')?.textContent?.trim()

async function press(element: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

const footer = () => find('.ui-dialog__actions')

function labelIn(scope: ParentNode, text: string): HTMLElement {
  const label = [...scope.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === text)
  const input = label?.querySelector<HTMLElement>('input')
  if (!input) throw new Error(`Missing field ${text}`)
  return input
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
  test('lists rows by group and project, folds ineligible rows into one held-back line and keeps the reason', async () => {
    await renderSheet()
    expect(find('[data-avatar-group="desktop"]').textContent).toContain('Desktop')
    expect(find('[data-avatar-project="orca"]').textContent).toContain('orca')
    expect(container.querySelector('[data-avatar-project="fixture"]')).toBeNull()
    expect(container.querySelector('[aria-label="Select main (orca)"]')).toBeNull()
    const held = find('[data-avatar-held-back]')
    expect(held.textContent).toContain('2 worktrees held back')
    expect(held.textContent).toContain('main (orca)')
    expect(held.textContent).toContain('ui-review')
    expect(held.textContent).not.toContain('Heimdall')
    expect(find('[data-avatar-row="provider-host"]').textContent).toContain("Codex's hosted tools aren't gated")
    expect(calls.some((call) => call.method === 'quirky.avatar/eligibility')).toBe(true)
  })

  test('the held-back list expands to each reason and stays disabled', async () => {
    await renderSheet()
    const toggle = buttonText('Show 2')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    const main = find('[data-avatar-row="main"]')
    expect(main.getAttribute('aria-disabled')).toBe('true')
    expect(main.textContent).toContain("Can't hand off: a Heimdall watcher supervises it")
    expect(find('[data-avatar-row="ui-review"]').textContent).toContain("terminal the avatar can't gate")
    await click(buttonText('Hide'))
    expect(container.querySelector('[data-avatar-row="main"]')).toBeNull()
  })

  test('a single shared reason shows once on the collapsed line', async () => {
    await renderSheet()
    await type(byLabel('Filter'), 'orca')
    const held = find('[data-avatar-held-back]')
    expect(held.textContent).toContain('1 worktree held back')
    expect(held.textContent).toContain("Can't hand off: a Heimdall watcher supervises it")
    expect(buttonText('Show 1')).toBeTruthy()
  })

  test('the worktree cell names the agent, its state, and what a hand-off will do', async () => {
    await renderSheet()
    expect(find('[data-avatar-row="provider-host"]').textContent).toContain('Codex, running')
    const fresh = find('[data-avatar-row="agent-tabs"]').textContent
    expect(fresh).toContain('No agent yet')
    expect(fresh).toContain('Starts Codex when handed off')
    const updating = find('[data-avatar-row="sa-browser"]').textContent
    expect(updating).toContain('Updating')
    expect(updating).toContain('Re-briefs Claude at its next idle prompt')
    expect(find('[data-avatar-row="fix-desktop"]').textContent).not.toContain('Updating')
  })

  test('SC-1: project select, one row to own branch, goals filled, Hand off sends three items and closes at once', async () => {
    let release!: (value: unknown) => void
    handoffResult = new Promise((resolve) => { release = resolve })
    const sheet = await renderSheet()
    await click(byLabel('Select project quirky'))
    expect(find('[role="group"][aria-label="Bulk edit"]').textContent).toContain('3 selected')
    await click(radio('Level for sa-browser', 'Own branch'))
    await type(byLabel('Goal for provider-host'), 'Finish restart handling')
    await type(byLabel('Done when for provider-host'), 'bun scripts/suite.ts plugins/quirky.agents')
    await type(byLabel('Goal for fix-desktop'), 'Show command badges')
    await type(byLabel('Done when for fix-desktop'), 'tab badges render')
    await type(byLabel('Goal for sa-browser'), 'Fix the 2 failing checks')
    await type(byLabel('Done when for sa-browser'), 'CI green on the PR')
    expect(buttonText('Hand off 3 worktrees (1 update)').disabled).toBe(false)
    await click(buttonText('Hand off 3 worktrees (1 update)'))
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
    expect(find('[role="group"][aria-label="Bulk edit"]').textContent).toContain('1 selected')
    await click(buttonText('Show 2'))
    expect(find('[data-avatar-row="main"]').getAttribute('aria-disabled')).toBe('true')
    expect(find('[role="group"][aria-label="Bulk edit"]').textContent).toContain('1 selected')
  })

  test('missing goal or done when blocks Hand off, names the field inline and focuses the first one', async () => {
    const sheet = await renderSheet()
    await click(byLabel('Select fix-desktop'))
    await click(buttonText('Hand off 1 worktree'))
    expect(sheet.closed()).toBe(0)
    expect(calls.some((entry) => entry.method === 'quirky.avatar/handoff')).toBe(false)
    const goal = byLabel<HTMLInputElement>('Goal for fix-desktop')
    const done = byLabel<HTMLInputElement>('Done when for fix-desktop')
    expect(document.activeElement).toBe(goal)
    expect(goal.getAttribute('aria-invalid')).toBe('true')
    expect(container.querySelector(`#${CSS.escape(goal.getAttribute('aria-describedby') ?? '')}`)?.textContent).toBe('Write a goal so the avatar knows what to do.')
    expect(done.getAttribute('aria-invalid')).toBe('true')
    const doneError = [...container.querySelectorAll('.ui-error-text')].find((node) => node.textContent === 'Add a check so it knows when to stop.')
    expect(done.getAttribute('aria-describedby')).toContain(doneError?.id ?? 'missing')
    expect(container.textContent).toContain('Add a check so it knows when to stop.')
  })

  test('the footer link says what is missing and jumps back to the first invalid field', async () => {
    await renderSheet()
    await click(byLabel('Select fix-desktop'))
    await click(byLabel('Select agent-tabs'))
    expect(footer().textContent).not.toContain('Go to it')
    await click(buttonText('Hand off 2 worktrees'))
    expect(footer().textContent).toContain('2 worktrees need a goal · Go to it')
    await act(async () => byLabel<HTMLInputElement>('Goal for agent-tabs').focus())
    await click(buttonText('2 worktrees need a goal · Go to it'))
    expect(document.activeElement).toBe(byLabel('Goal for fix-desktop'))
    await type(byLabel('Goal for fix-desktop'), 'g')
    await type(byLabel('Done when for fix-desktop'), 'd')
    expect(footer().textContent).toContain('1 worktree needs a goal · Go to it')
  })

  test('Cmd+Enter and Ctrl+Enter hand off from anywhere in the sheet', async () => {
    const sheet = await renderSheet({ worktreeIds: ['fix-desktop'] })
    await type(byLabel('Goal for fix-desktop'), 'Badges')
    await type(byLabel('Done when for fix-desktop'), 'CI green')
    await press(byLabel('Goal for fix-desktop'), 'Enter')
    expect(sheet.closed()).toBe(0)
    await press(buttonText('Cancel', footer()), 'Enter', { ctrlKey: true })
    expect(sheet.closed()).toBe(1)
    expect(calls.filter((entry) => entry.method === 'quirky.avatar/handoff')).toHaveLength(1)
  })

  test('Cmd+Enter on an incomplete sheet shows the errors instead of handing off', async () => {
    const sheet = await renderSheet({ worktreeIds: ['fix-desktop'] })
    await press(byLabel('Notes for fix-desktop'), 'Enter', { metaKey: true })
    expect(sheet.closed()).toBe(0)
    expect(document.activeElement).toBe(byLabel('Goal for fix-desktop'))
  })

  test('the bulk bar sets level, switches and a shared goal for the selection', async () => {
    await renderSheet()
    await click(byLabel('Select fix-desktop'))
    await click(byLabel('Select agent-tabs'))
    await click(radio('Set level for all selected', 'Local'))
    const alsoAllow = find('fieldset[aria-label="Also allow for all selected"]')
    await click(labelIn(alsoAllow, 'Message people'))
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

  test('bulk Full… asks first and only Set Full applies it', async () => {
    await renderSheet()
    await click(byLabel('Select fix-desktop'))
    await click(byLabel('Select agent-tabs'))
    await click(radio('Set level for all selected', 'Local'))
    expect(checkedLevel('Level for fix-desktop')).toBe('Local')
    const full = radio('Set level for all selected', 'Full…')
    expect(full.title).toContain('asks you to confirm')
    await click(full)
    const confirm = find('[role="group"][aria-label="Confirm Full for all selected"]')
    expect(confirm.textContent).toContain('Full lets the avatar merge and do anything each mandate allows')
    expect(checkedLevel('Level for fix-desktop')).toBe('Local')
    await click(buttonText('Cancel', confirm))
    expect(container.querySelector('[aria-label="Confirm Full for all selected"]')).toBeNull()
    expect(checkedLevel('Level for fix-desktop')).toBe('Local')
    await click(radio('Set level for all selected', 'Full…'))
    await click(buttonText('Set Full', find('[aria-label="Confirm Full for all selected"]')))
    expect(checkedLevel('Level for fix-desktop')).toBe('Full')
    expect(checkedLevel('Level for agent-tabs')).toBe('Full')
    expect(container.querySelector('[aria-label="Confirm Full for all selected"]')).toBeNull()
  })

  test('the reach meter fills up to the level, selects by click and moves with arrow, Home and End keys', async () => {
    await renderSheet({ worktreeIds: ['fix-desktop'] })
    const group = 'Level for fix-desktop'
    expect(byLabel(group).getAttribute('role')).toBe('radiogroup')
    expect(checkedLevel(group)).toBe('Full')
    expect(radio(group, 'Full').title).not.toContain('confirm')
    expect(find('[data-avatar-row="fix-desktop"]').textContent).toContain('Anything the mandate allows, merge included · your default')
    await click(radio(group, 'Local'))
    expect(checkedLevel(group)).toBe('Local')
    expect(radio(group, 'Local').tabIndex).toBe(0)
    expect(radio(group, 'Full').tabIndex).toBe(-1)
    expect(find('[data-avatar-row="fix-desktop"]').textContent).toContain('Nothing leaves this Mac')
    expect(find('[data-avatar-row="fix-desktop"]').textContent).not.toContain('your default')
    const filled = [...byLabel(group).querySelectorAll('.ui-reach-meter__segment--in')].map((node) => node.textContent)
    expect(filled).toEqual(['Shadow', 'Local'])
    await act(async () => radio(group, 'Local').focus())
    await press(radio(group, 'Local'), 'ArrowRight')
    expect(checkedLevel(group)).toBe('Own branch')
    expect(document.activeElement).toBe(radio(group, 'Own branch'))
    await press(radio(group, 'Own branch'), 'End')
    expect(checkedLevel(group)).toBe('Full')
    await press(radio(group, 'Full'), 'ArrowRight')
    expect(checkedLevel(group)).toBe('Shadow')
    await press(radio(group, 'Shadow'), 'ArrowUp')
    expect(checkedLevel(group)).toBe('Full')
    await press(radio(group, 'Full'), 'Home')
    expect(checkedLevel(group)).toBe('Shadow')
  })

  test('the done-when tag shows how it will be checked and flips it explicitly', async () => {
    await renderSheet({ worktreeIds: ['fix-desktop'] })
    const done = byLabel<HTMLInputElement>('Done when for fix-desktop')
    await type(done, 'bun test passes')
    const tag = () => buttonText(find('.ui-tag-button').textContent ?? '')
    expect(tag().textContent).toBe('runs it')
    expect(tag().title).toBe('It runs this command and stops when it passes')
    expect(done.getAttribute('spellcheck')).toBe('false')
    expect(done.getAttribute('translate')).toBe('no')
    await click(tag())
    expect(tag().textContent).toBe('judges it')
    expect(tag().title).toBe('It reads the result and judges whether this is true')
    await type(done, 'bun test still passes')
    expect(tag().textContent).toBe('judges it')
    await type(byLabel('Goal for fix-desktop'), 'g')
    await click(buttonText('Hand off 1 worktree'))
    const [item] = calls.find((entry) => entry.method === 'quirky.avatar/handoff')?.params?.items as { doneWhenKind: string }[]
    expect(item.doneWhenKind).toBe('prose')
    expect(container.querySelector('select[aria-label^="Done when is"]')).toBeNull()
  })

  test('rows after the first of a shared goal show the same-goal line, and Write its own detaches and focuses the goal', async () => {
    await renderSheet()
    await click(byLabel('Select project quirky'))
    await click(buttonText('Give one shared goal…'))
    await type(labelled('Shared goal'), 'Ship tab badges')
    await type(labelled('Shared done when'), 'bun test badges')
    await click(buttonText('Apply shared goal'))
    expect(find('[data-avatar-project="quirky"]').textContent).toContain('One shared goal')
    expect(byLabel<HTMLInputElement>('Goal for fix-desktop').value).toBe('Ship tab badges')
    expect(container.querySelector('[aria-label="Goal for provider-host"]')).toBeNull()
    expect(find('[data-avatar-row="provider-host"]').textContent).toContain('Same goal and done-when as fix-desktop')
    expect(find('[data-avatar-row="sa-browser"]').textContent).toContain('Same goal and done-when as fix-desktop')
    await click(buttonText('Write its own', find('[data-avatar-row="provider-host"]')))
    const goal = byLabel<HTMLInputElement>('Goal for provider-host')
    expect(goal.value).toBe('Ship tab badges')
    expect(byLabel<HTMLInputElement>('Done when for provider-host').value).toBe('bun test badges')
    expect(document.activeElement).toBe(goal)
    expect(byLabel<HTMLInputElement>('Goal for sa-browser').value).toBe('Ship tab badges')
    expect(find('[data-avatar-project="quirky"]').textContent).not.toContain('One shared goal')
    await type(byLabel('Done when for fix-desktop'), 'bun test other')
    expect(byLabel<HTMLInputElement>('Done when for provider-host').value).toBe('bun test badges')
  })

  test('editing the first row of a shared goal carries its done-when to the rows that repeat it', async () => {
    await renderSheet()
    await click(byLabel('Select project quirky'))
    await click(buttonText('Give one shared goal…'))
    await type(labelled('Shared goal'), 'Ship tab badges')
    await type(labelled('Shared done when'), 'bun test badges')
    await click(buttonText('Apply shared goal'))
    await type(byLabel('Done when for fix-desktop'), 'bun test badges v2')
    expect(container.querySelector('[aria-label="Goal for provider-host"]')).toBeNull()
    await click(buttonText('Hand off 3 worktrees (1 update)'))
    const items = calls.find((entry) => entry.method === 'quirky.avatar/handoff')?.params?.items as { doneWhen: string }[]
    expect(items.map((item) => item.doneWhen)).toEqual(['bun test badges v2', 'bun test badges v2', 'bun test badges v2'])
  })

  test('the footer summarises the selection by level, switch and what it never does', async () => {
    await renderSheet({ worktreeIds: ['fix-desktop'] })
    const summary = () => footer().querySelector('dl')?.textContent ?? ''
    expect(footer().textContent).toContain('While you’re away, the avatar may')
    expect(footer().textContent).toContain('House rules from Settings apply to all.')
    expect(summary()).toContain('Push, open PRs, merge')
    expect(summary()).toContain('on fix-desktop')
    expect(summary()).toContain('Neverdeploy, touch anything outside these worktrees, or use credentials')
    await click(radio('Level for fix-desktop', 'Local'))
    expect(summary()).toContain('Work locally')
    expect(summary()).toContain('Nevermerge, deploy, touch anything')
    await click(byLabel('Message people (fix-desktop)'))
    expect(summary()).toContain('Message peoplefor fix-desktop')
    await click(byLabel('Select fix-desktop'))
    expect(footer().querySelector('dl')).toBeNull()
  })

  test('input preselects a one-row sheet and opens it with guidelines, switches and the default agent', async () => {
    await renderSheet({ worktreeIds: ['agent-tabs'] })
    expect(byLabel<HTMLInputElement>('Select agent-tabs').checked).toBe(true)
    expect(byLabel<HTMLInputElement>('Select fix-desktop').checked).toBe(false)
    expect(find('[data-avatar-details="agent-tabs"]')).toBeTruthy()
    expect(byLabel('Hide details for agent-tabs').getAttribute('aria-expanded')).toBe('true')
    await type(byLabel('Guidelines for agent-tabs'), 'Keep the API\nRebase on main')
    expect(labelled<HTMLSelectElement>('Agent to start for agent-tabs').value).toBe('codex')
    await type(byLabel('Goal for agent-tabs'), 'Badges')
    await type(byLabel('Done when for agent-tabs'), 'CI green')
    await click(buttonText('Hand off 1 worktree'))
    const [item] = calls.find((entry) => entry.method === 'quirky.avatar/handoff')?.params?.items as { guidelines: string[]; agent: string }[]
    expect(item).toMatchObject({ guidelines: ['Keep the API', 'Rebase on main'], agent: 'codex' })
  })

  test('the details panel switches show as chips on the row and the picker names the agent that will start', async () => {
    await renderSheet({ worktreeIds: ['agent-tabs'] })
    expect(find('[data-avatar-row="agent-tabs"]').textContent).toContain('Starts Codex when handed off')
    await click(byLabel('Message people (agent-tabs)'))
    expect(find('[data-avatar-row="agent-tabs"]').textContent).toContain('+ Message people')
    expect(find('fieldset[aria-label="Also allow for agent-tabs"]').textContent).toContain('these go past the level')
    await type(labelled('Agent to start for agent-tabs'), 'claude')
    expect(find('[data-avatar-row="agent-tabs"]').textContent).toContain('Starts Claude when handed off')
    await click(byLabel('Hide details for agent-tabs'))
    expect(container.querySelector('[data-avatar-details="agent-tabs"]')).toBeNull()
  })

  test('a running row says its agent keeps running instead of offering the picker', async () => {
    await renderSheet({ worktreeIds: ['fix-desktop'] })
    expect(find('[data-avatar-details="fix-desktop"]').textContent).toContain('Keeps running Claude')
    expect(container.querySelector('select[aria-label^="Agent to start"]')).toBeNull()
  })

  test('an already handed-off row opens with its stored mandate', async () => {
    await renderSheet({ worktreeIds: ['sa-browser'] })
    expect(byLabel<HTMLInputElement>('Goal for sa-browser').value).toBe('Fix the 2 failing checks')
    expect(byLabel<HTMLInputElement>('Done when for sa-browser').value).toBe('CI green on the PR')
    expect(checkedLevel('Level for sa-browser')).toBe('Own branch')
    expect(byLabel<HTMLTextAreaElement>('Guidelines for sa-browser').value).toBe('No snapshot updates')
    expect(find('[data-avatar-row="sa-browser"]').textContent).toContain('Updating')
  })

  test('SC-28: a taken-back row still opens with its kept mandate', async () => {
    await renderSheet({ worktreeIds: ['taken-back'] })
    expect(calls.some((call) => call.method === 'quirky.avatar/mandate' && call.params?.worktreeId === 'taken-back')).toBe(true)
    expect(byLabel<HTMLInputElement>('Goal for taken-back').value).toBe('Kept goal')
    expect(checkedLevel('Level for taken-back')).toBe('Own branch')
  })

  test('a row with no stored mandate (null) opens blank with the defaults', async () => {
    await renderSheet({ worktreeIds: ['fix-desktop'] })
    expect(byLabel<HTMLInputElement>('Goal for fix-desktop').value).toBe('')
    expect(checkedLevel('Level for fix-desktop')).toBe('Full')
  })

  test('the agent picker offers only hookable, installed agents and names a hookable default', async () => {
    await renderSheet({ worktreeIds: ['agent-tabs'] })
    const select = labelled<HTMLSelectElement>('Agent to start for agent-tabs')
    expect([...select.options].map((option) => option.textContent)).toEqual(['Default (Codex)', 'Claude', 'Codex'])
  })

  test('the submit button says Update when every selected row is already handed off, and counts updates in a mix', async () => {
    await renderSheet()
    await click(byLabel('Select sa-browser'))
    expect(buttonText('Update 1 mandate')).toBeTruthy()
    await click(byLabel('Select fix-desktop'))
    expect(buttonText('Hand off 2 worktrees (1 update)')).toBeTruthy()
    expect(buttonText('Hand off 2 worktrees (1 update)').querySelector('kbd')?.textContent).toBe('⌘ ↵')
  })

  test('row controls include the project when a worktree name repeats', async () => {
    await renderSheet()
    expect(byLabel('Select main (harbor-api)')).toBeTruthy()
    expect(byLabel('Goal for main (harbor-api)')).toBeTruthy()
    expect(byLabel('Level for main (harbor-api)')).toBeTruthy()
    expect(byLabel('Select fix-desktop')).toBeTruthy()
  })

  test('filter and the running-only toggle narrow the rows', async () => {
    await renderSheet()
    const filter = byLabel<HTMLInputElement>('Filter')
    expect(filter.getAttribute('autocomplete')).toBe('off')
    expect(filter.getAttribute('spellcheck')).toBe('false')
    await type(filter, 'codex')
    expect(container.querySelector('[data-avatar-row="provider-host"]')).toBeTruthy()
    expect(container.querySelector('[data-avatar-row="fix-desktop"]')).toBeNull()
    await type(filter, '')
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
    expect(toasts[0]).toEqual(['Could not hand off fix-desktop', 'gone', { kind: 'warning' }])
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
