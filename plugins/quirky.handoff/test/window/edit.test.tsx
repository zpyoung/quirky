import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import {
  afterDebounce,
  daemon,
  fakeContext,
  makeWorld,
  mountOverlay,
  settle,
  statusEvent,
  teardown,
  type Ui
} from './support'

let ui: Ui
let EditorView: typeof import('@codemirror/view').EditorView

beforeAll(async () => {
  registerDom()
  ui = (await import('../../src/ui')) as Ui
  ;({ EditorView } = await import('@codemirror/view'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(() => teardown(ui))

async function opened(configure: (world: ReturnType<typeof makeWorld>) => void = () => {}) {
  const world = makeWorld()
  configure(world)
  const fake = fakeContext(daemon(world))
  const overlay = await mountOverlay(ui, fake)
  await fake.run('open', { session: 's_1' })
  await settle()
  return { world, fake, overlay }
}

/** Types into the CodeMirror preview the way a person does: a document change from the editor itself. */
async function typeInPreview(root: HTMLElement, from: number, to: number, insert: string) {
  const view = EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!
  await act(async () => {
    view.dispatch({ changes: { from, to, insert } })
  })
  return view
}

const KEY = 'AKIAABCDEFGHIJKLMNOP'
const ASSIGNMENT = 'api_key=abcdefghijklmnop1234'

describe('SC-21: New Template saves the steering note', () => {
  test('SC-21: picking New Template, naming it and saving selects it and clears the note', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    const note = v.q('textarea[aria-label="Steering note"]') as HTMLTextAreaElement
    const select = v.q('select[aria-label="Reusable template"]') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'No template',
      'New Template',
      'Continue implementation',
      'Review what was done',
      'Debug the failure'
    ])
    await v.type(note, 'Reproduce first, then fix')
    expect(v.q('input[aria-label="Template name"]')).toBeNull()

    await v.choose(select, '__new__')
    expect(overlay.last().templateEditor).toEqual({ name: '' })
    expect(v.button('Save template')!.disabled).toBe(true)
    await v.type(v.q('input[aria-label="Template name"]') as HTMLInputElement, 'Repro')
    expect(overlay.last().templateEditor).toEqual({ name: 'Repro' })
    expect(v.button('Save template')!.disabled).toBe(false)

    await v.click(v.button('Save template'))
    await settle()
    expect(fake.callsTo('templateMutate')[0]!.params).toEqual({ op: 'add', template: { name: 'Repro', body: 'Reproduce first, then fix' } })
    expect(overlay.last().controls.templateId).toBe('handoff-template-4')
    expect(overlay.last().controls.note).toBe('')
    expect(overlay.last().templateEditor).toBeNull()
    expect((v.q('select[aria-label="Reusable template"]') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Repro')
    expect((v.q('textarea[aria-label="Steering note"]') as HTMLTextAreaElement).value).toBe('')
  })

  test('SC-21: Save template is disabled for an empty note, a note over 8,000 characters and a full catalog', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    await fake.run('set', { field: 'template', value: 'new' })
    await fake.run('set', { field: 'templateName', value: 'Repro' })
    expect(v.button('Save template')!.disabled).toBe(true)
    expect(await fake.run('save-template', {})).toEqual({ ok: false, reason: 'cannot-save' })

    await fake.run('set', { field: 'note', value: 'x'.repeat(8001) })
    expect(v.button('Save template')!.disabled).toBe(true)
    await fake.run('set', { field: 'note', value: 'x'.repeat(8000) })
    expect(v.button('Save template')!.disabled).toBe(false)
    await fake.run('save-template', { name: 'Big' })
    expect(fake.callsTo('templateMutate')).toHaveLength(1)
    await teardown(ui)

    const full = await opened((w) => {
      w.templates = Array.from({ length: 24 }, (_, index) => ({ id: `t${index}`, name: `T${index}`, body: 'b' }))
    })
    await full.fake.run('set', { field: 'template', value: 'new' })
    await full.fake.run('set', { field: 'templateName', value: 'Extra' })
    await full.fake.run('set', { field: 'note', value: 'a note' })
    expect(full.overlay.view.button('Save template')!.disabled).toBe(true)
  })

  test('SC-21: save-template with a name saves under that name', async () => {
    const { overlay, fake } = await opened()
    await fake.run('set', { field: 'note', value: 'Do the thing' })
    await fake.run('set', { field: 'template', value: 'new' })
    expect(await fake.run('save-template', { name: 'Named' })).toEqual({ ok: true })
    expect(fake.callsTo('templateMutate')[0]!.params.template.name).toBe('Named')
    expect(overlay.last().controls.note).toBe('')
  })
})

describe('SC-33 and SC-34: a busy source', () => {
  test('SC-33: the busy strip, Wait for idle, and the recapture after Stop without a start', async () => {
    const { overlay, fake } = await opened((world) => {
      world.source.busy = true
    })
    const v = overlay.view
    expect(v.text()).toContain('The source Agent is working. Capture now or wait for newer context.')
    expect(overlay.last().busy).toEqual({ working: true, waiting: false })

    await v.click(v.button('Wait for idle'))
    expect(v.text()).toContain('Waiting for the source session to go idle. You can still start now.')
    expect(overlay.last().busy).toEqual({ working: true, waiting: true })
    const before = fake.callsTo('preview').length

    await fake.emit(statusEvent('s_1', 'done'))
    await settle()
    expect(overlay.last().busy).toEqual({ working: false, waiting: false })
    expect(v.text()).not.toContain('Waiting for the source session')
    expect(v.text()).not.toContain('The source Agent is working')
    expect(fake.callsTo('preview')).toHaveLength(before + 1)
    expect(fake.callsTo('preview').at(-1)!.params.recapture).toBe(true)
    expect(fake.callsTo('start')).toEqual([])
  })

  test('SC-33: an event for another session changes nothing', async () => {
    const { overlay, fake } = await opened((world) => {
      world.source.busy = true
    })
    await fake.emit(statusEvent('s_other', 'done'))
    expect(overlay.last().busy.working).toBe(true)
    expect(fake.callsTo('preview')).toHaveLength(1)
  })

  test('SC-34: Capture anyway recaptures now and dismisses the strip', async () => {
    const { overlay, fake } = await opened((world) => {
      world.source.busy = true
    })
    await overlay.view.click(overlay.view.button('Capture anyway'))
    await settle()
    expect(fake.callsTo('preview').at(-1)!.params.recapture).toBe(true)
    expect(overlay.last().busy).toEqual({ working: false, waiting: false })
    expect(overlay.view.q('[data-busy]')).toBeNull()
  })

  test('SC-35: no busy strip without a working signal, and Wait for idle is refused', async () => {
    const { overlay, fake } = await opened()
    expect(overlay.view.q('[data-busy]')).toBeNull()
    expect(await fake.run('wait-idle')).toEqual({ ok: false, reason: 'not-working' })
    await fake.emit(statusEvent('s_1', 'working'))
    expect(overlay.view.text()).toContain('The source Agent is working.')
  })
})

describe('SC-36 and SC-37: editing detaches and regenerating reattaches', () => {
  test('SC-36: typing disables the three groups and shows the notice; Regenerate restores the fresh text', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    const fresh = overlay.last().preview.text
    expect(v.all('fieldset').map((fieldset) => (fieldset as HTMLFieldSetElement).disabled)).toEqual([false, false, false])

    await typeInPreview(v.q('.cm-editor')!.parentElement!, 0, 0, 'EDIT ')
    expect(overlay.last().preview.detached).toBe(true)
    expect(overlay.last().preview.text).toBe(`EDIT ${fresh}`)
    expect(v.all('fieldset').map((fieldset) => (fieldset as HTMLFieldSetElement).disabled)).toEqual([true, true, true])
    expect(v.text()).toContain('The preview is no longer auto-updating. Regenerating discards your edits.')
    expect(v.button('Regenerate from controls')).not.toBeNull()
    expect(overlay.last().disabled).toEqual(expect.arrayContaining(['control:destination', 'control:content', 'control:notes']))

    await v.click(v.button('Regenerate from controls'))
    await settle()
    expect(overlay.last().preview).toMatchObject({ detached: false, stale: [], text: fresh })
    expect(v.all('fieldset').map((fieldset) => (fieldset as HTMLFieldSetElement).disabled)).toEqual([false, false, false])
    expect(v.text()).not.toContain('Regenerating discards your edits.')
    expect(v.q('.cm-content')!.textContent).toContain('Continue work from the prior Quirky session.')
    expect(v.q('.cm-content')!.textContent).not.toContain('EDIT')
  })

  test('SC-36: the edit command detaches the same way', async () => {
    const { overlay, fake } = await opened()
    expect(await fake.run('edit', { text: 'my own brief' })).toEqual({ ok: true })
    expect(overlay.last().preview).toMatchObject({ detached: true, text: 'my own brief' })
    expect(overlay.view.q('.cm-content')!.textContent).toBe('my own brief')
    await fake.run('regenerate')
    expect(overlay.last().preview.detached).toBe(false)
  })

  test('SC-37: while detached a control change or an idle source only adds a stale reason, and Start sends the edit as written', async () => {
    const { overlay, fake } = await opened((world) => {
      world.source.busy = true
    })
    await fake.run('edit', { text: 'edited brief' })
    await afterDebounce()
    const previews = fake.callsTo('preview').length
    expect(fake.callsTo('preview').at(-1)!.params.body).toBe('edited brief')

    await fake.run('set', { field: 'relationship', value: 'reviews' })
    await fake.emit(statusEvent('s_1', 'done'))
    await afterDebounce()
    expect(fake.callsTo('preview')).toHaveLength(previews)
    expect(overlay.last().preview.stale.sort()).toEqual(['controls', 'session'])
    expect(overlay.last().preview.text).toBe('edited brief')
    expect(overlay.view.text()).toContain('The edited preview is stale relative to newer controls, target data, or session context.')
    expect(overlay.last().preview.warnings.at(-1)).toEqual({
      code: 'stale',
      message: 'The edited preview is stale relative to newer controls, target data, or session context.'
    })

    await fake.run('start')
    const start = fake.callsTo('start')[0]!.params
    expect(start.body).toBe('edited brief')
    expect(start.shown).toBeUndefined()
    expect(start.controls.relationship).toBe('reviews')
  })

  test('SC-37: an attached start sends the shown text so the daemon can refuse a changed source', async () => {
    const { overlay, fake } = await opened()
    const shown = overlay.last().preview.text
    await fake.run('start')
    const start = fake.callsTo('start')[0]!.params
    expect(start.body).toBeUndefined()
    expect(start.shown).toBe(shown)
  })
})

describe('SC-39 and SC-40: secrets are marked in the editor', () => {
  test('SC-40: both ranges are marked with their excerpt, the line counts them, and an edit follows the new text', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    await v.type(v.q('textarea[aria-label="Steering note"]') as HTMLTextAreaElement, `${KEY} and ${ASSIGNMENT}`)
    await afterDebounce()

    expect(overlay.last().preview.secrets.map((hit: any) => hit.excerpt)).toEqual(['AKIA…', 'api_…'])
    const marks = v.all('.hf-secret')
    expect(marks.map((mark) => mark.textContent)).toEqual([KEY, ASSIGNMENT])
    expect(marks.map((mark) => mark.getAttribute('title'))).toEqual(['Potential secret: AKIA…', 'Potential secret: api_…'])
    expect(v.text()).toContain('2 potential secret markers are highlighted in the preview.')
    expect(overlay.last().preview.warnings.map((warning: any) => warning.message)).toEqual([
      '2 potential secrets found. Review the inline preview markers before starting.'
    ])
    expect(overlay.last().canStart).toBe(true)

    const text = overlay.last().preview.text as string
    const at = text.indexOf(KEY)
    await typeInPreview(v.q('.cm-editor')!.parentElement!, at, at + KEY.length, 'gone')
    await afterDebounce()
    expect(overlay.last().preview.detached).toBe(true)
    expect(fake.callsTo('preview').at(-1)!.params.body).toContain('gone and api_key')
    expect(overlay.last().preview.secrets).toHaveLength(1)
    expect(v.all('.hf-secret').map((mark) => mark.textContent)).toEqual([ASSIGNMENT])
    expect(v.text()).toContain('1 potential secret markers are highlighted in the preview.')
    expect(overlay.last().preview.characters).toBe((overlay.last().preview.text as string).length)
  })
})

describe('SC-42: Start is disabled until the dialog can start', () => {
  test('SC-42: while the first preview is loading Start is disabled for the probe and the repo state', async () => {
    const world = makeWorld()
    let release!: () => void
    world.previewGate = new Promise<void>((resolve) => void (release = resolve))
    const fake = fakeContext(daemon(world))
    const overlay = await mountOverlay(ui, fake)
    const pending = fake.run('open', { session: 's_1' })
    await settle(20)
    expect(overlay.last().shown).toBe(true)
    expect(overlay.last().canStart).toBe(false)
    expect(overlay.last().disabled).toEqual(expect.arrayContaining(['start:probe-loading', 'start:repo-state-loading']))
    expect(overlay.view.button('Start New Session')!.disabled).toBe(true)
    release()
    await pending
    await settle()
    expect(overlay.last().canStart).toBe(true)
  })

  test('SC-42: repo state off drops only the repo-state reason; no context and no target disable Start', async () => {
    const world = makeWorld()
    world.contextAvailable = false
    const fake = fakeContext(daemon(world))
    const overlay = await mountOverlay(ui, fake)
    await fake.run('open', { session: 's_1' })
    await settle()
    expect(overlay.last().disabled).toContain('start:no-context')
    expect(overlay.last().canStart).toBe(false)
    expect(await fake.run('start')).toEqual({ ok: false, reason: 'cannot-start' })
    expect(fake.callsTo('start')).toEqual([])
    await teardown(ui)

    const lost = await opened((w) => {
      delete w.controls.target
      w.source.worktreeId = null
    })
    expect(lost.overlay.last().disabled).toContain('start:no-target')
    expect(lost.overlay.last().canStart).toBe(false)
  })

  test('SC-42: a start in progress reads Starting… and stays disabled', async () => {
    const world = makeWorld()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => void (finish = resolve))
    const fake = fakeContext(
      daemon(world, {
        'quirky.handoff/start': async () => {
          await gate
          return { child: { session: 'c', tab: 't', worktreeId: 'wt_W' }, lineageId: null, worktreeCreated: null, delivery: 'pending' }
        }
      })
    )
    const overlay = await mountOverlay(ui, fake)
    await fake.run('open', { session: 's_1' })
    await settle()
    const running = fake.run('start')
    await settle(10)
    expect(overlay.last().starting).toBe(true)
    expect(overlay.last().disabled).toContain('start:starting')
    expect(overlay.view.button('Starting…')!.disabled).toBe(true)
    expect(overlay.view.button('Cancel')!.disabled).toBe(true)
    expect(await fake.run('cancel', { via: 'button' })).toEqual({ ok: false, reason: 'starting' })
    finish()
    await running
    await settle()
    expect(overlay.last().shown).toBe(false)
  })
})

describe('the recompose delay', () => {
  test('SC-3: several control changes inside the delay make one preview call, and a late answer for an older request is dropped', async () => {
    const { fake, overlay } = await opened()
    const before = fake.callsTo('preview').length
    await fake.run('set', { field: 'note', value: 'a' })
    await fake.run('set', { field: 'note', value: 'ab' })
    await fake.run('set', { field: 'note', value: 'abc' })
    expect(overlay.last().disabled).toContain('start:probe-loading')
    await afterDebounce()
    expect(fake.callsTo('preview')).toHaveLength(before + 1)
    expect(fake.callsTo('preview').at(-1)!.params.controls.note).toBe('abc')
    expect(overlay.last().preview.text).toContain('abc')
    expect(overlay.last().canStart).toBe(true)
  })

  test('SC-3: an answer that arrives after a newer change is dropped', async () => {
    const world = makeWorld()
    const slow: Array<() => void> = []
    const fake = fakeContext(
      daemon(world, {
        'quirky.handoff/preview': (params) =>
          new Promise((resolve) => {
            const answer = () => resolve(import('./support').then((support) => support.previewOf(world, params)))
            if (params.controls.note === 'slow') slow.push(answer)
            else answer()
          })
      })
    )
    const overlay = await mountOverlay(ui, fake)
    await fake.run('open', { session: 's_1' })
    await settle()
    await fake.run('set', { field: 'note', value: 'slow' })
    await afterDebounce()
    await fake.run('set', { field: 'note', value: 'fast' })
    await afterDebounce()
    expect(overlay.last().preview.text).toContain('fast')
    await act(async () => {
      slow.forEach((answer) => answer())
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(overlay.last().preview.text).toContain('fast')
    expect(overlay.last().preview.text).not.toContain('slow')
  })
})
