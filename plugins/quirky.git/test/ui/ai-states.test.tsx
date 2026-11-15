import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { Fake as PanelFake } from './panel-support'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// These modules load ReactDOM-backed views; evaluate them only after Happy DOM is registered.
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, entry, failure, fakeContext, layoutFor, mountPanel, q, qa, settle, statusOf, type } = s
const { activate } = await import('../../src/ui')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Fake = PanelFake
type Mount = (element: HTMLElement, props: { input?: unknown }) => (() => void) | void

const ACTIONS = [
  'commitMessage',
  'fixCommitFailure',
  'fixPushFailure',
  'resolveConflicts',
  'branchSummary',
  'pullRequestDetails',
  'pullRequestReview',
  'reviewConversation',
  'branchName',
  'conversationName'
]
const agent = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, installed: true, enabled: true, isDefault: id === 'claude', canGenerate: true, ...extra
})
const AGENTS = { defaultAgent: 'claude', agents: [agent('claude', 'Claude'), agent('codex', 'Codex')] }

function recipe(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    agent: null,
    args: '',
    template: '{basePrompt}',
    launchOptions: {},
    ...extra,
    sources: { agent: 'default', args: 'default', template: 'default', launchOptions: 'default' }
  }
}

function catalog(agentId = 'claude', modelId = 'model', modelLabel = 'Model', discoverable = false) {
  return {
    agent: agentId,
    label: agentId,
    supported: true,
    discoverable,
    models: [{ id: modelId, label: modelLabel, description: null, options: [] }],
    unlisted: 'refuse',
    unlistedOptions: [],
    structured: false,
    extraArgs: null
  }
}

function deferred<T = unknown>() {
  return Promise.withResolvers<T>()
}

function aiFake(configure: (fake: Fake) => void = () => {}): Fake {
  const fake = fakeContext(layoutFor('feat'))
  fake.settings['ai-enabled'] = true
  fake.status = statusOf([entry('util.ts', 'staged')])
  fake.on('quirky.agents/list', () => AGENTS)
  fake.on('quirky.session/list', () => [])
  fake.on('quirky.agents/options', (params) => catalog(String(params.agent)))
  fake.on('quirky.git/aiRecipe', (params) => recipe(String(params.action)))
  fake.on('quirky.git/setAiRecipe', (params) => ({ saved: true, recipe: recipe(String(params.action)) }))
  fake.on('setting.set', (params) => {
    const name = String(params.id).replace(/^setting:quirky\.git\//, '')
    fake.settings[name] = params.value
    return {}
  })
  fake.on('quirky.git/aiFixPreview', (params) => ({ prompt: `Fix prompt for ${params.action}`, recipe: recipe(String(params.action)) }))
  fake.on('quirky.git/aiFix', () => ({ session: 's1', agent: 'claude', prompt: 'p', saved: false }))
  fake.on('quirky.git/generateCommitMessage', () => ({ message: 'Generated message', agent: 'claude' }))
  fake.on('quirky.git/cancelGenerate', () => ({ cancelled: true }))
  configure(fake)
  return fake
}

function mountSettings(fake: Fake, input: unknown = { worktree: 'feat' }) {
  let mount: Mount | undefined
  const provide = fake.context.provide
  fake.context.provide = (id, implementation) => {
    provide(id, implementation)
    if (id === 'view:quirky.git/ai-settings') mount = implementation as Mount
  }
  void activate(fake.context)
  if (!mount) throw new Error('activate did not provide the ai-settings view')
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  act(() => {
    cleanup = mount!(element, { input })
  })
  return {
    element,
    unmount: () => {
      act(() => cleanup?.())
      element.remove()
    }
  }
}

async function openSettings(configure: (fake: Fake) => void = () => {}, input?: unknown) {
  const fake = aiFake(configure)
  const mounted = mountSettings(fake, input)
  await settle()
  return { fake, ...mounted }
}

async function openPanel(configure: (fake: Fake) => void = () => {}) {
  const fake = aiFake(configure)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

function section(root: HTMLElement, action: string): HTMLElement {
  const element = q(root, `[data-action="${action}"]`)
  if (!element) throw new Error(`Missing AI action section: ${action}`)
  return element
}

function controlByLabel(root: ParentNode, label: string): HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement {
  const explicit = byLabel(root, label)
  if (explicit) return explicit as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement
  const wanted = label.toLocaleLowerCase()
  const associatedLabel = [...root.querySelectorAll<HTMLLabelElement>('label')].find((candidate) => {
    const text = candidate.textContent?.trim().toLocaleLowerCase() ?? ''
    return text === wanted || text.endsWith(` ${wanted}`)
  })
  const control = associatedLabel ? document.getElementById(associatedLabel.htmlFor) : null
  return (control && root.contains(control) ? control : null) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement
}
function inSection(root: HTMLElement, action: string, label: string) {
  return controlByLabel(section(root, action), label)
}
const message = (root: HTMLElement) => byLabel(root, 'Commit message') as HTMLTextAreaElement
const primary = (root: HTMLElement) => q(root, '.ui-split-button__primary') as HTMLButtonElement
const dialog = () => q(document.body, '[role="dialog"]')
const menuFor = (root: ParentNode, label: string) => qa(root, 'button[aria-haspopup="menu"]').find((button) => button.getAttribute('aria-label') === label) ?? null
const menuEntry = (label: string) => qa(document.body, '[role="menuitem"]').find((item) => item.textContent?.includes(label)) ?? null
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

async function openLaunch(configure: (fake: Fake) => void = () => {}) {
  const { fake, element, unmount } = await openPanel((f) => {
    f.on('quirky.git/commit', () => {
      throw failure('Lint failed during commit.', { reason: 'lint', summary: 'Lint failed during commit.', output: 'eslint found 2 problems' })
    })
    configure(f)
  })
  await type(message(element), 'Rename x')
  await click(primary(element))
  await click(menuFor(element, 'Choose an agent for this commit failure'))
  await click(buttonText(document.body, 'Customize launch...'))
  return { fake, element, unmount }
}

describe('AI settings shared states', () => {
  test('keeps all ten sections visible while recipes or agents are loading', async () => {
    const recipes = ACTIONS.map(() => deferred<unknown>())
    const agents = deferred<typeof AGENTS>()
    let recipeRead = 0
    const fake = aiFake((f) => {
      f.on('quirky.git/aiRecipe', () => recipes[recipeRead++]!.promise)
      f.on('quirky.agents/list', () => agents.promise)
    })
    const { element, unmount } = mountSettings(fake)
    await settle()

    const status = q(element, '[role="status"]')
    expect(status?.textContent).toBe('Loading AI settings…')
    expect(q(status!, '.ui-notice-line')).not.toBeNull()
    expect(qa(element, '[data-action]')).toHaveLength(10)
    expect(fake.called('quirky.git/aiRecipe')).toHaveLength(10)
    expect(qa(element, '[role="alert"]')).toHaveLength(0)

    await act(async () => recipes.forEach((read, index) => read.resolve(recipe(ACTIONS[index]!))))
    await settle()
    expect(q(element, '[role="status"]')?.textContent).toBe('Loading AI settings…')
    await act(async () => agents.resolve(AGENTS))
    await settle()
    expect(q(element, '[role="status"]')).toBeNull()
    expect(qa(element, '[role="alert"]')).toHaveLength(0)
    unmount()
  })

  test('shows one recipe InlineError, retries the ten reads, and keeps failures out of toasts', async () => {
    let failing = true
    const { fake, element, unmount } = await openSettings((f) => {
      f.on('quirky.git/aiRecipe', (params) => {
        if (failing) throw new Error('fixture read failed')
        return recipe(String(params.action), { args: `--${params.action}` })
      })
    })
    expect(qa(element, '.ui-inline-error__action')).toHaveLength(1)
    expect(q(element, '.ui-inline-error')?.textContent).toBe('Could not read the AI recipes: fixture read failedRetry')
    expect(fake.toasts).toEqual([])
    expect(fake.called('quirky.git/aiRecipe')).toHaveLength(10)

    failing = false
    await click(buttonText(q(element, '.ui-inline-error')!, 'Retry'))
    expect(fake.called('quirky.git/aiRecipe')).toHaveLength(20)
    expect(fake.called('quirky.git/aiRecipe').slice(10).map((call) => call.params)).toEqual(
      ACTIONS.map((action) => ({ worktree: 'feat', action }))
    )
    expect(qa(element, '.ui-inline-error')).toHaveLength(0)
    expect(inSection(element, 'commitMessage', 'Commit message CLI arguments').value).toBe('--commitMessage')
    unmount()
  })

  test('recipe rereads are latest-wins and a later failure preserves the last recipes', async () => {
    const reads = Array.from({ length: 20 }, () => deferred<unknown>())
    let count = 0
    const fake = aiFake((f) => f.on('quirky.git/aiRecipe', (params) => {
      const index = count++
      if (index >= reads.length) throw new Error('refresh failed')
      return reads[index]!.promise.then(() => recipe(String(params.action), {
        args: index < 10 ? '--older' : '--newest'
      }))
    }))
    const { element, unmount } = mountSettings(fake)
    await settle()
    await act(async () => fake.emit({ type: 'quirky.git/aiChanged', data: { repoId: null } }))
    await settle()
    expect(fake.called('quirky.git/aiRecipe')).toHaveLength(20)

    await act(async () => reads.slice(10).forEach((read) => read.resolve(undefined)))
    await settle()
    expect(inSection(element, 'commitMessage', 'Commit message CLI arguments').value).toBe('--newest')
    await act(async () => reads.slice(0, 10).forEach((read) => read.resolve(undefined)))
    await settle()
    expect(inSection(element, 'commitMessage', 'Commit message CLI arguments').value).toBe('--newest')
    expect(q(element, '[role="status"]')).toBeNull()

    await act(async () => fake.emit({ type: 'quirky.git/aiChanged', data: { repoId: null } }))
    await settle()
    expect(q(element, '.ui-inline-error')?.textContent).toBe('Could not read the AI recipes: refresh failedRetry')
    expect(inSection(element, 'commitMessage', 'Commit message CLI arguments').value).toBe('--newest')
    unmount()
  })

  test('reports an agent-list failure with Retry and retries once', async () => {
    let failing = true
    const { fake, element, unmount } = await openSettings((f) => f.on('quirky.agents/list', () => {
      if (failing) throw new Error('agents down')
      return AGENTS
    }))
    expect(q(element, '.ui-inline-error')?.textContent).toBe('Could not read the agents: agents downRetry')
    expect(fake.called('quirky.agents/list')).toHaveLength(1)
    expect(fake.toasts).toEqual([])

    failing = false
    await click(buttonText(q(element, '.ui-inline-error')!, 'Retry'))
    expect(fake.called('quirky.agents/list')).toHaveLength(2)
    expect(qa(element, '.ui-inline-error')).toHaveLength(0)
    expect([...inSection(element, 'commitMessage', 'Commit message agent').options].map((option) => option.textContent)).toContain('Codex')
    unmount()
  })

  test('agent-list reads are latest-wins and failures preserve the last successful list', async () => {
    const older = deferred<typeof AGENTS>()
    const newest = deferred<typeof AGENTS>()
    let count = 0
    const fake = aiFake((f) => f.on('quirky.agents/list', () => {
      count += 1
      if (count === 1) return older.promise
      if (count === 2) return newest.promise
      throw new Error('agents down')
    }))
    const { element, unmount } = mountSettings(fake)
    await settle()
    await act(async () => fake.emit({ type: 'quirky.agents/changed' } as never))
    await settle()
    await act(async () => newest.resolve({ defaultAgent: 'codex', agents: [agent('codex', 'Newest Codex')] }))
    await settle()
    await act(async () => older.resolve({ defaultAgent: 'claude', agents: [agent('claude', 'Older Claude')] }))
    await settle()
    const agentSelect = inSection(element, 'commitMessage', 'Commit message agent')
    expect([...agentSelect.options].map((option) => option.textContent)).toContain('Newest Codex')
    expect([...agentSelect.options].map((option) => option.textContent)).not.toContain('Older Claude')

    await act(async () => fake.emit({ type: 'quirky.agents/changed' } as never))
    await settle()
    expect(q(element, '.ui-inline-error')?.textContent).toBe('Could not read the agents: agents downRetry')
    expect([...agentSelect.options].map((option) => option.textContent)).toContain('Newest Codex')
    unmount()
  })

  test('shows the missing-worktree empty state and only the required conversation empty state', async () => {
    const missing = aiFake()
    missing.setLayout(layoutFor(null))
    const missingView = mountSettings(missing, {})
    expect(q(missingView.element, '.ui-empty-state')?.textContent).toBe('Open a worktree first.')
    expect(missing.called('quirky.git/aiRecipe')).toHaveLength(0)
    missingView.unmount()
    document.body.innerHTML = ''

    const { element, unmount } = await openSettings()
    expect(q(section(element, 'conversationName'), '.ui-empty-state')?.textContent).toBe('No captured conversations in this worktree.')
    expect(q(section(element, 'branchName'), '.ui-empty-state')).toBeNull()
    expect(buttonText(section(element, 'conversationName'), 'Generate conversation name')!.disabled).toBe(true)
    unmount()
  })

  test('session errors use InlineError Retry and retry only that name section', async () => {
    let failing = true
    const { fake, element, unmount } = await openSettings((f) => f.on('quirky.session/list', () => {
      if (failing) throw new Error('sessions failed')
      return []
    }))
    expect(fake.called('quirky.session/list')).toHaveLength(2)
    for (const action of ['branchName', 'conversationName']) {
      expect(q(section(element, action), '.ui-inline-error')?.textContent).toBe('sessions failedRetry')
    }

    failing = false
    await click(buttonText(section(element, 'conversationName'), 'Retry'))
    expect(fake.called('quirky.session/list')).toHaveLength(3)
    expect(q(section(element, 'conversationName'), '.ui-inline-error')).toBeNull()
    expect(q(section(element, 'branchName'), '.ui-inline-error')).not.toBeNull()
    expect(q(section(element, 'conversationName'), '.ui-empty-state')?.textContent).toBe('No captured conversations in this worktree.')
    unmount()
  })

  test('keeps the last suggested name when a provider failure becomes InlineError', async () => {
    let failing = false
    const { element, unmount } = await openSettings((f) => {
      f.on('quirky.git/aiName', () => {
        if (failing) throw new Error('provider unavailable')
        return { name: 'feature/metadata-owner' }
      })
    })
    const branch = section(element, 'branchName')
    await click(buttonText(branch, 'Generate branch name'))
    expect(inSection(element, 'branchName', 'Suggested name').value).toBe('feature/metadata-owner')

    failing = true
    await click(buttonText(branch, 'Generate branch name'))
    expect(q(branch, '.ui-inline-error')?.textContent).toBe('provider unavailable')
    expect(inSection(element, 'branchName', 'Suggested name').value).toBe('feature/metadata-owner')
    unmount()
  })

  test('save failures are error toasts and a failed setting toggle returns to the stored value', async () => {
    const recipeFailure = await openSettings((f) => f.on('quirky.git/setAiRecipe', () => { throw new Error('save refused') }))
    await type(inSection(recipeFailure.element, 'commitMessage', 'Commit message CLI arguments'), '--fast')
    expect(recipeFailure.fake.toasts).toEqual([['Could not save the AI recipe', 'save refused']])
    expect(recipeFailure.fake.toastOptions).toEqual([{ kind: 'error' }])
    recipeFailure.unmount()
    document.body.innerHTML = ''

    const settingFailure = await openSettings((f) => f.on('setting.set', () => { throw new Error('setting refused') }))
    const toggle = byLabel(settingFailure.element, 'Show Source Control AI actions') as HTMLInputElement
    await click(toggle)
    expect(toggle.checked).toBe(true)
    expect(settingFailure.fake.toasts).toEqual([['Could not change the setting', 'setting refused']])
    expect(settingFailure.fake.toastOptions).toEqual([{ kind: 'error' }])
    settingFailure.unmount()
  })
})

describe('AI launch and generation shared states', () => {
  test('preview loading uses NoticeLine and Retry preserves the action payload and Cancel', async () => {
    const first = deferred<unknown>()
    let reads = 0
    const { fake, unmount } = await openLaunch((f) => f.on('quirky.git/aiFixPreview', (params) => {
      reads += 1
      return reads === 1 ? first.promise : { prompt: 'Retried prompt', recipe: recipe(String(params.action)) }
    }))
    expect(q(dialog()!, '[role="status"]')?.textContent).toBe('Loading…')
    expect(q(dialog()!, '[role="status"] .ui-notice-line')).not.toBeNull()

    await act(async () => first.reject(new Error('preview failed')))
    await settle()
    expect(q(dialog()!, '.ui-inline-error')?.textContent).toBe('preview failedRetry')
    expect(buttonText(dialog()!, 'Cancel')).not.toBeNull()
    await click(buttonText(dialog()!, 'Retry'))
    expect(fake.called('quirky.git/aiFixPreview').map((call) => call.params)).toEqual([
      { worktree: 'feat', action: 'fixCommitFailure' },
      { worktree: 'feat', action: 'fixCommitFailure' }
    ])
    expect(byLabel(dialog()!, 'Prompt template')).not.toBeNull()
    unmount()
  })

  test('launch agent state distinguishes pending, read failure and a successful empty list', async () => {
    const list = deferred<typeof AGENTS>()
    const pending = await openLaunch((f) => f.on('quirky.agents/list', () => list.promise))
    expect(q(dialog()!, '[role="status"]')?.textContent).toBe('Detecting agents...')
    expect(q(dialog()!, '[role="status"] .ui-notice-line')).not.toBeNull()
    expect(buttonText(dialog()!, 'Start agent')!.disabled).toBe(true)
    await click(buttonText(dialog()!, 'Start agent'))
    expect(pending.fake.called('quirky.git/aiFix')).toEqual([])
    await act(async () => list.resolve({ defaultAgent: 'auto', agents: [] }))
    await settle()
    const startWithNoAgents = buttonText(dialog()!, 'Start agent')!
    expect(startWithNoAgents.disabled).toBe(true)
    await click(startWithNoAgents)
    expect(pending.fake.called('quirky.git/aiFix')).toEqual([])
    pending.unmount()
    document.body.innerHTML = ''

    let failing = true
    const failed = await openLaunch((f) => f.on('quirky.agents/list', () => {
      if (failing) throw new Error('agents down')
      return { defaultAgent: 'auto', agents: [] }
    }))
    const beforeRetry = failed.fake.called('quirky.agents/list').length
    expect(q(dialog()!, '.ui-inline-error')?.textContent).toBe('Could not read the agents: agents downRetry')
    const start = buttonText(dialog()!, 'Start agent') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await click(start)
    expect(failed.fake.called('quirky.git/aiFix')).toEqual([])
    failing = false
    await click(buttonText(q(dialog()!, '.ui-inline-error')!, 'Retry'))
    expect(failed.fake.called('quirky.agents/list')).toHaveLength(beforeRetry + 1)
    expect(q(dialog()!, '.ui-inline-error')).toBeNull()
    expect(q(dialog()!, '.ui-empty-state')?.textContent).toBe('No enabled agents')
    failed.unmount()
  })

  test('launch refusal keeps the edited draft, shows InlineError and re-enables Start', async () => {
    const { fake, unmount } = await openLaunch((f) => f.on('quirky.git/aiFix', () => { throw new Error('fixture launch refused') }))
    await type(byLabel(dialog()!, 'Prompt template') as HTMLTextAreaElement, 'changed prompt')
    await click(buttonText(dialog()!, 'Save & start agent'))
    expect(dialog()).not.toBeNull()
    expect(controlByLabel(dialog()!, 'Prompt template').value).toBe('changed prompt')
    expect(q(dialog()!, '.ui-inline-error')?.textContent).toBe('fixture launch refused')
    expect(buttonText(dialog()!, 'Save & start agent')!.disabled).toBe(false)
    expect(fake.called('quirky.git/aiFix')).toHaveLength(1)
    unmount()
  })

  test('catalog errors retry the same agent and host; refresh failures are alerts, not advisories', async () => {
    let optionReads = 0
    let discoveryFails = true
    const { fake, unmount } = await openLaunch((f) => {
      f.on('quirky.git/aiFixPreview', (params) => ({ prompt: 'Fix prompt', recipe: recipe(String(params.action), { agent: 'codex' }) }))
      f.on('quirky.agents/options', () => {
        optionReads += 1
        if (optionReads === 1) throw new Error('catalog down')
        return catalog('codex', 'gpt-5.5', 'GPT-5.5', true)
      })
      f.on('quirky.agents/discoverModels', () => {
        if (discoveryFails) throw new Error('discovery failed')
        return { authoritative: false, reason: 'Kept saved choices.' }
      })
    })
    expect(q(dialog()!, '.ui-inline-error')?.textContent).toBe('Could not load this agent’s launch choices: catalog downRetry')
    await click(buttonText(q(dialog()!, '.ui-inline-error')!, 'Retry'))
    expect(fake.called('quirky.agents/options').map((call) => call.params)).toEqual([
      { agent: 'codex', host: 'local' },
      { agent: 'codex', host: 'local' }
    ])
    expect(buttonText(dialog()!, 'Refresh models')).not.toBeNull()

    await click(buttonText(dialog()!, 'Refresh models'))
    expect(q(dialog()!, '.ui-inline-error')?.textContent).toBe('discovery failed')
    expect(q(dialog()!, '[role="alert"]')).not.toBeNull()
    discoveryFails = false
    await click(buttonText(dialog()!, 'Refresh models'))
    expect(q(dialog()!, '[role="alert"]')).toBeNull()
    expect(dialog()!.textContent).toContain('Kept saved choices.')
    unmount()
  })

  test('catalog requests are latest-wins when the launch agent changes', async () => {
    const claude = deferred<unknown>()
    const codex = deferred<unknown>()
    const { fake, unmount } = await openLaunch((f) => {
      f.on('quirky.agents/options', (params) => params.agent === 'claude' ? claude.promise : codex.promise)
    })
    expect(q(dialog()!, '[role="status"]')?.textContent).toBe('Loading model and effort choices…')
    expect(q(dialog()!, '[role="status"] .ui-notice-line')).not.toBeNull()
    const options = fake.called('quirky.agents/options')
    expect(options.map((call) => call.params)).toContainEqual({ agent: 'claude', host: 'local' })
    await choose(byLabel(dialog()!, 'Agent') as HTMLSelectElement, 'codex')
    expect(fake.called('quirky.agents/options').map((call) => call.params)).toContainEqual({ agent: 'codex', host: 'local' })

    await act(async () => codex.resolve(catalog('codex', 'codex-model', 'Codex model')))
    await settle()
    await act(async () => claude.resolve(catalog('claude', 'claude-model', 'Claude old model')))
    await settle()
    const model = controlByLabel(dialog()!, 'Model') as HTMLSelectElement
    expect([...model.options].map((option) => option.textContent)).toContain('Codex model')
    expect([...model.options].map((option) => option.textContent)).not.toContain('Claude old model')
    unmount()
  })

  test('Generate dialog renders agent loading, error/retry and empty states without an empty option', async () => {
    const pendingAgents = deferred<typeof AGENTS>()
    const pending = await openPanel((f) => f.on('quirky.agents/list', () => pendingAgents.promise))
    await click(menuFor(pending.element, 'Commit message options'))
    await click(menuEntry('Choose agent…'))
    expect(q(dialog()!, '[role="status"]')?.textContent).toBe('Detecting agents...')
    expect(buttonText(dialog()!, 'Generate')!.disabled).toBe(true)
    expect(q(dialog()!, 'option')?.textContent).not.toBe('No enabled agents')
    await act(async () => pendingAgents.resolve(AGENTS))
    await settle()
    pending.unmount()
    document.body.innerHTML = ''

    let failing = true
    const failed = await openPanel((f) => f.on('quirky.agents/list', () => {
      if (failing) throw new Error('agents down')
      return { defaultAgent: 'auto', agents: [] }
    }))
    await click(menuFor(failed.element, 'Commit message options'))
    await click(menuEntry('Choose agent…'))
    expect(q(dialog()!, '.ui-inline-error')?.textContent).toBe('Could not read the agents: agents downRetry')
    expect(buttonText(dialog()!, 'Generate')!.disabled).toBe(true)
    const priorCalls = failed.fake.called('quirky.agents/list').length
    failing = false
    await click(buttonText(q(dialog()!, '.ui-inline-error')!, 'Retry'))
    expect(failed.fake.called('quirky.agents/list')).toHaveLength(priorCalls + 1)
    expect(q(dialog()!, '.ui-inline-error')).toBeNull()
    expect(q(dialog()!, '.ui-empty-state')?.textContent).toBe('No enabled agents')
    expect(q(dialog()!, 'option')?.textContent).not.toBe('No enabled agents')
    expect(buttonText(dialog()!, 'Generate')!.disabled).toBe(true)
    failed.unmount()
  })

  test('a failed Stop shows an error-kind toast and the stopped run stays silent', async () => {
    const run = deferred<unknown>()
    const { fake, element, unmount } = await openPanel((f) => {
      f.on('quirky.git/generateCommitMessage', () => run.promise)
      f.on('quirky.git/cancelGenerate', () => { throw new Error('stop refused') })
    })
    await click(byLabel(element, 'Generate commit message with AI'))
    await click(byLabel(element, 'Stop generating commit message'))
    expect(fake.toasts).toEqual([['Could not stop the generation', 'stop refused']])
    expect(fake.toastOptions).toEqual([{ kind: 'error' }])
    run.reject(failure('Generation was stopped.', { reason: 'cancelled' }))
    await settle()
    expect(fake.toasts).toEqual([['Could not stop the generation', 'stop refused']])
    unmount()
  })
})
