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
  previewOf,
  rpcError,
  settle,
  teardown,
  type Handler,
  type Ui
} from './support'

let ui: Ui

beforeAll(async () => {
  registerDom()
  ui = (await import('../../src/ui')) as Ui
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(() => teardown(ui))

async function opened(configure: (world: ReturnType<typeof makeWorld>) => void = () => {}, overrides: Record<string, Handler> = {}, session = 's_1') {
  const world = makeWorld()
  configure(world)
  const fake = fakeContext(daemon(world, overrides))
  const overlay = await mountOverlay(ui, fake)
  await fake.run('open', { session })
  await settle()
  return { world, fake, overlay }
}

const pressEscape = () =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

describe('SC-9, SC-46 and SC-47: a start that fails keeps the dialog and its fields', () => {
  test('SC-9: a worktree creation failure shows its message in the strip and changes no field', async () => {
    const { overlay, fake } = await opened(
      () => {},
      {
        'quirky.handoff/start': () => {
          throw rpcError("fatal: 'no-such-branch' is not a commit", { reason: 'worktree-create-failed', message: "fatal: 'no-such-branch' is not a commit" })
        }
      }
    )
    await fake.run('set', { field: 'create', value: true })
    await fake.run('set', { field: 'createName', value: 'next' })
    await fake.run('set', { field: 'createBase', value: 'no-such-branch' })
    await fake.run('set', { field: 'note', value: 'keep me' })
    await fake.run('set', { field: 'diffBodies', value: true })
    await afterDebounce()
    const before = overlay.last().controls

    const result = await fake.run('start')
    await settle()
    expect(result.ok).toBe(false)
    expect(fake.callsTo('start')[0]!.params.controls.target).toEqual({ create: { name: 'next', base: 'no-such-branch' } })
    expect(overlay.last().shown).toBe(true)
    expect(overlay.last().error).toBe("fatal: 'no-such-branch' is not a commit")
    expect(overlay.view.q('[role="alert"]')!.textContent).toBe("fatal: 'no-such-branch' is not a commit")
    expect(overlay.last().controls).toEqual(before)
    expect(overlay.last().starting).toBe(false)
  })

  test('SC-9: a failure after the worktree was created selects it and turns create mode off', async () => {
    const { overlay, fake } = await opened(
      () => {},
      {
        'quirky.handoff/start': () => {
          throw rpcError('The selected Agent is no longer available on the target host.', {
            reason: 'agent-unavailable',
            worktreeCreated: { id: 'wt_new', name: 'next', path: '/work/next' }
          })
        }
      }
    )
    await fake.run('set', { field: 'create', value: true })
    await fake.run('set', { field: 'createName', value: 'next' })
    await afterDebounce()
    await fake.run('start')
    await settle()

    expect(overlay.last().controls.target).toEqual({ worktree: 'wt_new' })
    expect(overlay.last().candidates.map((candidate: any) => candidate.id)).toContain('wt_new')
    expect(overlay.last().error).toBe('The selected Agent is no longer available on the target host.')
    expect(overlay.view.button('Create a new worktree')).not.toBeNull()
    expect(overlay.view.q('[aria-label="Worktree"]')!.textContent).toBe('next')

    await fake.run('start')
    expect(fake.callsTo('start')[1]!.params.controls.target).toEqual({ worktree: 'wt_new' })
  })

  test('SC-46 and SC-47: the daemon messages show in the strip and every field stays', async () => {
    const { overlay, fake } = await opened(
      () => {},
      {
        'quirky.handoff/start': () => {
          throw rpcError('Could not start the new Agent session. Your handoff is unchanged.', { reason: 'launch-failed' })
        }
      }
    )
    await fake.run('set', { field: 'note', value: 'keep me' })
    await fake.run('set', { field: 'agent', value: 'codex' })
    await afterDebounce()
    await fake.run('start')
    await settle()
    expect(overlay.last().error).toBe('Could not start the new Agent session. Your handoff is unchanged.')
    expect(overlay.last().controls).toMatchObject({ note: 'keep me', agent: 'codex' })
    expect(overlay.last().shown).toBe(true)
    expect(fake.callsTo('draft')).toEqual([])
  })
})

describe('SC-45: an attached preview that went out of date is refused', () => {
  test('SC-45: the fresh preview replaces the text and the message shows', async () => {
    const world = makeWorld()
    const fresh = () => ({ ...previewOf(world, { controls: world.controls }), brief: 'FRESH brief after the source printed more' })
    const { overlay, fake } = await opened(
      () => {},
      {
        'quirky.handoff/start': () => {
          throw rpcError('The source session changed. The preview was refreshed — review it, then start again.', {
            reason: 'source-changed',
            preview: fresh()
          })
        }
      }
    )
    await fake.run('start')
    await settle()
    expect(overlay.last().error).toBe('The source session changed. The preview was refreshed — review it, then start again.')
    expect(overlay.last().preview.text).toBe('FRESH brief after the source printed more')
    expect(overlay.view.q('.cm-content')!.textContent).toBe('FRESH brief after the source printed more')
    expect(overlay.last().shown).toBe(true)
    expect(overlay.last().preview.detached).toBe(false)
  })
})

describe('SC-48: a successful start', () => {
  test('SC-48: closes the dialog and saves no draft', async () => {
    const { overlay, fake } = await opened()
    await fake.run('set', { field: 'note', value: 'go' })
    await afterDebounce()
    expect(await fake.run('start')).toEqual({ ok: true })
    await settle()
    expect(overlay.last().shown).toBe(false)
    expect(overlay.view.q('[role="dialog"]')).toBeNull()
    expect(fake.callsTo('start')).toHaveLength(1)
    expect(fake.callsTo('start')[0]!.params.source).toEqual({ session: 's_1' })
    expect(fake.callsTo('draft')).toEqual([])
  })

  test('SC-48: clicking Start New Session runs the start', async () => {
    const { overlay, fake } = await opened()
    await overlay.view.click(overlay.view.button('Start New Session'))
    await settle()
    expect(fake.callsTo('start')).toHaveLength(1)
    expect(overlay.last().shown).toBe(false)
  })
})

describe('SC-58, SC-59 and SC-60: Cancel and Escape keep a draft', () => {
  test('SC-58: Cancel saves the controls, and reopening from the same session restores them while another session shows none', async () => {
    const { overlay, fake } = await opened()
    await fake.run('set', { field: 'note', value: 'keep this' })
    await fake.run('set', { field: 'agent', value: 'codex' })
    await fake.run('set', { field: 'diffBodies', value: true })
    await afterDebounce()

    await overlay.view.click(overlay.view.button('Cancel'))
    await settle()
    expect(overlay.last().shown).toBe(false)
    const draft = fake.callsTo('draft')[0]!.params
    expect(draft.source).toEqual({ session: 's_1' })
    expect(draft.draft).toEqual({
      controls: {
        target: { worktree: 'wt_W' },
        agent: 'codex',
        relationship: 'continues',
        context: 'focused',
        include: { repoState: true, diffBodies: true, openEditorTabs: true },
        templateId: null,
        note: 'keep this'
      },
      preview: null
    })

    await fake.run('open', { session: 's_1' })
    await settle()
    expect(overlay.last().controls).toMatchObject({ note: 'keep this', agent: 'codex', include: { diffBodies: true } })
    expect((overlay.view.q('textarea[aria-label="Steering note"]') as HTMLTextAreaElement).value).toBe('keep this')

    await fake.run('cancel', { via: 'button' })
    await fake.run('open', { session: 's_2' })
    await settle()
    expect(overlay.last().controls).toMatchObject({ note: '', agent: 'claude', include: { diffBodies: false } })
  })

  test('SC-59: Escape with focus in the note saves the draft and closes, and the note is back on reopen', async () => {
    const { overlay, fake } = await opened()
    const note = overlay.view.q('textarea[aria-label="Steering note"]') as HTMLTextAreaElement
    await overlay.view.type(note, 'keep this')
    note.focus()
    await pressEscape()
    expect(overlay.last().shown).toBe(false)
    expect(fake.callsTo('draft')).toHaveLength(1)
    expect(fake.callsTo('draft')[0]!.params.draft.controls.note).toBe('keep this')

    await fake.run('open', { session: 's_1' })
    await settle()
    expect((overlay.view.q('textarea[aria-label="Steering note"]') as HTMLTextAreaElement).value).toBe('keep this')
  })

  test('SC-58: a draft that cannot be saved keeps the dialog open with every field and the edited text', async () => {
    let fail = true
    const { overlay, fake } = await opened(() => {}, {
      'quirky.handoff/draft': () => {
        if (fail) throw rpcError('The daemon is not reachable')
        return { ok: true }
      }
    })
    await fake.run('set', { field: 'note', value: 'keep this' })
    await fake.run('edit', { text: 'my edited brief' })
    await afterDebounce()

    expect(await fake.run('cancel', { via: 'button' })).toMatchObject({ ok: false })
    expect(overlay.last().shown).toBe(true)
    expect(overlay.last().error).toContain('The daemon is not reachable')
    expect(overlay.view.text()).toContain('The daemon is not reachable')
    expect(overlay.last().controls.note).toBe('keep this')
    expect(overlay.last().preview).toMatchObject({ detached: true, text: 'my edited brief' })

    await pressEscape()
    expect(overlay.last().shown).toBe(true)
    expect(overlay.last().preview.text).toBe('my edited brief')

    fail = false
    await fake.run('cancel', { via: 'button' })
    expect(overlay.last().shown).toBe(false)
  })

  test('SC-59: Escape is not passed on to the rest of the window', async () => {
    await opened()
    let reached = false
    const later = () => void (reached = true)
    window.addEventListener('keydown', later)
    await pressEscape()
    window.removeEventListener('keydown', later)
    expect(reached).toBe(false)
  })

  test('SC-59: Escape closes an open worktree list before the dialog', async () => {
    const { overlay, fake } = await opened()
    await overlay.view.click(overlay.view.q('[aria-label="Worktree"]'))
    await pressEscape()
    expect(overlay.last().shown).toBe(true)
    expect(fake.callsTo('draft')).toEqual([])
  })

  test('SC-59: Escape while a start runs does nothing', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => void (finish = resolve))
    const { overlay, fake } = await opened(() => {}, {
      'quirky.handoff/start': async () => {
        await gate
        return { child: { session: 'c', tab: 't', worktreeId: 'wt_W' }, lineageId: null, worktreeCreated: null, delivery: 'pending' }
      }
    })
    const running = fake.run('start')
    await settle(10)
    await pressEscape()
    expect(fake.callsTo('draft')).toEqual([])
    finish()
    await running
    expect(overlay.last().shown).toBe(false)
  })

  test('SC-60: a detached draft keeps its edited text and stale reasons, and reopening shows it still detached', async () => {
    const { overlay, fake } = await opened()
    await fake.run('edit', { text: 'my edited brief' })
    await afterDebounce()
    await fake.run('set', { field: 'relationship', value: 'reviews' })
    await fake.run('cancel', { via: 'escape' })
    expect(fake.callsTo('draft')[0]!.params.draft.preview).toEqual({ text: 'my edited brief', stale: ['controls'] })

    await fake.run('open', { session: 's_1' })
    await settle()
    expect(overlay.last().preview).toMatchObject({ text: 'my edited brief', detached: true, stale: ['controls'] })
    expect(overlay.last().controls.relationship).toBe('reviews')
    expect(fake.callsTo('preview').at(-1)!.params.body).toBe('my edited brief')
    expect(overlay.view.text()).toContain('The preview is no longer auto-updating.')
    expect(overlay.view.q('.cm-content')!.textContent).toBe('my edited brief')
  })
})

describe('SC-50 and SC-51: resending a brief', () => {
  test('SC-50: resend-confirm asks the exact question with Send again, and Send again resends', async () => {
    const world = makeWorld()
    const fake = fakeContext(daemon(world))
    await mountOverlay(ui, fake)
    expect(await fake.run('resend-confirm', { session: 's_child' })).toEqual({ ok: true })
    expect(fake.confirms).toEqual([{ title: 'The brief may already have arrived. Sending again can create a duplicate turn.', confirmLabel: 'Send again' }])
    expect(fake.callsTo('resend')[0]!.params).toEqual({ session: 's_child' })
  })

  test('SC-50: Cancel on the confirmation does nothing', async () => {
    const world = makeWorld()
    const fake = fakeContext(daemon(world), { confirm: () => false })
    await mountOverlay(ui, fake)
    expect(await fake.run('resend-confirm', { session: 's_child' })).toEqual({ ok: false, reason: 'cancelled' })
    expect(fake.callsTo('resend')).toEqual([])
    expect(fake.toasts).toEqual([])
  })

  test('SC-51: a resend that fails with no brief toasts the daemon message', async () => {
    const world = makeWorld()
    const fake = fakeContext(
      daemon(world, {
        'quirky.handoff/resend': () => {
          throw rpcError('No brief is kept for this session.', { reason: 'no-brief' })
        }
      })
    )
    await mountOverlay(ui, fake)
    expect((await fake.run('resend-confirm', { session: 's_child' })).ok).toBe(false)
    expect(fake.toasts).toEqual([{ title: 'Could not resend the brief', body: 'No brief is kept for this session.', options: undefined }])
  })

  test('SC-51: dismissing the toast discards the retained brief', async () => {
    const fake = fakeContext(daemon(makeWorld()))
    await mountOverlay(ui, fake)
    expect(await fake.run('discard', { session: 's_child' })).toEqual({ ok: true })
    expect(fake.callsTo('discard')[0]!.params).toEqual({ session: 's_child' })
  })
})

describe('SC-54 and SC-55: the badge jump', () => {
  test('SC-54: jump calls the daemon with the session and the lineage record', async () => {
    const fake = fakeContext(daemon(makeWorld()))
    await mountOverlay(ui, fake)
    expect(await fake.run('jump', { session: 's_1', lineage: 'l_1' })).toEqual({ ok: true })
    expect(fake.callsTo('jump')[0]!.params).toEqual({ session: 's_1', lineage: 'l_1' })
    await fake.run('jump', { session: 's_1' })
    expect(fake.callsTo('jump')[1]!.params).toEqual({ session: 's_1' })
  })

  test('SC-55: a jump with nothing to go to toasts the reason', async () => {
    let message = 'No live pane is available.'
    const fake = fakeContext(
      daemon(makeWorld(), {
        'quirky.handoff/jump': () => {
          throw rpcError(message, { reason: 'no-live-pane' })
        }
      })
    )
    await mountOverlay(ui, fake)
    expect((await fake.run('jump', { session: 's_1', lineage: 'l_1' })).ok).toBe(false)
    message = 'worktree removed'
    await fake.run('jump', { session: 's_1', lineage: 'l_1' })
    expect(fake.toasts.map((toast) => toast.title)).toEqual(['No live pane is available.', 'worktree removed'])
  })
})

describe('SC-63: the whole dialog is drivable through commands', () => {
  test('SC-63: open, set the agent, type a note, edit the preview, regenerate and start, with a report after each', async () => {
    const world = makeWorld()
    const fake = fakeContext(daemon(world))
    const overlay = await mountOverlay(ui, fake)

    await fake.run('open', { session: 's_1' })
    await settle()
    expect(overlay.last()).toMatchObject({ shown: true, canStart: true, controls: { agent: 'claude', note: '' } })

    await fake.run('set', { field: 'agent', value: 'codex' })
    expect(overlay.last().controls.agent).toBe('codex')

    await fake.run('set', { field: 'note', value: 'Run the tests first' })
    expect(overlay.last().controls.note).toBe('Run the tests first')
    await afterDebounce()
    expect(overlay.last().preview.text).toContain('## Operator steering note')
    expect(overlay.last().preview.detached).toBe(false)

    await fake.run('edit', { text: 'edited by a script' })
    await afterDebounce()
    expect(overlay.last().preview).toMatchObject({ text: 'edited by a script', detached: true, characters: 'edited by a script'.length, secrets: [], stale: [] })

    await fake.run('regenerate')
    expect(overlay.last().preview.detached).toBe(false)
    expect(overlay.last().preview.text).toContain('Run the tests first')

    await fake.run('start')
    await settle()
    expect(fake.callsTo('start')[0]!.params.controls).toMatchObject({ agent: 'codex', note: 'Run the tests first' })
    expect(overlay.last().shown).toBe(false)
  })

  test('SC-63: every command the manifest declares is provided', async () => {
    const fake = fakeContext(daemon(makeWorld()))
    await mountOverlay(ui, fake)
    const manifest = (await import('../../quirky-plugin.json')).default as { contributes: { command: { id: string }[] } }
    for (const { id } of manifest.contributes.command) expect(fake.provided.has(`command:quirky.handoff/${id}`)).toBe(true)
  })
})

describe('a templates change elsewhere', () => {
  test('SC-24: a removed selected template reads as none in an open dialog', async () => {
    const { overlay, fake, world } = await opened((w) => {
      w.controls.templateId = 'debug-failure'
    })
    expect(overlay.last().controls.templateId).toBe('debug-failure')
    world.templates = world.templates.filter((template) => template.id !== 'debug-failure')
    await fake.emit({ type: 'quirky.handoff/changed', data: { kind: 'templates' } } as never)
    await afterDebounce()
    expect(overlay.last().controls.templateId).toBeNull()
    expect((overlay.view.q('select[aria-label="Reusable template"]') as HTMLSelectElement).options).toHaveLength(4)
  })
})
