import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { AutomationDraft, AutomationNavigation, AutomationSurfaceProps, AutomationUiState } from '../src/ui-contracts'

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
GlobalRegistrator.register()
actGlobal.IS_REACT_ACT_ENVIRONMENT = true

// React reads DOM and act support during module initialization, so these imports follow registration.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AutomationEditor } = await import('../src/editor/AutomationEditor')

type CallRecord = { method: string; params: Record<string, unknown> }
const mounted: { container: HTMLElement; opener: HTMLButtonElement; root: Root }[] = []
const automationData = {
  hosts: [{ id: 'local', label: 'Local', available: true }],
  projects: [{ id: 'repo-1', name: 'Repository', hostId: 'local', path: '/repo-1', kind: 'git' }],
  workspaces: [{ id: 'workspace-1', repoId: 'repo-1', name: 'Main workspace', path: '/repo-1', isMain: true }],
  agents: [{ id: 'codex', label: 'Codex', enabled: true, installed: true, isDefault: true }],
  errors: []
}
const draft: AutomationDraft = {
  name: 'Unsaved automation',
  prompt: 'Review the repository.',
  agentId: 'codex',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: 'workspace-1',
  baseBranch: null,
  setupDecision: 'skip',
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  missedRunGraceMinutes: 0,
  precheck: null,
  launchOverrides: null,
  runContext: null,
  sourceContext: null
}
const navigation: AutomationNavigation = {
  page: 'list', automationId: null, runId: null, tab: 'overview', query: '', host: 'all',
  status: 'all', lastRun: 'all', agent: '', sort: 'name', direction: 'asc', runQuery: '', runStatus: 'all'
}

function makeContext() {
  const calls: CallRecord[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.automations/editorData') return automationData
      if (method === 'quirky.agents/options') return { supported: true, structured: true, unlisted: 'accept', models: [], unlistedOptions: [] }
      if (method === 'quirky.repo/show') return { settings: { defaultBase: 'main', setupScript: '', setupPolicy: null }, hooks: { setup: null } }
      if (method === 'quirky.automations/cancelEditor') return null
      throw new Error(`Unexpected UI call ${method}`)
    }
  } as unknown as UiPluginContext
  return { context, calls }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
  else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})
afterEach(async () => {
  await act(async () => {
    for (const { container, opener, root } of mounted.splice(0)) {
      root.unmount()
      container.remove()
      opener.remove()
    }
  })
})

test('Escape cancels an unsaved automation without saving and restores focus when the dialog closes', async () => {
  const { context, calls } = makeContext()
  const opener = document.createElement('button')
  opener.textContent = 'New Automation'
  document.body.append(opener)
  opener.focus()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ container, opener, root })
  const state: AutomationUiState = {
    revision: 1,
    navigation,
    editor: { id: null, original: null, draft, creationKey: 'unsaved-editor' }
  }
  let refreshCalls = 0
  const props: AutomationSurfaceProps = {
    context,
    state,
    refresh: async () => { refreshCalls += 1 },
    notify: () => {}
  }

  await act(async () => root.render(createElement(AutomationEditor, props)))
  await settle()
  const name = container.querySelector<HTMLInputElement>('#auto-editor-name')
  expect(name).not.toBeNull()
  if (!name) throw new Error('Expected the editor name field')
  expect(document.activeElement).toBe(name)
  expect(container.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull()

  let escape!: KeyboardEvent
  await act(async () => {
    escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    name.dispatchEvent(escape)
  })
  await settle()

  expect(calls.filter(({ method }) => method === 'quirky.automations/cancelEditor')).toHaveLength(1)
  expect(calls.some(({ method }) => method === 'quirky.automations/saveEditor')).toBe(false)
  expect(refreshCalls).toBe(1)

  await act(async () => root.render(createElement(AutomationEditor, { ...props, state: { ...state, editor: null } })))
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
})
