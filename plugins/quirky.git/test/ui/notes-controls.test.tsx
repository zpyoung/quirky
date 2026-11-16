import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Fake, Mounted } from './support'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The fixture imports React and CodeMirror only after Happy DOM has installed its DOM globals.
const s = await import('./support')
const { act, click, fakeContext, layoutFor, mountView, reviewFile, reviewModel, settle, textDiff } = s

afterAll(() => GlobalRegistrator.unregister())

type TestNote = { id: string; worktreeId: string; path: string; startLine: number; line: number; body: string; createdAt: number; updatedAt: number | null }
type Address = { surface: string; target: string; generation: string; actions: string[] }
type Control = { surface: string; target: string; generation: string; action: string; data?: Record<string, unknown> }
type Toast = { title: string; body: string; options: unknown }

const input = { worktree: 'w1', mode: 'review' }
const TARGETS = { sessions: [], agents: [{ id: 'claude', label: 'Claude' }] }
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join('')
const diff = textDiff({ original: numbered(40), modified: numbered(40).replace('line 20\n', 'twenty\n') })
const note = (id: string, path = 'math.ts', line = 30, body = `Note ${id}`): TestNote => ({
  id, worktreeId: 'w1', path, startLine: line, line, body, createdAt: 1, updatedAt: null
})

let fake: Fake
let mounted: Mounted | null = null
let notes: TestNote[] = []
let toasts: Toast[] = []

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T>(selector)
const qa = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => [...root.querySelectorAll<T>(selector)]
const text = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
const cards = (root: ParentNode) => qa(root, '[data-note-card="saved"]')
const buttonIn = (root: ParentNode, label: string) => qa<HTMLButtonElement>(root, 'button').find((button) => text(button) === label || button.getAttribute('aria-label') === label) ?? null
const textareaIn = (root: ParentNode) => q<HTMLTextAreaElement>(root, 'textarea')
const addresses = (): Address[] => ((mounted?.report().uiControls ?? []) as Address[]).filter(({ target }) => target === 'notes:w1')
const control = (generation: string, action: string, id: string): Control => ({
  surface: 'view:quirky.git/diff', target: 'notes:w1', generation, action, data: { id }
})
const run = async (args: Control) => {
  let result: unknown
  await act(async () => { result = await fake.run('ui-control', args) })
  await settle()
  return result
}

async function open(initial: TestNote[], configure?: (context: Fake) => void) {
  notes = [...initial]
  fake.handlers['quirky.git/review'] = () => reviewModel([reviewFile('math.ts')])
  fake.handlers['quirky.git/diff'] = (params) => ({ ...diff, path: params.path as string, source: params.source as typeof diff.source })
  fake.handlers['quirky.git/notes'] = () => ({ notes })
  fake.handlers['quirky.git/noteTargets'] = () => TARGETS
  configure?.(fake)
  mounted = mountView(fake, input)
  await settle()
  return mounted
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
  toasts = []
  fake.context.toast = (title, body, options) => {
    fake.toasts.push([title, body])
    toasts.push({ title, body, options })
  }
  fake.handlers['ui.window.self'] = () => ({ connId: 22 })
  fake.handlers['ui.window.command.run'] = async (params) => ({ result: await fake.run('ui-control', params.args) })
})

afterEach(async () => {
  mounted?.unmount()
  mounted = null
  await settle()
})

const setValue = async (area: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

const press = async (target: Element, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => void target.dispatchEvent(event))
  await settle()
  return event
}

describe('saved note mounted controls', () => {
  test('one address serves every mounted card; Edit, Cancel and Escape use its exact-window bridge', async () => {
    const { element } = await open([note('n1'), note('n2', 'math.ts', 15)])
    const [address] = addresses()
    expect(addresses()).toHaveLength(1)
    expect(address).toMatchObject({ surface: 'view:quirky.git/diff', target: 'notes:w1', actions: ['edit', 'cancel-edit'] })
    expect(typeof address!.generation).toBe('string')
    const first = element.querySelector<HTMLElement>('[data-note-id="n1"]')
    expect(first).not.toBeNull()

    await click(buttonIn(first!, 'Edit note'))
    expect(textareaIn(first!)?.value).toBe('Note n1')
    expect(fake.callsTo('ui.window.command.run').at(-1)?.params).toEqual({
      connId: 22,
      id: 'command:quirky.git/ui-control',
      args: { ...control(address!.generation, 'edit', 'n1') }
    })

    await setValue(textareaIn(first!)!, 'changed once')
    await click(buttonIn(first!, 'Cancel'))
    expect(text(q(first!, 'p'))).toBe('Note n1')
    expect(fake.callsTo('ui.window.command.run').at(-1)?.params.args).toEqual(control(address!.generation, 'cancel-edit', 'n1'))

    await click(buttonIn(first!, 'Edit note'))
    const escape = await press(textareaIn(first!)!, 'Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(text(q(first!, 'p'))).toBe('Note n1')
    expect(fake.callsTo('ui.window.command.run').at(-1)?.params.args).toEqual(control(address!.generation, 'cancel-edit', 'n1'))
  })

  test('refuses unknown and already-editing ids, ambiguous duplicate ids, and cancel during a pending edit', async () => {
    const { element } = await open([note('n1')])
    const generation = addresses()[0]!.generation
    expect(await run(control(generation, 'edit', 'missing'))).toEqual({ delivered: false })
    expect(await run(control(generation, 'edit', 'n1'))).toEqual({ delivered: true })
    expect(await run(control(generation, 'edit', 'n1'))).toEqual({ delivered: false })
    expect(textareaIn(cards(element)[0]!)?.value).toBe('Note n1')

    mounted?.unmount()
    mounted = null
    await settle()
    const duplicate = await open([note('same', 'math.ts', 10), note('same', 'math.ts', 25)])
    const duplicateGeneration = addresses()[0]!.generation
    expect(addresses()).toHaveLength(1)
    expect(await run(control(duplicateGeneration, 'edit', 'same'))).toEqual({ delivered: false })
    expect(cards(duplicate.element).every((card) => textareaIn(card) === null)).toBe(true)

    duplicate.unmount()
    mounted = null
    await settle()
    const { promise: pending, resolve: finishEdit } = Promise.withResolvers<void>()
    const { element: pendingElement } = await open([note('n1')], (fixture) => {
      fixture.handlers['quirky.git/editNote'] = async () => {
        await pending
        return { note: note('n1', 'math.ts', 30, 'updated') }
      }
    })
    const pendingGeneration = addresses()[0]!.generation
    const pendingCard = cards(pendingElement)[0]!
    await click(buttonIn(pendingCard, 'Edit note'))
    await setValue(textareaIn(pendingCard)!, 'updated')
    await click(buttonIn(pendingCard, 'Save'))
    expect(fake.callsTo('quirky.git/editNote')).toHaveLength(1)
    expect(await run(control(pendingGeneration, 'cancel-edit', 'n1'))).toEqual({ delivered: false })
    expect(textareaIn(pendingCard)).not.toBeNull()
    finishEdit()
    await settle()
    expect(textareaIn(pendingCard)).toBeNull()
  })

  test('a fresh generation is registered after the last card unmounts and remounts', async () => {
    const { element } = await open([note('n1')])
    const oldGeneration = addresses()[0]!.generation
    notes = []
    await act(async () => fake.emit({ type: 'quirky.git/notesChanged', data: { worktreeId: 'w1' } } as never))
    await settle()
    expect(cards(element)).toHaveLength(0)
    expect(addresses()).toEqual([])
    expect(await run(control(oldGeneration, 'edit', 'n1'))).toEqual({ delivered: false })

    notes = [note('n1')]
    await act(async () => fake.emit({ type: 'quirky.git/notesChanged', data: { worktreeId: 'w1' } } as never))
    await settle()
    const newGeneration = addresses()[0]!.generation
    expect(newGeneration).not.toBe(oldGeneration)
    expect(await run(control(oldGeneration, 'edit', 'n1'))).toEqual({ delivered: false })
    expect(await run(control(newGeneration, 'edit', 'n1'))).toEqual({ delivered: true })
  })

  test('delivery refusal, malformed reply and bridge rejection show the shared failure toast without changing the card', async () => {
    const { element } = await open([note('n1')])
    const card = cards(element)[0]!
    const failures: Array<{ reply?: unknown; error?: Error; body: string }> = [
      { reply: { result: { delivered: false } }, body: 'The note action is no longer available.' },
      { reply: { result: {} }, body: 'The note action is no longer available.' },
      { error: new Error('bridge down'), body: 'bridge down' }
    ]
    for (const failure of failures) {
      fake.handlers['ui.window.command.run'] = async () => {
        if (failure.error) throw failure.error
        return failure.reply
      }
      await click(buttonIn(card, 'Edit note'))
      expect(toasts.at(-1)).toEqual({
        title: 'Could not run Source Control action', body: failure.body, options: { kind: 'error' }
      })
      expect(text(q(card, 'p'))).toBe('Note n1')
      expect(textareaIn(card)).toBeNull()
    }
  })

  test('a failed bridge reply arriving after its card unmounts does not toast', async () => {
    const { element } = await open([note('n1'), note('n2', 'math.ts', 15)])
    const selected = cards(element)[0]!
    const { promise, resolve: release } = Promise.withResolvers<unknown>()
    fake.handlers['ui.window.command.run'] = () => promise
    const before = toasts.length
    await click(buttonIn(selected, 'Edit note'))

    notes = [text(q(selected, 'p')) === 'Note n1' ? note('n2', 'math.ts', 15) : note('n1')]
    await act(async () => fake.emit({ type: 'quirky.git/notesChanged', data: { worktreeId: 'w1' } } as never))
    await settle()
    expect(cards(element)).toHaveLength(1)
    expect(addresses()).toHaveLength(1)
    release({ result: { delivered: false } })
    await settle(12)
    expect(toasts).toHaveLength(before)
  })
})

describe('note failure toast kinds', () => {
  test('edit and delete failures are error toasts', async () => {
    const { element } = await open([note('n1')], (fixture) => {
      fixture.handlers['quirky.git/editNote'] = () => { throw new Error('edit failed') }
      fixture.handlers['quirky.git/deleteNote'] = () => { throw new Error('delete failed') }
    })
    const card = cards(element)[0]!
    await click(buttonIn(card, 'Edit note'))
    await setValue(textareaIn(card)!, 'updated')
    await click(buttonIn(card, 'Save'))
    expect(toasts.at(-1)).toEqual({ title: 'Failed to save comment', body: 'edit failed', options: { kind: 'error' } })
    await click(buttonIn(card, 'Cancel'))
    await click(buttonIn(card, 'Delete note'))
    expect(toasts.at(-1)).toEqual({ title: 'Failed to delete note', body: 'delete failed', options: { kind: 'error' } })
  })

  test('notes read failures are error toasts', async () => {
    await open([], (fixture) => {
      fixture.handlers['quirky.git/notes'] = () => { throw new Error('notes failed') }
    })
    expect(toasts).toContainEqual({ title: 'Failed to load notes', body: 'notes failed', options: { kind: 'error' } })
  })

  test('agent lookup and send failures are error toasts; progress and success stay untyped', async () => {
    const { element } = await open([note('n1')])
    const card = cards(element)[0]!
    fake.handlers['quirky.git/noteTargets'] = () => { throw new Error('agents failed') }
    await click(buttonIn(card, 'Send notes to an agent'))
    expect(toasts.at(-1)).toEqual({ title: 'Failed to load agents', body: 'agents failed', options: { kind: 'error' } })

    fake.handlers['quirky.git/noteTargets'] = () => TARGETS
    fake.handlers['quirky.git/sendNotes'] = () => { throw new Error('send failed') }
    await click(buttonIn(card, 'Send notes to an agent'))
    const menu = q(document.body, '[role="menu"][aria-label="Send notes"]')!
    await click(buttonIn(menu, 'Claude'))
    expect(toasts.slice(-2)).toEqual([
      { title: 'Sending notes...', body: '', options: undefined },
      { title: 'Failed to send notes', body: 'send failed', options: { kind: 'error' } }
    ])

    fake.handlers['quirky.git/sendNotes'] = () => ({ ok: true })
    await click(buttonIn(card, 'Send notes to an agent'))
    const nextMenu = q(document.body, '[role="menu"][aria-label="Send notes"]')!
    await click(buttonIn(nextMenu, 'Claude'))
    expect(toasts.slice(-2)).toEqual([
      { title: 'Sending notes...', body: '', options: undefined },
      { title: 'Notes sent.', body: '', options: undefined }
    ])
  })
})
