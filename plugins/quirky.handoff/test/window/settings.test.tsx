import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import { daemon, fakeContext, makeWorld, mountSettings, teardown, type Ui } from './support'

let ui: Ui

beforeAll(async () => {
  registerDom()
  ui = (await import('../../src/ui')) as Ui
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(() => teardown(ui))

async function opened(options: { confirm?: (options: any) => boolean } = {}) {
  const world = makeWorld()
  const fake = fakeContext(daemon(world), options)
  const page = await mountSettings(ui, fake)
  return { world, fake, page }
}

const openAdd = async (page: Awaited<ReturnType<typeof opened>>['page']) => {
  await page.view.click(page.view.button('Add template'))
}

describe('SC-24: the Session handoff settings page', () => {
  test('SC-24: the Session handoff settings page lists built-ins with their count and reset state', async () => {
    const { page } = await opened()
    const v = page.view
    expect(v.all('[data-template]').map((row) => row.querySelector<HTMLButtonElement>('button[aria-label^="Edit "]')!.getAttribute('aria-label')!.slice(5))).toEqual([
      'Continue implementation',
      'Review what was done',
      'Debug the failure'
    ])
    expect(v.text()).toContain('3 of 24 templates')
    expect(v.button('Reset to defaults')!.disabled).toBe(true)
    expect(page.last()).toMatchObject({ custom: false, count: 3, limit: 24, editor: null, confirm: null })
    expect(page.last().templates).toHaveLength(3)
    expect(Object.keys(page.last()).sort()).toEqual(['confirm', 'count', 'custom', 'editor', 'limit', 'templates', 'warning'])
  })

  test('SC-24: Add template opens Name and Instructions with the counter and hint, and Save template stays disabled while either is empty', async () => {
    const { page, fake } = await opened()
    const v = page.view
    await openAdd(page)
    expect(v.q('[role="dialog"]')).not.toBeNull()
    expect(v.q('input[aria-label="Name"]')).not.toBeNull()
    expect(v.q('textarea[aria-label="Instructions"]')).not.toBeNull()
    expect(v.text()).toContain('0 / 8,000')
    expect(v.text()).toContain('Variables: {{gitStatus}}, {{changedPaths}}, and {{openEditorTabs}}. SCREAMING_CASE aliases also work.')
    expect(v.button('Save template')!.disabled).toBe(true)
    expect(page.last().editor).toEqual({ id: null, name: '', body: '' })

    await v.type(v.q('input[aria-label="Name"]') as HTMLInputElement, 'Mine')
    expect(v.button('Save template')!.disabled).toBe(true)
    await v.type(v.q('textarea[aria-label="Instructions"]') as HTMLTextAreaElement, 'Do the thing')
    expect(v.text()).toContain('12 / 8,000')
    expect(v.button('Save template')!.disabled).toBe(false)

    await v.click(v.button('Save template'))
    expect(fake.callsTo('templateMutate')[0]!.params).toEqual({ op: 'add', template: { name: 'Mine', body: 'Do the thing' } })
    expect(v.q('[role="dialog"]')).toBeNull()
    expect(v.text()).toContain('4 of 24 templates')
    expect(v.button('Reset to defaults')!.disabled).toBe(false)
    expect(page.last()).toMatchObject({ custom: true, count: 4, editor: null })
  })

  test('SC-24: a second template with an existing name shows a duplicate warning and both are kept', async () => {
    const { page } = await opened()
    const v = page.view
    await openAdd(page)
    await v.type(v.q('input[aria-label="Name"]') as HTMLInputElement, 'Debug the failure')
    await v.type(v.q('textarea[aria-label="Instructions"]') as HTMLTextAreaElement, 'Another take')
    await v.click(v.button('Save template'))
    expect(v.text()).toContain('Another template is already named “Debug the failure”. Both were kept.')
    expect(page.last().warning).toContain('Debug the failure')
    expect(v.all('[data-template]').filter((row) => row.textContent!.includes('Debug the failure'))).toHaveLength(2)
  })

  test('SC-24: removing a row asks Delete “<name>”? and removes it only when confirmed', async () => {
    const asked: string[] = []
    const { page, fake } = await opened({ confirm: (options) => (asked.push(options.title), asked.length > 1) })
    const v = page.view
    await v.click(v.q('[aria-label="Remove Review what was done"]'))
    expect(asked).toEqual(['Delete “Review what was done”?'])
    expect(fake.callsTo('templateMutate')).toEqual([])
    expect(v.text()).toContain('3 of 24 templates')

    await v.click(v.q('[aria-label="Remove Review what was done"]'))
    expect(fake.callsTo('templateMutate')[0]!.params).toEqual({ op: 'remove', id: 'review-completed-work' })
    expect(v.text()).toContain('2 of 24 templates')
  })

  test('SC-24: the report shows the confirmation while it waits', async () => {
    let answer!: (value: boolean) => void
    const world = makeWorld()
    const fake = fakeContext(daemon(world), { confirm: () => new Promise<boolean>((resolve) => void (answer = resolve)) })
    const page = await mountSettings(ui, fake)
    const pending = fake.run('template-remove', { id: 'debug-failure' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(page.last().confirm).toBe('Delete “Debug the failure”?')
    answer(false)
    await pending
    expect(page.last().confirm).toBeNull()
  })

  test('SC-24: resetting asks Reset handoff templates? and brings the built-ins back', async () => {
    const { page, fake, world } = await opened()
    const v = page.view
    await v.click(v.q('[aria-label="Remove Debug the failure"]'))
    expect(v.text()).toContain('2 of 24 templates')
    await v.click(v.button('Reset to defaults'))
    expect(fake.confirms.map((options) => options.title)).toEqual(['Delete “Debug the failure”?', 'Reset handoff templates?'])
    expect(world.templates).toHaveLength(3)
    expect(v.text()).toContain('3 of 24 templates')
    expect(v.button('Reset to defaults')!.disabled).toBe(true)
  })

  test('SC-24: edit opens the template and saves it as an update', async () => {
    const { page, fake } = await opened()
    const v = page.view
    await v.click(v.q('[aria-label="Edit Debug the failure"]'))
    expect((v.q('input[aria-label="Name"]') as HTMLInputElement).value).toBe('Debug the failure')
    await v.type(v.q('input[aria-label="Name"]') as HTMLInputElement, 'Debug it')
    await v.click(v.button('Save template'))
    expect(fake.callsTo('templateMutate')[0]!.params.op).toBe('update')
    expect(fake.callsTo('templateMutate')[0]!.params.template).toMatchObject({ id: 'debug-failure', name: 'Debug it' })
    expect(v.text()).toContain('Debug it')
  })

  test('SC-24: the template commands drive the page and the report follows', async () => {
    const { page, fake } = await opened()
    expect(await fake.run('template-add', { name: 'Scripted' })).toEqual({ ok: true })
    expect(fake.opened.map((entry) => entry.id)).toContain('view:quirky.handoff/settings')
    expect(page.last().editor).toEqual({ id: null, name: 'Scripted', body: '' })
    expect(await fake.run('template-add', { name: 'Scripted', body: 'Body', save: true })).toEqual({ ok: true })
    expect(page.last()).toMatchObject({ editor: null, count: 4 })

    expect(await fake.run('template-edit', { id: 'debug-failure' })).toEqual({ ok: true })
    expect(page.last().editor).toMatchObject({ id: 'debug-failure', name: 'Debug the failure' })
    expect(await fake.run('template-edit', { id: 'nope' })).toEqual({ ok: false, reason: 'unknown-template' })

    expect(await fake.run('template-remove', { id: 'debug-failure' })).toEqual({ ok: true })
    expect(page.last().count).toBe(3)
    expect(await fake.run('templates-reset')).toEqual({ ok: true })
    expect(page.last()).toMatchObject({ custom: false, count: 3 })
  })

  test('SC-24: open-settings opens the view', async () => {
    const { fake } = await opened()
    expect(await fake.run('open-settings')).toEqual({ ok: true })
    expect(fake.opened).toEqual([{ id: 'view:quirky.handoff/settings', input: undefined }])
  })

  test('SC-24: a templates change from another window refreshes the list', async () => {
    const { page, fake, world } = await opened()
    world.templates = [...world.templates, { id: 'x', name: 'From elsewhere', body: 'b' }]
    world.custom = true
    await fake.emit({ type: 'quirky.handoff/changed', data: { kind: 'templates' } } as never)
    expect(page.view.text()).toContain('4 of 24 templates')
    expect(page.view.text()).toContain('From elsewhere')
  })

  test('SC-24: the add button is disabled at the limit', async () => {
    const world = makeWorld()
    world.templates = Array.from({ length: 24 }, (_, index) => ({ id: `t${index}`, name: `T${index}`, body: 'b' }))
    const fake = fakeContext(daemon(world))
    const page = await mountSettings(ui, fake)
    expect(page.view.text()).toContain('24 of 24 templates')
    expect(page.view.button('Add template')!.disabled).toBe(true)
  })
})
