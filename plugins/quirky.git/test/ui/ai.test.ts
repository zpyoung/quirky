import { GitHubReviewStatus } from '../../src/panel/GitHubReview'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, entry, failure, fakeContext, layoutFor, mountPanel, press, q, qa, settle, statusOf, type } = s
const { activate } = await import('../../src/ui')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Fake = ReturnType<typeof fakeContext>

const agent = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, installed: true, enabled: true, isDefault: id === 'claude', canGenerate: true, ...extra })
const AGENTS = { defaultAgent: 'claude', agents: [agent('claude', 'Claude'), agent('codex', 'Codex')] }

const recipe = (action: string, extra: Record<string, unknown> = {}) => {
  const { sources, ...fields } = extra
  return {
    action,
    agent: null,
    args: '',
    template: '{basePrompt}',
    launchOptions: {},
    ...fields,
    sources: { agent: 'default', args: 'default', template: 'default', launchOptions: 'default', ...(sources as Record<string, string> | undefined) }
  }
}

const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' }
]
const option = { id: 'effort', label: 'Effort', type: 'select', choices: EFFORT_CHOICES }
const SAVED = {
  agent: 'codex',
  args: '--model gpt-5.4',
  template: `{basePrompt}
Keep the change small.`,
  launchOptions: { model: 'gpt-5.4', optionValues: { effort: 'high' } },
  sources: { agent: 'repo', args: 'repo', template: 'repo', launchOptions: 'repo' }
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The AI daemon methods the panel needs, answered with defaults the test can override afterwards. */
function aiFake(configure: (fake: Fake) => void = () => {}): Fake {
  const fake = fakeContext(layoutFor('feat'))
  fake.settings['ai-enabled'] = true
  fake.status = statusOf([entry('util.ts', 'staged')])
  fake.on('quirky.agents/list', () => AGENTS)
  fake.on('quirky.session/list', () => [])
  fake.on('quirky.agents/options', (params) => ({
    agent: params.agent,
    label: params.agent === 'codex' ? 'Codex' : 'Claude',
    supported: true,
    models: (params.agent === 'codex'
      ? [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }]
      : [{ id: 'fable', label: 'Fable' }, { id: 'opus', label: 'Opus' }, { id: 'haiku', label: 'Haiku', noEffort: true }])
      .map((model) => ({ id: model.id, label: model.label, description: null, options: 'noEffort' in model ? [] : [option] })),
    unlisted: 'accept',
    unlistedOptions: [option],
    structured: false,
    extraArgs: {
      supported: true,
      allowed: '--model, --effort, -c model_reasoning_effort=…',
      placeholder: '--model opus --effort high',
      message: null
    }
  }))
  fake.on('quirky.git/aiRecipe', (params) => recipe(params.action as string))
  fake.on('quirky.git/generateCommitMessage', () => ({ message: 'Rename x to count\n\nClearer name.', subject: 'Rename x to count', body: 'Clearer name.', agent: 'claude' }))
  fake.on('quirky.git/cancelGenerate', () => ({ cancelled: true }))
  fake.on('quirky.git/aiFix', (params) => ({ session: 's1', agent: (params.agent as string | undefined) ?? 'claude', prompt: 'p', saved: params.save !== undefined }))
  fake.on('quirky.git/aiFixPreview', (params) => ({ prompt: `Fix prompt for ${params.action}`, recipe: recipe(params.action as string) }))
  configure(fake)
  return fake
}

async function open(configure?: (fake: Fake) => void) {
  const fake = aiFake(configure)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

const sparkle = (element: HTMLElement) => byLabel(element, 'Generate commit message with AI') as HTMLButtonElement | null
const stop = (element: HTMLElement) => byLabel(element, 'Stop generating commit message') as HTMLButtonElement | null
const message = (element: HTMLElement) => byLabel(element, 'Commit message') as HTMLTextAreaElement
const dialog = () => q(document.body, '[role="dialog"]')
const primary = (element: HTMLElement) => q(element, '.scm-primary') as HTMLButtonElement

const up = (ahead: number, behind: number) => ({ hasUpstream: true, name: 'origin/zoe/feat', sha: 'b'.repeat(40), ahead, behind, behindPatchEquivalent: null })

const blocked = (reason: 'lint' | 'hook', output = 'eslint found 2 problems') =>
  failure('Lint failed during commit.', { reason, summary: 'Lint failed during commit.', output })

describe('NA-24: the sparkle button', () => {
  test('is absent while Source Control AI actions are off', async () => {
    const { element, unmount } = await open((f) => void (f.settings['ai-enabled'] = false))
    expect(sparkle(element)).toBeNull()
    unmount()
  })

  test('(a) nothing staged: disabled, asks to stage a file', async () => {
    const { element, unmount } = await open((f) => void (f.status = statusOf([entry('util.ts', 'unstaged')])))
    expect(sparkle(element)?.disabled).toBe(true)
    expect(sparkle(element)?.title).toBe('Stage at least one file to generate a message.')
    unmount()
  })

  test('(b) a message typed: disabled, asks to clear it', async () => {
    const { element, unmount } = await open()
    await type(message(element), 'Rename x')
    expect(sparkle(element)?.disabled).toBe(true)
    expect(sparkle(element)?.title).toBe('Clear the message to regenerate.')
    unmount()
  })

  test('(f) staged and empty: enabled with Orca\'s tooltip', async () => {
    const { element, unmount } = await open()
    expect(sparkle(element)?.disabled).toBe(false)
    expect(sparkle(element)?.title).toBe('ai commit msg')
    expect(stop(element)).toBeNull()
    unmount()
  })

  test('(g) every agent disabled: the tooltip points at the settings and a click opens the AI defaults view', async () => {
    const { fake, element, unmount } = await open((f) => f.on('quirky.agents/list', () => ({ defaultAgent: 'claude', agents: [agent('claude', 'Claude', { enabled: false })] })))
    expect(sparkle(element)?.title).toBe('Pick an agent in Source Control AI settings.')
    await click(sparkle(element))
    expect(fake.views).toEqual([{ id: 'view:quirky.git/ai-settings', input: { worktree: 'feat' } }])
    expect(fake.called('quirky.git/generateCommitMessage')).toEqual([])
    unmount()
  })

  test('an agent without a one-shot shape does not count as one to pick', async () => {
    const { element, unmount } = await open((f) => f.on('quirky.agents/list', () => ({ defaultAgent: 'claude', agents: [agent('aider', 'Aider', { canGenerate: false })] })))
    expect(sparkle(element)?.title).toBe('Pick an agent in Source Control AI settings.')
    unmount()
  })

  test('(d) generating: a spinner and a stop square that cancels the run and leaves the box alone', async () => {
    const run = deferred()
    const { fake, element, unmount } = await open((f) => {
      f.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, { agent: 'claude' }))
      f.on('quirky.git/generateCommitMessage', () => run.promise)
    })
    await click(sparkle(element))
    expect(sparkle(element)?.disabled).toBe(true)
    expect(sparkle(element)?.title).toBe('Generating commit message…')
    expect(q(sparkle(element)!, '.scm-spinner')).not.toBeNull()
    expect(stop(element)?.title).toBe('Generating commit message. Click to stop.')

    await click(stop(element))
    expect(fake.called('quirky.git/cancelGenerate')[0]?.params).toEqual({ worktree: 'feat' })
    run.reject(failure('Generation was stopped.', { reason: 'cancelled' }))
    await settle()
    expect(message(element).value).toBe('')
    expect(fake.toasts).toEqual([])
    expect(stop(element)).toBeNull()
    expect(sparkle(element)?.disabled).toBe(false)
    unmount()
  })

  test('(e) a commit running: "Commit in progress…"', async () => {
    const commit = deferred()
    const { element, unmount } = await open((f) => f.on('quirky.git/commit', () => commit.promise))
    await type(message(element), 'Rename x')
    await click(primary(element))
    expect(sparkle(element)?.disabled).toBe(true)
    expect(sparkle(element)?.title).toBe('Commit in progress…')
    commit.resolve({ sha: 'd'.repeat(40) })
    await settle()
    unmount()
  })
})

describe('NA-25: generating a message', () => {
  test('with no recipe the sparkle opens the Generate Commit Message dialog, which runs once and saves nothing', async () => {
    const { fake, element, unmount } = await open()
    await click(sparkle(element))
    expect(dialog()?.getAttribute('aria-label')).toBe('Generate Commit Message')
    expect(dialog()?.textContent).toContain('Choose the agent and command template for this run.')
    expect((byLabel(dialog()!, 'Agent') as HTMLSelectElement).value).toBe('claude')
    expect((byLabel(dialog()!, 'Command template') as HTMLTextAreaElement).value).toBe('{basePrompt}')
    expect(fake.called('quirky.git/generateCommitMessage')).toEqual([])

    await type(byLabel(dialog()!, 'Command template') as HTMLTextAreaElement, '{basePrompt}\nUse Conventional Commits.')
    await click(buttonText(dialog()!, 'Generate'))
    expect(dialog()).toBeNull()
    expect(fake.called('quirky.git/generateCommitMessage').map((c) => c.params)).toEqual([
      { worktree: 'feat', agent: 'claude', template: '{basePrompt}\nUse Conventional Commits.' }
    ])
    expect(message(element).value).toBe('Rename x to count\n\nClearer name.')
    expect(fake.called('quirky.git/setAiRecipe')).toEqual([])
    unmount()
  })

  test('the dialog can pick another agent, and Cancel runs nothing', async () => {
    const { fake, element, unmount } = await open()
    await click(sparkle(element))
    await click(buttonText(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()
    await click(sparkle(element))
    const select = byLabel(dialog()!, 'Agent') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Claude', 'Codex'])
    await act(async () => {
      select.value = 'codex'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(buttonText(dialog()!, 'Generate'))
    expect(fake.called('quirky.git/generateCommitMessage')[0]?.params).toMatchObject({ agent: 'codex' })
    unmount()
  })

  test('with a configured recipe the sparkle runs directly', async () => {
    for (const saved of [{ agent: 'codex' }, { args: '--model haiku' }, { template: '{basePrompt}\nUse Conventional Commits.' }]) {
      document.body.innerHTML = ''
      const { fake, element, unmount } = await open((f) => f.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, saved)))
      await click(sparkle(element))
      expect(dialog()).toBeNull()
      expect(fake.called('quirky.git/aiRecipe')[0]?.params).toEqual({ worktree: 'feat', action: 'commitMessage' })
      expect(fake.called('quirky.git/generateCommitMessage').map((c) => c.params)).toEqual([{ worktree: 'feat' }])
      expect(message(element).value).toBe('Rename x to count\n\nClearer name.')
      unmount()
    }
  })

  test('a configured custom command runs from the sparkle with no catalog agent able to generate', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.settings['ai-custom-command'] = 'my-gen'
      f.on('quirky.agents/list', () => ({ defaultAgent: 'claude', agents: [] }))
      f.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, { agent: 'custom' }))
    })
    expect(sparkle(element)?.title).toBe('ai commit msg')
    await click(sparkle(element))
    expect(fake.views).toEqual([])
    expect(fake.called('quirky.git/generateCommitMessage').map((c) => c.params)).toEqual([{ worktree: 'feat' }])
    expect(message(element).value).toBe('Rename x to count\n\nClearer name.')
    unmount()
  })

  test('with only a custom command and no recipe the dialog offers Custom command', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.settings['ai-custom-command'] = 'my-gen'
      f.on('quirky.agents/list', () => ({ defaultAgent: 'claude', agents: [] }))
    })
    await click(sparkle(element))
    expect((byLabel(dialog()!, 'Agent') as HTMLSelectElement).value).toBe('custom')
    await click(buttonText(dialog()!, 'Generate'))
    expect(fake.called('quirky.git/generateCommitMessage')[0]?.params).toMatchObject({ agent: 'custom' })
    unmount()
  })

  test('clicks while the recipe lookup is pending start one generation, and its controls stay', async () => {
    const lookup = deferred()
    const run = deferred()
    let requests = 0
    const { fake, element, unmount } = await open((f) => {
      f.on('quirky.git/aiRecipe', () => lookup.promise)
      f.on('quirky.git/generateCommitMessage', () => {
        requests += 1
        if (requests > 1) throw failure('A commit message is already being generated.', { reason: 'busy' })
        return run.promise
      })
    })
    const button = sparkle(element)
    await click(button)
    await click(button)
    await act(async () => lookup.resolve(recipe('commitMessage', { agent: 'claude' })))
    await settle()
    await click(button)
    expect(requests).toBe(1)
    expect(fake.called('quirky.git/aiRecipe').length).toBe(1)
    expect(fake.toasts).toEqual([])
    expect(stop(element)).not.toBeNull()
    expect(sparkle(element)?.disabled).toBe(true)
    run.resolve({ message: 'First result' })
    await settle()
    expect(message(element).value).toBe('First result')
    expect(stop(element)).toBeNull()
    unmount()
  })

  test('a failed run toasts the daemon message and leaves the box empty', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, { agent: 'claude' }))
      f.on('quirky.git/generateCommitMessage', () => {
        throw failure('Claude failed: quota exceeded', { reason: 'failed' })
      })
    })
    await click(sparkle(element))
    expect(fake.toasts.map(([, body]) => body)).toEqual(['Claude failed: quota exceeded'])
    expect(message(element).value).toBe('')
    expect(sparkle(element)?.disabled).toBe(false)
    unmount()
  })
})

describe('NA-30: typing during a run keeps the box', () => {
  const configured = (run: ReturnType<typeof deferred>) => (f: Fake) => {
    f.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, { agent: 'claude' }))
    f.on('quirky.git/generateCommitMessage', () => run.promise)
  }
  const result = { message: 'Generated', subject: 'Generated', body: '', agent: 'claude' }

  test('with no typing the result lands', async () => {
    const run = deferred()
    const { element, unmount } = await open(configured(run))
    await click(sparkle(element))
    run.resolve(result)
    await settle()
    expect(message(element).value).toBe('Generated')
    unmount()
  })

  test('typing keeps what was typed', async () => {
    const run = deferred()
    const { element, unmount } = await open(configured(run))
    await click(sparkle(element))
    await type(message(element), 'mine')
    run.resolve(result)
    await settle()
    expect(message(element).value).toBe('mine')
    unmount()
  })

  test('typing and deleting again still keeps the box, empty', async () => {
    const run = deferred()
    const { element, unmount } = await open(configured(run))
    await click(sparkle(element))
    await type(message(element), 'x')
    await type(message(element), '')
    run.resolve(result)
    await settle()
    expect(message(element).value).toBe('')
    unmount()
  })

  test('a result that arrives after Stop is dropped', async () => {
    const run = deferred()
    const { element, unmount } = await open(configured(run))
    await click(sparkle(element))
    await click(stop(element))
    run.resolve(result)
    await settle()
    expect(message(element).value).toBe('')
    unmount()
  })
})

const commitBlocked = (reason: 'lint' | 'hook' = 'lint') => (f: Fake) => {
  f.on('quirky.git/commit', () => {
    throw blocked(reason)
  })
}

async function blockCommit(element: HTMLElement) {
  await type(message(element), 'Rename x')
  await click(primary(element))
}

describe('NA-33: AI Fix on the Commit blocked card', () => {
  test('the card has the split button, whose primary starts the default agent and toasts', async () => {
    const { fake, element, unmount } = await open(commitBlocked())
    await blockCommit(element)
    const card = q(element, '.scm-card-blocked')!
    const fix = byLabel(card, 'Start the default AI agent to fix this commit failure')
    expect(fix?.textContent).toBe('AI Fix')
    expect(fix?.title).toBe('Fix commit failure with AI')
    expect(byLabel(card, 'Choose an agent for this commit failure')).not.toBeNull()

    await click(fix)
    expect(fake.called('quirky.git/aiFix').map((c) => c.params)).toEqual([{ worktree: 'feat', action: 'fixCommitFailure' }])
    expect(fake.toasts).toEqual([['Started an AI agent for the commit failure.', '']])
    unmount()
  })

  test('a refused launch toasts the daemon message', async () => {
    const { fake, element, unmount } = await open((f) => {
      commitBlocked()(f)
      f.on('quirky.git/aiFix', () => {
        throw failure('No enabled AI agents. Configure agents in Settings.', { reason: 'no-agents' })
      })
    })
    await blockCommit(element)
    await click(byLabel(element, 'Start the default AI agent to fix this commit failure'))
    expect(fake.toasts.map(([, body]) => body)).toEqual(['No enabled AI agents. Configure agents in Settings.'])
    unmount()
  })

  test('the Commit Failed details have "Fix with AI" beside Close', async () => {
    const { fake, element, unmount } = await open(commitBlocked())
    await blockCommit(element)
    await click(buttonText(q(element, '.scm-card-blocked')!, 'Details'))
    expect(dialog()?.getAttribute('aria-label')).toBe('Commit Failed')
    expect(qa(dialog()!, '.dialog-actions button').map((b) => b.textContent)).toEqual(['Fix with AI', 'Close'])
    await click(buttonText(dialog()!, 'Fix with AI'))
    expect(fake.called('quirky.git/aiFix').map((c) => c.params)).toEqual([{ worktree: 'feat', action: 'fixCommitFailure' }])
    expect(dialog()).toBeNull()
    unmount()
  })

  test('with the setting off the card and its details show no AI buttons', async () => {
    const { element, unmount } = await open((f) => {
      commitBlocked()(f)
      f.settings['ai-enabled'] = false
    })
    await blockCommit(element)
    expect(q(element, '.scm-ai-fix')).toBeNull()
    await click(buttonText(q(element, '.scm-card-blocked')!, 'Details'))
    expect(buttonText(dialog()!, 'Fix with AI')).toBeUndefined()
    unmount()
  })
})

describe('NA-35: AI Fix on the Push blocked card', () => {
  const pushBlocked = (f: Fake) => {
    f.status = statusOf([], { upstreamStatus: up(1, 0) })
    f.on('quirky.git/push', () => {
      throw failure('Pre-push hook failed.', { reason: 'hook', summary: 'Pre-push hook failed.', output: 'husky - pre-push hook exited with code 1' })
    })
  }

  test('the card starts an agent for the push failure', async () => {
    const { fake, element, unmount } = await open(pushBlocked)
    await click(primary(element))
    const card = q(element, '.scm-card-blocked')!
    expect(card.textContent).toContain('Push blocked')
    await click(byLabel(card, 'Start the default AI agent to fix this push failure'))
    expect(fake.called('quirky.git/aiFix').map((c) => c.params)).toEqual([{ worktree: 'feat', action: 'fixPushFailure' }])
    expect(fake.toasts).toEqual([['Started an AI agent for the push failure.', '']])
    expect(byLabel(card, 'Choose an agent for this push failure')).not.toBeNull()
    unmount()
  })

  test('the Push Failed details have "Fix with AI"', async () => {
    const { fake, element, unmount } = await open(pushBlocked)
    await click(primary(element))
    await click(buttonText(q(element, '.scm-card-blocked')!, 'Details'))
    expect(dialog()?.getAttribute('aria-label')).toBe('Push Failed')
    await click(buttonText(dialog()!, 'Fix with AI'))
    expect(fake.called('quirky.git/aiFix').map((c) => c.params)).toEqual([{ worktree: 'feat', action: 'fixPushFailure' }])
    unmount()
  })
})

describe('NA-36: Resolve with AI on the conflict card', () => {
  const conflict = (path: string) => entry(path, 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })

  test('shows with unresolved conflicts and starts an agent for the conflicts', async () => {
    const { fake, element, unmount } = await open((f) => void (f.status = statusOf([conflict('a.ts')], { operation: 'merge' })))
    const card = q(element, '.scm-card-conflict')!
    const resolve = buttonText(card, 'Resolve with AI')
    expect(resolve).toBeDefined()
    expect(byLabel(card, 'Choose an agent to resolve these conflicts')).not.toBeNull()
    await click(resolve)
    expect(fake.called('quirky.git/aiFix').map((c) => c.params)).toEqual([{ worktree: 'feat', action: 'resolveConflicts' }])
    expect(fake.toasts).toEqual([['Started an AI agent for the conflicts.', '']])
    unmount()
  })

  test('is not on the banner once no conflict remains, nor with the setting off', async () => {
    const quiet = await open((f) => void (f.status = statusOf([entry('a.ts', 'staged')], { operation: 'merge' })))
    expect(buttonText(quiet.element, 'Resolve with AI')).toBeUndefined()
    quiet.unmount()
    document.body.innerHTML = ''
    const off = await open((f) => {
      f.status = statusOf([conflict('a.ts')], { operation: 'merge' })
      f.settings['ai-enabled'] = false
    })
    expect(buttonText(off.element, 'Resolve with AI')).toBeUndefined()
    off.unmount()
  })
})

describe('NA-37: Customize launch', () => {
  async function openLaunch(configure: (f: Fake) => void = () => {}) {
    const mounted = await open((f) => {
      commitBlocked()(f)
      configure(f)
    })
    await blockCommit(mounted.element)
    await click(byLabel(mounted.element, 'Choose an agent for this commit failure'))
    await click(buttonText(document.body, 'Customize launch...'))
    return mounted
  }
  const field = (label: string) => byLabel(dialog()!, label) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement
  const choose = (select: HTMLSelectElement, value: string) =>
    act(async () => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

  test('the chevron offers Customize launch... and the dialog is prefilled from the preview', async () => {
    const { fake, unmount } = await openLaunch()
    expect(dialog()?.getAttribute('aria-label')).toBe('Fix Commit Failure With AI')
    expect(dialog()?.textContent).toContain('Review and edit the full command input before starting an agent.')
    expect(fake.called('quirky.git/aiFixPreview')[0]?.params).toEqual({ worktree: 'feat', action: 'fixCommitFailure' })
    expect(field('Agent').value).toBe('claude')
    expect(field('Prompt template').value).toBe('Fix prompt for fixCommitFailure')
    expect(field('CLI arguments').value).toBe('')
    expect(dialog()?.textContent).toContain('Save for')
    expect([...field('Save for').options].map((o) => o.textContent)).toEqual(['This repository', 'All repositories'])
    expect(buttonText(dialog()!, 'Start agent')).toBeDefined()
    expect(buttonText(dialog()!, 'Cancel')).toBeDefined()
    expect(dialog()?.textContent).not.toContain('Launch recipe already saved')
    unmount()
  })

  test('the other actions have their own titles', async () => {
    const push = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 0) })
      f.on('quirky.git/push', () => {
        throw failure('Pre-push hook failed.', { reason: 'hook', summary: 'Pre-push hook failed.', output: 'husky' })
      })
    })
    await click(primary(push.element))
    await click(byLabel(push.element, 'Choose an agent for this push failure'))
    await click(buttonText(document.body, 'Customize launch...'))
    expect(dialog()?.getAttribute('aria-label')).toBe('Fix Push Failure With AI')
    push.unmount()
    document.body.innerHTML = ''

    const conflicts = await open((f) => void (f.status = statusOf([entry('a.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })], { operation: 'merge' })))
    await click(byLabel(conflicts.element, 'Choose an agent to resolve these conflicts'))
    await click(buttonText(document.body, 'Customize launch...'))
    expect(dialog()?.getAttribute('aria-label')).toBe('Resolve Conflicts With AI')
    conflicts.unmount()
  })

  test('Detecting agents... while the list loads, and No enabled agents with none', async () => {
    const list = deferred()
    const loading = await openLaunch((f) => f.on('quirky.agents/list', () => list.promise))
    expect(dialog()?.textContent).toContain('Detecting agents...')
    list.resolve({ defaultAgent: 'auto', agents: [] })
    await settle()
    expect(dialog()?.textContent).toContain('No enabled agents')
    expect((buttonText(dialog()!, 'Start agent') as HTMLButtonElement).disabled).toBe(true)
    loading.unmount()
  })

  test('a saved agent that is unavailable with no enabled agents still shows No enabled agents and keeps Start disabled', async () => {
    const { fake, unmount } = await openLaunch((f) => {
      f.on('quirky.agents/list', () => ({ defaultAgent: 'claude', agents: [] }))
      f.on('quirky.git/aiFixPreview', (params) => ({ prompt: 'Fix prompt', recipe: recipe(params.action as string, { agent: 'claude', sources: { agent: 'repo', args: 'default', template: 'default' } }) }))
    })
    expect(dialog()?.textContent).toContain('No enabled agents')
    expect(byLabel(dialog()!, 'Agent')).toBeNull()
    const start = buttonText(dialog()!, 'Start agent') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await click(start)
    expect(fake.called('quirky.git/aiFix')).toEqual([])
    unmount()
  })

  test('an edited launch passes provider choices and reset fields with the saved recipe', async () => {
    const { fake, unmount } = await openLaunch()
    await choose(field('Agent'), 'codex')
    await type(field('CLI arguments'), '--model gpt-5.4')
    await type(field('Prompt template'), 'Fix prompt for fixCommitFailure\nKeep the change small.')
    expect(buttonText(dialog()!, 'Save & start agent')).toBeDefined()
    await choose(field('Save for'), 'repo')
    await click(buttonText(dialog()!, 'Save & start agent'))
    expect(fake.called('quirky.git/aiFix').map((c) => c.params)).toEqual([
      { worktree: 'feat', action: 'fixCommitFailure', agent: 'codex', args: '--model gpt-5.4', template: '{basePrompt}\nKeep the change small.', launchOptions: null, save: 'repo' }
    ])
    expect(fake.toasts).toEqual([['Started an AI agent for the commit failure.', '']])
    expect(dialog()).toBeNull()
    unmount()
  })

  test('with "All repositories" the save goes to the global scope', async () => {
    const { fake, unmount } = await openLaunch()
    await type(field('CLI arguments'), '--fast')
    await choose(field('Save for'), 'global')
    await click(buttonText(dialog()!, 'Save & start agent'))
    expect(fake.called('quirky.git/aiFix')[0]?.params).toMatchObject({ save: 'global', args: '--fast', launchOptions: {} })
    unmount()
  })

  test('an untouched launch starts the agent chosen without saving anything', async () => {
    const { fake, unmount } = await openLaunch()
    await click(buttonText(dialog()!, 'Start agent'))
    expect(fake.called('quirky.git/aiFix').map((c) => c.params)).toEqual([
      { worktree: 'feat', action: 'fixCommitFailure', agent: 'claude', args: '', template: '{basePrompt}' }
    ])
    unmount()
  })

  test('with the save box cleared the edited launch only starts', async () => {
    const { fake, unmount } = await openLaunch()
    await type(field('CLI arguments'), '--fast')
    await click(byLabel(dialog()!, 'Save this launch as the recipe'))
    expect(buttonText(dialog()!, 'Start agent')).toBeDefined()
    await click(buttonText(dialog()!, 'Start agent'))
    expect(fake.called('quirky.git/aiFix')[0]?.params).not.toHaveProperty('save')
    unmount()
  })

  test('values equal to the saved recipe show "Launch recipe already saved" and a plain Start agent', async () => {
    const { fake, unmount } = await openLaunch((f) => {
      f.on('quirky.git/aiFixPreview', (params) => ({ prompt: 'Fix prompt\nKeep the change small.', recipe: recipe(params.action as string, SAVED) }))
    })
    expect(field('Agent').value).toBe('codex')
    expect(field('CLI arguments').value).toBe('--model gpt-5.4')
    expect(dialog()?.textContent).toContain('Launch recipe already saved')
    expect(buttonText(dialog()!, 'Save & start agent')).toBeUndefined()
    await click(buttonText(dialog()!, 'Start agent'))
    expect(fake.called('quirky.git/aiFix')[0]?.params).toEqual({
      worktree: 'feat',
      action: 'fixCommitFailure',
      agent: 'codex',
      args: '--model gpt-5.4',
      template: '{basePrompt}\nKeep the change small.'
    })
    unmount()
  })
  test('a one-off model and effort choice is passed through and saved with the recipe', async () => {
    const { fake, unmount } = await openLaunch()
    await settle()
    await type(field('Model'), 'opus')
    await choose(field('Effort'), 'high')
    await click(buttonText(dialog()!, 'Save & start agent'))
    expect(fake.called('quirky.git/aiFix')[0]?.params).toMatchObject({
      launchOptions: { model: 'opus', optionValues: { effort: 'high' } },
      save: 'repo'
    })
    unmount()
  })

  test('raw model and effort arguments disable catalog controls and say they are set by CLI arguments', async () => {
    const { unmount } = await openLaunch((fake) =>
      fake.on('quirky.git/aiFixPreview', (params) => ({
        prompt: 'Fix prompt',
        recipe: recipe(params.action as string, {
          args: '--model raw --effort max',
          launchOptions: { model: 'opus', optionValues: { effort: 'high' } }
        })
      }))
    )
    await settle()
    expect((field('Model') as HTMLInputElement).disabled).toBe(true)
    expect((field('Effort') as HTMLSelectElement).disabled).toBe(true)
    expect(dialog()?.textContent).toContain('Set by CLI arguments')
    unmount()
  })

  test('Reset puts the template back to {basePrompt}', async () => {
    const { unmount } = await openLaunch()
    const reset = buttonText(dialog()!, 'Reset') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    await click(reset)
    expect(field('Prompt template').value).toBe('{basePrompt}')
    expect((buttonText(dialog()!, 'Reset') as HTMLButtonElement).disabled).toBe(true)
    unmount()
  })

  test('a refused start keeps the dialog and toasts the daemon message', async () => {
    const { fake, unmount } = await openLaunch((f) =>
      f.on('quirky.git/aiFix', () => {
        throw failure('Saved AI agent is unavailable. Use Customize launch to choose another agent.', { reason: 'agent-unavailable' })
      })
    )
    await click(buttonText(dialog()!, 'Start agent'))
    expect(fake.toasts.map(([, body]) => body)).toEqual(['Saved AI agent is unavailable. Use Customize launch to choose another agent.'])
    expect(dialog()).not.toBeNull()
    unmount()
  })

  test('Cancel and Escape close it without starting anything', async () => {
    const { fake, unmount } = await openLaunch()
    await click(buttonText(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()
    expect(fake.called('quirky.git/aiFix')).toEqual([])
    await click(byLabel(document.body, 'Choose an agent for this commit failure'))
    await click(buttonText(document.body, 'Customize launch...'))
    await press(window, 'Escape')
    expect(dialog()).toBeNull()
    unmount()
  })
})

type Mount = (element: HTMLElement, props: { input?: unknown }) => (() => void) | void

/** Mounts the `ai-settings` view the way the host does and returns its element. */
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
      act(() => {
        cleanup?.()
      })
      element.remove()
    }
  }
}

describe('NA-40: the Source Control AI defaults view', () => {
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

  async function openSettings(configure: (f: Fake) => void = () => {}) {
    const fake = aiFake()
    fake.on('quirky.git/setAiRecipe', (params) => ({ saved: true, recipe: recipe(params.action as string) }))
    configure(fake)
    const mounted = mountSettings(fake)
    await settle()
    return { fake, ...mounted }
  }
  const section = (element: HTMLElement, action: string) => q(element, `[data-action="${action}"]`)!
  const inSection = (element: HTMLElement, action: string, label: string) =>
    byLabel(section(element, action), label) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement

  test('shows the title, the switch, the custom command and one row per action', async () => {
    const { fake, element, unmount } = await openSettings()
    expect(q(element, 'h2')?.textContent).toBe('Source Control AI defaults')
    expect(element.textContent).toContain('Adds AI buttons that run the selected agent with the command template for that action.')
    expect(element.textContent).toContain('Command line Quirky runs when a recipe uses Custom command.')
    expect((byLabel(element, 'Show Source Control AI actions') as HTMLInputElement).checked).toBe(true)
    expect(qa(element, '[data-action]').map((el) => [el.getAttribute('data-action'), q(el, 'h3')?.textContent])).toEqual([
      ['commitMessage', 'Commit message'],
      ['fixCommitFailure', 'Commit failure fixes'],
      ['fixPushFailure', 'Push failure fixes'],
      ['resolveConflicts', 'Conflict resolution'],
      ['branchSummary', 'Branch summary'],
      ['pullRequestDetails', 'Pull request details'],
      ['pullRequestReview', 'Pull request review'],
      ['reviewConversation', 'Review conversation'],
      ['branchName', 'Branch name'],
      ['conversationName', 'Conversation name']
    ])
    expect(fake.called('quirky.git/aiRecipe').map((c) => c.params)).toEqual(ACTIONS.map((action) => ({ worktree: 'feat', action })))
    expect([...inSection(element, 'commitMessage', 'Commit message agent').options].map((o) => o.textContent)).toEqual(['Default agent', 'Claude', 'Codex', 'Custom command'])
    expect([...inSection(element, 'fixPushFailure', 'Push failure fixes agent').options].map((o) => o.textContent)).toEqual(['Default agent', 'Claude', 'Codex'])
    for (const action of ACTIONS) {
      expect(buttonText(section(element, action), 'Reset')).toBeDefined()
      expect(section(element, action).textContent).toContain('CLI arguments')
      expect(section(element, action).textContent).toContain('Command template')
    }
    unmount()
  })
  test('name actions use distinct recipes and retain the last candidate when a later generation fails', async () => {
    let failName = false
    const { fake, element, unmount } = await openSettings((f) => {
      f.on('quirky.session/list', () => [{
        id: 'captured-session',
        kind: 'structured',
        worktreeId: 'feat',
        title: 'Move metadata',
        status: 'done',
        lastActivityAt: 10
      }])
      f.on('quirky.git/aiName', (params) => {
        if (failName) throw new Error('provider unavailable')
        return { action: params.action, name: params.action === 'branchName' ? 'feature/metadata-owner' : 'Metadata owner conversation', agent: 'codex' }
      })
    })
    await click(buttonText(section(element, 'branchName'), 'Generate branch name'))
    expect(fake.called('quirky.git/aiName').at(-1)?.params).toMatchObject({ worktree: 'feat', action: 'branchName' })
    expect(section(element, 'branchName').textContent).toContain('feature/metadata-owner')

    const selectedSession = inSection(element, 'conversationName', 'Captured conversation') as HTMLSelectElement
    await act(async () => {
      selectedSession.value = 'captured-session'
      selectedSession.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(buttonText(section(element, 'conversationName'), 'Generate conversation name'))
    expect(fake.called('quirky.git/aiName').at(-1)?.params).toMatchObject({
      worktree: 'feat', action: 'conversationName', session: 'captured-session'
    })
    expect(section(element, 'conversationName').textContent).toContain('Metadata owner conversation')

    failName = true
    await click(buttonText(section(element, 'conversationName'), 'Generate conversation name'))
    expect(section(element, 'conversationName').textContent).toContain('Metadata owner conversation')
    expect(section(element, 'conversationName').textContent).toContain('provider unavailable')
    expect(fake.called('quirky.git/aiName')).toHaveLength(3)
    unmount()
  })
  test('the current hosted branch exposes named AI source actions without launching or posting yet', async () => {
    const fake = aiFake()
    const element = document.createElement('div')
    document.body.appendChild(element)
    const root = createRoot(element)
    const started: string[] = []
    act(() => root.render(createElement(GitHubReviewStatus, {
      context: fake.context,
      lookup: {
        kind: 'found',
        target: { worktree: 'feat', branch: 'zoe/feat', head: 'a'.repeat(40) },
        review: { number: 42, url: 'https://github.com/octo/quirky/pull/42', state: 'open' }
      },
      aiEnabled: true,
      onLaunch: (action: string) => started.push(action)
    })))
    await click(buttonText(element, 'Summarize branch with AI'))
    await click(buttonText(element, 'Read pull request details with AI'))
    await click(buttonText(element, 'Review pull request with AI'))
    await click(buttonText(element, 'Draft conversation reply with AI'))
    expect(started).toEqual(['branchSummary', 'pullRequestDetails', 'pullRequestReview', 'reviewConversation'])
    expect(fake.called('quirky.hosting/reviewConversation')).toEqual([])
    act(() => root.unmount())
    element.remove()
  })


  test('shows the saved recipe of each action', async () => {
    const { element, unmount } = await openSettings((f) => f.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, params.action === 'fixPushFailure' ? SAVED : {})))
    expect(inSection(element, 'fixPushFailure', 'Push failure fixes agent').value).toBe('codex')
    expect(inSection(element, 'fixPushFailure', 'Push failure fixes CLI arguments').value).toBe('--model gpt-5.4')
    expect(inSection(element, 'fixPushFailure', 'Push failure fixes command template').value).toBe(SAVED.template)
    expect(inSection(element, 'commitMessage', 'Commit message agent').value).toBe('')
    unmount()
  })
  test('keeps a stale saved model visible and offers an explicit provider refresh', async () => {
    let refreshed = false
    const { fake, element, unmount } = await openSettings((f) => {
      f.on('quirky.git/aiRecipe', (params) =>
        recipe(params.action as string, params.action === 'commitMessage'
          ? { agent: 'codex', launchOptions: { model: 'retired-model' } }
          : {})
      )
      f.on('quirky.agents/options', (params) => ({
        agent: params.agent,
        label: 'Codex',
        supported: true,
        discoverable: true,
        models: [{ id: refreshed ? 'replacement-model' : 'current-model', label: refreshed ? 'Replacement model' : 'Current model', description: null, options: [] }],
        unlisted: 'refuse',
        unlistedOptions: [],
        structured: false,
        extraArgs: null
      }))
      f.on('quirky.agents/discoverModels', () => {
        refreshed = true
        return { agent: 'codex', host: 'local', status: 'available', authoritative: true, models: [{ id: 'replacement-model', label: 'Replacement model', options: [] }] }
      })
    })
    const model = inSection(element, 'commitMessage', 'Commit message model')
    expect(model.value).toBe('retired-model')
    expect([...model.options].some((choice) => choice.value === 'retired-model' && choice.textContent?.includes('unavailable'))).toBe(true)
    expect(section(element, 'commitMessage').textContent).toContain('Saved model retired-model is no longer available.')
    await click(buttonText(section(element, 'commitMessage'), 'Refresh models'))
    expect(fake.called('quirky.agents/discoverModels').map((call) => call.params)).toEqual([{ agent: 'codex', host: 'local' }])
    expect(inSection(element, 'commitMessage', 'Commit message model').value).toBe('retired-model')
    expect(section(element, 'commitMessage').textContent).toContain('Saved model retired-model is no longer available.')
    expect(fake.called('quirky.git/setAiRecipe')).toEqual([])
    unmount()
  })

  test('custom command recipes have no catalog model or effort choices', async () => {
    const { element, unmount } = await openSettings((fake) =>
      fake.on('quirky.git/aiRecipe', (params) =>
        recipe(params.action as string, params.action === 'commitMessage' ? { agent: 'custom' } : {})
      )
    )
    expect(section(element, 'commitMessage').textContent).toContain('Custom command does not support catalog model or option picks.')
    expect(inSection(element, 'commitMessage', 'Commit message model')).toBeNull()
    unmount()
  })

  test('each change saves the global recipe at once', async () => {
    const { fake, element, unmount } = await openSettings()
    const agentSelect = inSection(element, 'commitMessage', 'Commit message agent')
    await act(async () => {
      agentSelect.value = 'codex'
      agentSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    await type(inSection(element, 'fixCommitFailure', 'Commit failure fixes CLI arguments'), '--model haiku')
    await type(inSection(element, 'resolveConflicts', 'Conflict resolution command template'), '{basePrompt}\nBe careful.')
    expect(fake.called('quirky.git/setAiRecipe').map((c) => c.params)).toEqual([
      { worktree: 'feat', action: 'commitMessage', scope: 'global', agent: 'codex', launchOptions: null },
      { worktree: 'feat', action: 'fixCommitFailure', scope: 'global', args: '--model haiku' },
      { worktree: 'feat', action: 'resolveConflicts', scope: 'global', template: '{basePrompt}\nBe careful.' }
    ])
  })
  test('settings save provider model and effort choices, then clear them when the agent changes', async () => {
    const { fake, element, unmount } = await openSettings((f) => {
      f.on('quirky.git/setAiRecipe', (params) => {
        const agentId = params.agent as string | undefined
        const launchOptions = Object.hasOwn(params, 'launchOptions') ? params.launchOptions : {}
        return {
          saved: true,
          recipe: recipe(params.action as string, {
            agent: agentId ?? null,
            launchOptions: launchOptions ?? {},
            sources: {
              agent: agentId ? 'global' : 'default',
              args: 'default',
              template: 'default',
              launchOptions: Object.hasOwn(params, 'launchOptions') ? 'global' : 'default'
            }
          })
        }
      })
    })
    await type(inSection(element, 'commitMessage', 'Commit message model'), 'opus')
    const effort = inSection(element, 'commitMessage', 'Commit message effort')
    await act(async () => {
      effort.value = 'high'
      effort.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const agentSelect = inSection(element, 'commitMessage', 'Commit message agent')
    await act(async () => {
      agentSelect.value = 'codex'
      agentSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(fake.called('quirky.git/setAiRecipe').map((call) => call.params)).toEqual([
      { worktree: 'feat', action: 'commitMessage', scope: 'global', launchOptions: { model: 'opus' } },
      { worktree: 'feat', action: 'commitMessage', scope: 'global', launchOptions: { model: 'opus', optionValues: { effort: 'high' } } },
      { worktree: 'feat', action: 'commitMessage', scope: 'global', agent: 'codex', launchOptions: null }
    ])
    unmount()
  })

  test('Reset clears the template so it is {basePrompt} again', async () => {
    const { fake, element, unmount } = await openSettings((f) => {
      f.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, params.action === 'resolveConflicts' ? { template: 'Custom text' } : {}))
    })
    expect(inSection(element, 'resolveConflicts', 'Conflict resolution command template').value).toBe('Custom text')
    await click(buttonText(section(element, 'resolveConflicts'), 'Reset'))
    expect(fake.called('quirky.git/setAiRecipe').map((c) => c.params)).toEqual([{ worktree: 'feat', action: 'resolveConflicts', scope: 'global', template: '' }])
    expect(inSection(element, 'resolveConflicts', 'Conflict resolution command template').value).toBe('{basePrompt}')
    unmount()
  })

  test('the switch and the custom command write the settings', async () => {
    const { fake, element, unmount } = await openSettings()
    await click(byLabel(element, 'Show Source Control AI actions'))
    expect(fake.called('setting.set').map((c) => c.params)).toEqual([{ id: 'setting:quirky.git/ai-enabled', value: false }])
    await type(byLabel(element, 'Custom command') as HTMLInputElement, 'my-gen --fast {prompt}')
    expect(fake.called('setting.set').at(-1)?.params).toEqual({ id: 'setting:quirky.git/ai-custom-command', value: 'my-gen --fast {prompt}' })
    unmount()
  })

  test('refreshes on aiChanged and on setting.changed', async () => {
    const { fake, element, unmount } = await openSettings()
    fake.on('quirky.git/aiRecipe', (params) => recipe(params.action as string, params.action === 'commitMessage' ? { agent: 'codex' } : {}))
    await act(async () => fake.emit({ type: 'quirky.git/aiChanged', data: { repoId: null } }))
    await settle()
    expect(inSection(element, 'commitMessage', 'Commit message agent').value).toBe('codex')
    fake.settings['ai-enabled'] = false
    await act(async () => fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/ai-enabled', value: false }))
    await settle()
    expect((byLabel(element, 'Show Source Control AI actions') as HTMLInputElement).checked).toBe(false)
    unmount()
  })

  test('says so when no worktree is open', async () => {
    const fake = aiFake()
    fake.setLayout(layoutFor(null))
    const { element, unmount } = mountSettings(fake, {})
    await settle()
    expect(element.textContent).toContain('Open a worktree first.')
    unmount()
  })
})
