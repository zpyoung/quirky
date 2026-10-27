import { act } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { $, button, cleanup, click, command, loadQuickCommands, qc, qcFake, settle, unloadQuickCommands } from './qc-support'

beforeAll(loadQuickCommands)
afterAll(unloadQuickCommands)
afterEach(cleanup)

const hello = command({ id: 'hello', label: 'Hello', command: 'echo hello' })
const draft = command({ id: 'draft', label: 'Draft', command: 'echo draft', appendEnter: false })

describe('paneQuickCommandItems', () => {
  test('SC-52: each command is an item, and one that does not press Enter carries the Insert hint', () => {
    const { fake } = qcFake()
    const items = qc().items.paneQuickCommandItems(fake.context, [hello, draft], 'pane-3')
    expect(items.slice(0, 2).map((item) => ({ label: item.label, hint: item.hint, enabled: item.enabled }))).toEqual([
      { label: 'Hello', hint: undefined, enabled: true },
      { label: 'Draft', hint: 'Insert', enabled: true }
    ])
  })

  test('SC-52: picking an item runs the command in that pane', async () => {
    const { fake } = qcFake()
    const items = qc().items.paneQuickCommandItems(fake.context, [hello, draft], 'pane-3')
    await items[1]!.onSelect()
    await items[0]!.onSelect()
    expect(fake.callsTo('quirky.terminal/runQuickCommand').map((call) => call.params)).toEqual([
      { id: 'draft', pane: 'pane-3' },
      { id: 'hello', pane: 'pane-3' }
    ])
  })

  test('SC-52: with no commands the submenu reads No quick commands (disabled) and Add Quick Command…', () => {
    const { fake } = qcFake()
    const items = qc().items.paneQuickCommandItems(fake.context, [], 'pane-3')
    expect(items.map((item) => ({ label: item.label, enabled: item.enabled }))).toEqual([
      { label: 'No quick commands', enabled: false },
      { label: 'Add Quick Command…', enabled: true }
    ])
  })

  test('with commands, Add Quick Command… follows them after a separator', () => {
    const { fake } = qcFake()
    const items = qc().items.paneQuickCommandItems(fake.context, [hello], 'pane-3')
    expect(items.map((item) => item.label)).toEqual(['Hello', 'Add Quick Command…'])
    expect(items[1]!.separatorBefore).toBe(true)
  })

  test('repo commands come before global ones', () => {
    const { fake } = qcFake()
    const project = command({ id: 'test', label: 'Test', scope: 'repo', repo: 'api' })
    expect(qc().items.paneQuickCommandItems(fake.context, [hello, project, draft], 'pane-3').map((item) => item.label).slice(0, 3)).toEqual(['Test', 'Hello', 'Draft'])
  })

  test('a half-typed command is not offered', () => {
    const { fake } = qcFake()
    const half = command({ id: 'half', label: 'Half', command: '' })
    expect(qc().items.paneQuickCommandItems(fake.context, [half], 'pane-3').map((item) => item.label)).toEqual(['No quick commands', 'Add Quick Command…'])
  })

  test('Add Quick Command… opens the Add dialog, with Project preselected when the pane\'s repo is given', async () => {
    const { fake } = qcFake()
    const items = qc().items.paneQuickCommandItems(fake.context, [], 'pane-3', { repo: 'api' })
    await act(async () => void items[1]!.onSelect())
    await settle()
    expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Add Quick Command')
    expect($<HTMLInputElement>('input[name="scope"][value="repo"]')!.checked).toBe(true)
    await click(button('Cancel'))
    expect($('[role="dialog"]')).toBeNull()
  })

  test('without a repo the dialog opens on Global', async () => {
    const { fake } = qcFake()
    const items = qc().items.paneQuickCommandItems(fake.context, [], 'pane-3')
    await act(async () => void items[1]!.onSelect())
    await settle()
    expect($('input[name="scope"][value="repo"]')).toBeNull()
  })

  test('a run that fails shows a toast', async () => {
    const { fake } = qcFake()
    fake.context.call = async () => {
      throw new Error('session has exited')
    }
    const items = qc().items.paneQuickCommandItems(fake.context, [hello], 'pane-3')
    await items[0]!.onSelect()
    expect(fake.toasts.at(-1)).toEqual({ title: 'Could not run quick command', body: 'session has exited' })
  })
})
