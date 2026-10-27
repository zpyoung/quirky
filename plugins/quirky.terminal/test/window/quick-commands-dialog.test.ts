import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { agent, button, cleanup, click, command, fill, key, loadQuickCommands, pick, qc, qcFake, render, unloadQuickCommands, $, $$ } from './qc-support'
import type { QuickCommand } from '../../src/layout/types'
import type { ReactElement } from 'react'
import { createElement } from 'react'

beforeAll(loadQuickCommands)
afterAll(unloadQuickCommands)
afterEach(cleanup)

type Setup = { repo?: string | null; edit?: QuickCommand | null; agents?: ReturnType<typeof agent>[]; failNext?: string; commands?: QuickCommand[] }

async function openDialog(setup: Setup = {}) {
  const { fake, world } = qcFake({ ...(setup.agents ? { agents: setup.agents } : {}), ...(setup.failNext ? { failNext: setup.failNext } : {}), ...(setup.commands ? { commands: setup.commands } : {}) })
  const closed: number[] = []
  const saved: QuickCommand[][] = []
  const ui = createElement(qc().dialog.QuickCommandDialog, {
    context: fake.context,
    command: setup.edit ?? null,
    repo: setup.repo === undefined ? 'api' : setup.repo,
    onClose: () => void closed.push(1),
    onSaved: (commands: QuickCommand[]) => void saved.push(commands)
  }) as ReactElement
  await render(ui)
  return { fake, world, closed, saved }
}

const field = <T extends HTMLElement>(name: string) => $<T>(`[name="${name}"]`)!
const radio = (name: string, value: string) => $<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)
const save = () => button('Save')

describe('QuickCommandDialog', () => {
  test('SC-49: the Add dialog reads as Orca does and Save waits for a label and a command', async () => {
    await openDialog()
    const dialog = $('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Add Quick Command')
    expect(dialog.textContent).toContain('Saved items appear in the tab bar menu for one-click run.')

    const label = field<HTMLInputElement>('label')
    expect(label.getAttribute('placeholder')).toBe('Start dev server')
    expect(label.getAttribute('maxlength')).toBe('80')
    const text = field<HTMLTextAreaElement>('command')
    expect(text.getAttribute('placeholder')).toBe('npm run dev')
    expect(text.getAttribute('maxlength')).toBe('4000')
    expect(document.head.querySelector('style[data-plugin="quirky.terminal-qc"]')!.textContent).toContain('resize: vertical')

    expect(save().disabled).toBe(true)
    await fill(label, 'Hello')
    expect(save().disabled).toBe(true)
    await fill(text, '   ')
    expect(save().disabled).toBe(true)
    await fill(text, 'echo hello')
    expect(save().disabled).toBe(false)
    await fill(label, '  ')
    expect(save().disabled).toBe(true)
  })

  test('SC-49: Terminal is the default action, the Agent select is disabled for it, and Append Enter starts on', async () => {
    await openDialog()
    expect(radio('action', 'terminal')!.checked).toBe(true)
    expect(radio('action', 'agent')!.checked).toBe(false)
    expect(field<HTMLSelectElement>('agent').disabled).toBe(true)
    const append = $('[role="switch"]')!
    expect(append.textContent).toContain('Append Enter — run immediately')
    expect(append.getAttribute('aria-checked')).toBe('true')
    await click(append)
    expect($('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
  })

  test('SC-49: Advanced is open and Project is preselected with the current repo', async () => {
    await openDialog({ repo: 'api' })
    expect($('[aria-expanded]')!.textContent).toContain('Advanced')
    expect($('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
    expect(radio('scope', 'repo')!.checked).toBe(true)
    expect(radio('scope', 'global')!.checked).toBe(false)
    expect($('[role="dialog"]')!.textContent).toContain('api')
  })

  test('SC-55: with no repo (the floating workspace) there is no Project option and Global is chosen', async () => {
    await openDialog({ repo: null })
    expect(radio('scope', 'repo')).toBeNull()
    expect(radio('scope', 'global')!.checked).toBe(true)
  })

  test('SC-49: saving a terminal command sends the trimmed fields and a project scope, then closes', async () => {
    const { fake, closed, saved } = await openDialog()
    await fill(field<HTMLInputElement>('label'), '  Hello  ')
    await fill(field<HTMLTextAreaElement>('command'), 'echo hello')
    await click(save())
    expect(fake.callsTo('quirky.terminal/addQuickCommand').map((call) => call.params)).toEqual([
      { label: 'Hello', kind: 'terminal', command: 'echo hello', appendEnter: true, scope: 'repo', repo: 'api' }
    ])
    expect(saved).toHaveLength(1)
    expect(saved[0]![0]).toMatchObject({ id: 'hello', scope: 'repo', repo: 'api' })
    expect(closed).toHaveLength(1)
  })

  test('SC-49: Command+Enter saves from the command box, but not while Save is disabled', async () => {
    const { fake, closed } = await openDialog({ repo: null })
    const text = field<HTMLTextAreaElement>('command')
    await key(text, 'Enter', { metaKey: true })
    expect(fake.callsTo('quirky.terminal/addQuickCommand')).toHaveLength(0)
    await fill(field<HTMLInputElement>('label'), 'Hello')
    await fill(text, 'echo hello')
    await key(text, 'Enter', { metaKey: true })
    expect(fake.callsTo('quirky.terminal/addQuickCommand')).toHaveLength(1)
    expect(fake.callsTo('quirky.terminal/addQuickCommand')[0]!.params).toMatchObject({ scope: 'global' })
    expect(closed).toHaveLength(1)
  })

  test('Cancel and Escape close without saving', async () => {
    const { fake, closed } = await openDialog()
    await fill(field<HTMLInputElement>('label'), 'Hello')
    await click(button('Cancel'))
    expect(closed).toHaveLength(1)
    await key(document.body, 'Escape')
    expect(closed).toHaveLength(2)
    expect(fake.callsTo('quirky.terminal/addQuickCommand')).toHaveLength(0)
  })

  test('SC-49: a daemon refusal is shown inline, keeps the text and leaves the dialog open', async () => {
    const { closed, fake } = await openDialog({ failNext: 'at most 40 quick commands' })
    await fill(field<HTMLInputElement>('label'), 'Hello')
    await fill(field<HTMLTextAreaElement>('command'), 'echo hello')
    await click(save())
    expect($('[role="alert"]')!.textContent).toContain('at most 40 quick commands')
    expect(closed).toHaveLength(0)
    expect(field<HTMLInputElement>('label').value).toBe('Hello')
    expect(field<HTMLTextAreaElement>('command').value).toBe('echo hello')
    expect(save().disabled).toBe(false)
    expect(fake.toasts).toHaveLength(0)
  })

  test('SC-53: the Agent select lists only installed, enabled agents that take a prompt at start', async () => {
    await openDialog({
      agents: [
        agent('claude'),
        agent('codex'),
        agent('aider', { promptMode: 'stdin-after-start' }),
        agent('gemini', { installed: false }),
        agent('pi', { enabled: false }),
        agent('hermes', { promptMode: 'hermes-query' })
      ]
    })
    await click(radio('action', 'agent')!)
    const select = field<HTMLSelectElement>('agent')
    expect(select.disabled).toBe(false)
    expect($$<HTMLOptionElement>('option', select).map((option) => option.value).filter(Boolean)).toEqual(['claude', 'codex', 'hermes'])
  })

  test('SC-53: choosing Agent preselects the first agent, relabels the box Prompt and disables Append Enter', async () => {
    const { fake, closed } = await openDialog({ repo: null })
    await click(radio('action', 'agent')!)
    expect(field<HTMLSelectElement>('agent').value).toBe('claude')
    expect($('[role="dialog"]')!.textContent).toContain('Prompt')
    expect($('[role="switch"]')!.getAttribute('disabled')).not.toBeNull()
    await fill(field<HTMLInputElement>('label'), 'Review')
    await fill(field<HTMLTextAreaElement>('command'), 'review the diff')
    await pick(field<HTMLSelectElement>('agent'), 'codex')
    await click(save())
    expect(fake.callsTo('quirky.terminal/addQuickCommand')[0]!.params).toEqual({ label: 'Review', kind: 'agent', agent: 'codex', command: 'review the diff', scope: 'global' })
    expect(closed).toHaveLength(1)
  })

  test('the terminal command and the agent prompt are separate drafts', async () => {
    await openDialog()
    await fill(field<HTMLTextAreaElement>('command'), 'npm test')
    await click(radio('action', 'agent')!)
    expect(field<HTMLTextAreaElement>('command').value).toBe('')
    await fill(field<HTMLTextAreaElement>('command'), 'fix the tests')
    await click(radio('action', 'terminal')!)
    expect(field<HTMLTextAreaElement>('command').value).toBe('npm test')
    await click(radio('action', 'agent')!)
    expect(field<HTMLTextAreaElement>('command').value).toBe('fix the tests')
  })

  test('an agent command with no agent chosen cannot be saved', async () => {
    await openDialog({ agents: [] })
    await click(radio('action', 'agent')!)
    await fill(field<HTMLInputElement>('label'), 'Review')
    await fill(field<HTMLTextAreaElement>('command'), 'review')
    expect(save().disabled).toBe(true)
  })

  test('Edit shows the saved values and sends the id with the changed fields', async () => {
    const draft = command({ id: 'draft', label: 'Draft', command: 'echo draft', appendEnter: false, scope: 'repo', repo: 'api' })
    const { fake, closed } = await openDialog({ edit: draft, commands: [draft], repo: 'other' })
    expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Edit Quick Command')
    expect(field<HTMLInputElement>('label').value).toBe('Draft')
    expect(field<HTMLTextAreaElement>('command').value).toBe('echo draft')
    expect($('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect(radio('scope', 'repo')!.checked).toBe(true)
    await fill(field<HTMLInputElement>('label'), 'Draft 2')
    await click(radio('scope', 'global')!)
    await click(save())
    expect(fake.callsTo('quirky.terminal/updateQuickCommand')[0]!.params).toEqual({
      id: 'draft',
      label: 'Draft 2',
      kind: 'terminal',
      command: 'echo draft',
      appendEnter: false,
      scope: 'global'
    })
    expect(closed).toHaveLength(1)
  })

  test('Edit of an agent command shows its agent and prompt', async () => {
    const review = command({ id: 'review', label: 'Review', kind: 'agent', agent: 'codex', command: 'review the diff', appendEnter: false })
    await openDialog({ edit: review, commands: [review] })
    expect(radio('action', 'agent')!.checked).toBe(true)
    expect(field<HTMLSelectElement>('agent').value).toBe('codex')
    expect(field<HTMLTextAreaElement>('command').value).toBe('review the diff')
  })
})
