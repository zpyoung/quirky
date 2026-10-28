import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import {
  afterDebounce,
  daemon,
  fakeContext,
  folderF,
  makeWorld,
  mountOverlay,
  rpcError,
  settle,
  teardown,
  wtW2,
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

async function opened(configure: (world: ReturnType<typeof makeWorld>) => void = () => {}) {
  const world = makeWorld()
  configure(world)
  const fake = fakeContext(daemon(world))
  const overlay = await mountOverlay(ui, fake)
  const result = await fake.run('open', { session: 's_1' })
  await settle()
  return { world, fake, overlay, result }
}

describe('SC-1: the overlay and its menu command', () => {
  test('SC-1: the overlay reports shown false until the open command runs, then shows the dialog titled Continue in New Session', async () => {
    const world = makeWorld()
    const fake = fakeContext(daemon(world))
    const overlay = await mountOverlay(ui, fake)
    expect(overlay.last().shown).toBe(false)
    expect(overlay.view.q('[role="dialog"]')).toBeNull()

    await fake.run('open', { session: 's_1' })
    await settle()
    expect(overlay.last().shown).toBe(true)
    expect(overlay.view.q('[role="dialog"]')!.getAttribute('aria-label')).toBe('Continue in New Session')
    expect(overlay.view.q('h2')!.textContent).toBe('Continue in New Session')
    expect(fake.callsTo('prepare')[0]!.params).toEqual({ source: { session: 's_1' } })
  })
  test('an archived-source command opens the dialog with the archived provider identity and context', async () => {
    const world = makeWorld()
    const firstPrompt = `Full archived prompt ${'literal source context '.repeat(200)}`
    const archived = {
      agent: 'claude',
      providerSessionId: 'provider-archive-42',
      transcriptPath: '/owned/source/.claude/projects/work/archive.jsonl',
      title: 'Archived migration',
      worktree: 'wt_W',
      cwd: '/work/W',
      prompt: firstPrompt,
      lastMessage: 'The latest assistant response'
    }
    world.source = {
      ...world.source,
      key: 'archived:claude:provider-archive-42',
      session: null,
      title: archived.title,
      providerSessionId: archived.providerSessionId,
      transcriptPath: archived.transcriptPath,
      cwd: archived.cwd,
      prompt: firstPrompt,
      lastMessage: archived.lastMessage,
      live: false,
      busy: false
    }
    const fake = fakeContext(daemon(world))
    const overlay = await mountOverlay(ui, fake)

    expect(await fake.run('open-archived', { source: { archived } })).toEqual({ ok: true })
    await settle()

    expect(fake.callsTo('prepare')[0]!.params).toEqual({ source: { archived } })
    expect(overlay.last().source).toMatchObject({
      session: null,
      agent: 'claude',
      title: archived.title,
      cwd: archived.cwd,
      providerSessionId: archived.providerSessionId,
      transcriptPath: archived.transcriptPath,
      prompt: firstPrompt,
      lastMessage: archived.lastMessage,
      live: false,
      busy: false
    })
    expect(overlay.view.text()).toContain('Archived migration')
    expect(overlay.last().shown).toBe(true)
  })


  test('SC-63: a closed overlay reports the whole W1 shape', async () => {
    const overlay = await mountOverlay(ui, fakeContext(daemon(makeWorld())))
    expect(Object.keys(overlay.last()).sort()).toEqual(
      ['agents', 'busy', 'canStart', 'candidates', 'controls', 'disabled', 'error', 'preview', 'shown', 'source', 'starting', 'templateEditor'].sort()
    )
    expect(Object.keys(overlay.last().preview).sort()).toEqual(['characters', 'detached', 'secrets', 'stale', 'text', 'tokens', 'warnings'])
    expect(overlay.last()).toMatchObject({ shown: false, canStart: false, starting: false, error: null, candidates: [], disabled: [] })
  })
})

describe('SC-2: no context, no dialog', () => {
  test('SC-2: a no-context refusal toasts the message and shows no dialog', async () => {
    const world = makeWorld()
    world.prepareError = rpcError('No session context is available to continue in a new session.', { reason: 'no-context' })
    const fake = fakeContext(daemon(world))
    const overlay = await mountOverlay(ui, fake)
    const result = await fake.run('open', { session: 's_1' })
    await settle()
    expect(result).toEqual({ ok: false, reason: 'no-context' })
    expect(fake.toasts).toEqual([{ title: 'No session context is available to continue in a new session.', body: '', options: undefined }])
    expect(overlay.last().shown).toBe(false)
    expect(overlay.view.q('[role="dialog"]')).toBeNull()
    expect(fake.callsTo('preview')).toEqual([])
  })
})

describe('SC-3: the dialog opens on the defaults', () => {
  test('SC-3: description, source card, destination, content, notes and the preview with its cost and locked note', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    expect(v.text()).toContain('Review and customize the brief, destination, and delivery for a fresh Agent session. The source stays running.')
    expect(v.q('[data-source]')!.textContent).toContain('Fix parser')
    expect(v.q('[data-source]')!.textContent).toContain('Original Agent: claude')
    expect(v.q('[aria-label="Worktree"]')!.textContent).toBe('W')
    expect(v.text()).toContain('/work/W')
    expect((v.q('select[aria-label="Agent"]') as HTMLSelectElement).value).toBe('claude')
    expect((v.q('select[aria-label="Relationship"]') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Continues')
    const radios = v.all('input[type="radio"]') as HTMLInputElement[]
    expect(radios.map((radio) => radio.checked)).toEqual([true, false])
    expect(v.text()).toContain('Focused handoff (Recommended)')
    expect(v.text()).toContain('Carries status hints and reads older transcript details only when needed.')
    const checks = v.all('input[type="checkbox"]') as HTMLInputElement[]
    expect(checks.map((check) => check.checked)).toEqual([true, false, true])
    expect(v.text()).toContain('Git status and changed file paths')
    expect(v.text()).toContain('Opt-in and capped at 12,000 characters.')
    expect((v.q('select[aria-label="Reusable template"]') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('No template')
    expect((v.q('textarea[aria-label="Steering note"]') as HTMLTextAreaElement).value).toBe('')
    expect(v.q('textarea[aria-label="Steering note"]')!.getAttribute('rows')).toBe('4')
    expect(v.q('textarea[aria-label="Steering note"]')!.getAttribute('placeholder')).toBe('What should the new Agent focus on?')
    expect(v.text()).toMatch(/\d+ characters · about \d+ tokens/)
    expect(v.text()).toContain('Brief preview')
    expect(v.text()).toContain('Locked safety note · always appended last')
    expect(v.text()).not.toContain('Could not refresh repository state')
    expect(v.q('.cm-content')!.textContent).toContain('Continue work from the prior Quirky session.')
    expect(v.q('.cm-lineNumbers')).not.toBeNull()
    expect(v.button('Cancel')).not.toBeNull()
    expect(v.button('Start New Session')!.disabled).toBe(false)
    expect(fake.callsTo('preview')).toHaveLength(1)
  })

  test('SC-3: the report carries the same fields the window shows', async () => {
    const { overlay } = await opened()
    const report = overlay.last()
    expect(report.controls).toEqual({
      target: { worktree: 'wt_W' },
      agent: 'claude',
      relationship: 'continues',
      context: 'focused',
      include: { repoState: true, diffBodies: false, openEditorTabs: true },
      templateId: null,
      note: ''
    })
    expect(report.source).toMatchObject({ session: 's_1', agent: 'claude', canCreateWorktree: true })
    expect(report.preview).toMatchObject({ detached: false, stale: [], warnings: [], secrets: [] })
    expect(report.preview.text).toContain('Continue work from the prior Quirky session.')
    expect(report.preview.characters).toBe(report.preview.text.length)
    expect(report).toMatchObject({ canStart: true, disabled: expect.not.arrayContaining(['start:probe-loading']), starting: false, error: null, templateEditor: null })
  })
})

describe('SC-5: the worktree list and its search', () => {
  test('SC-5: the candidates are listed, "w2" leaves W2 and "zzz" shows the empty state', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    expect(overlay.last().candidates.map((candidate: any) => candidate.name)).toEqual(['W', 'W2', 'F'])
    await v.click(v.q('[aria-label="Worktree"]'))
    expect(v.all('[role="option"]').map((option) => option.textContent)).toEqual(['✓ W/work/W', 'W2/work/W2', 'F/work'])
    expect(v.q('input[placeholder="Search worktrees…"]')).not.toBeNull()

    expect((await fake.run('search', { query: 'w2' })).ok).toBe(true)
    expect(overlay.last().candidates).toEqual([wtW2])
    expect(v.all('[role="option"]')).toHaveLength(1)

    await fake.run('search', { query: 'zzz' })
    expect(overlay.last().candidates).toEqual([])
    expect(v.text()).toContain('No matching worktrees.')

    await fake.run('search', { query: '' })
    expect(overlay.last().candidates).toHaveLength(3)
  })

  test('SC-5: choosing a row selects that worktree and recomposes', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    await v.click(v.q('[aria-label="Worktree"]'))
    await v.click(v.all('[role="option"]')[1]!)
    expect(overlay.last().controls.target).toEqual({ worktree: 'wt_W2' })
    expect(v.q('[aria-label="Worktree"]')!.textContent).toBe('W2')
    expect(v.q('[role="listbox"]')).toBeNull()
    await afterDebounce()
    expect(fake.callsTo('preview')).toHaveLength(2)
    expect(fake.callsTo('preview')[1]!.params.controls.target).toEqual({ worktree: 'wt_W2' })
  })
})

describe('SC-6 and SC-8: creating a worktree', () => {
  test('SC-6: the toggle shows the name and base fields, and a blank name disables Start', async () => {
    const { overlay, fake } = await opened()
    const v = overlay.view
    expect(v.button('Create a new worktree')).not.toBeNull()
    await v.click(v.button('Create a new worktree'))
    expect(v.button('Use an existing worktree')).not.toBeNull()
    expect(v.q('input[aria-label="Worktree name"]')!.getAttribute('placeholder')).toBe('handoff-follow-up')
    expect(v.q('input[aria-label="Base branch (optional)"]')!.getAttribute('placeholder')).toBe('Current branch')
    expect(overlay.last().controls.target).toEqual({ create: { name: '' } })
    expect(overlay.last().canStart).toBe(false)
    expect(overlay.last().disabled).toContain('start:create-name')
    expect(v.button('Start New Session')!.disabled).toBe(true)

    await afterDebounce()
    expect(fake.callsTo('preview').at(-1)!.params.controls.target).toBeUndefined()

    await v.type(v.q('input[aria-label="Worktree name"]') as HTMLInputElement, 'handoff-follow-up')
    await afterDebounce()
    expect(overlay.last().controls.target).toEqual({ create: { name: 'handoff-follow-up' } })
    expect(overlay.last().canStart).toBe(true)
    expect(fake.callsTo('preview').at(-1)!.params.controls.target).toEqual({ create: { name: 'handoff-follow-up' } })
  })

  test('SC-8: a source that cannot create worktrees has no create control and lists its folder', async () => {
    const { overlay } = await opened((world) => {
      world.canCreateWorktree = false
      world.candidates = [folderF]
      world.source.worktreeId = 'ws_F'
      world.controls.target = { worktree: 'ws_F' }
    })
    expect(overlay.view.button('Create a new worktree')).toBeNull()
    expect(overlay.last().candidates).toEqual([folderF])
    expect(overlay.last().source.canCreateWorktree).toBe(false)
  })
})

describe('SC-10 and SC-11: the agent control', () => {
  test('SC-10: the agent select lists the enabled agents and changing it recomposes', async () => {
    const { overlay, fake } = await opened()
    const select = overlay.view.q('select[aria-label="Agent"]') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual(['Claude', 'Codex'])
    await overlay.view.choose(select, 'codex')
    expect(overlay.last().controls.agent).toBe('codex')
    await afterDebounce()
    expect(fake.callsTo('preview').at(-1)!.params.controls.agent).toBe('codex')
    expect((await fake.run('set', { field: 'agent', value: 'gemini' })).reason).toBe('unknown-agent')
  })

  test('SC-11: a failed detection and an empty list show their messages and disable Start', async () => {
    const failed = await opened((world) => {
      world.agents = { state: 'failed', list: [] }
      delete world.controls.agent
    })
    expect(failed.overlay.view.text()).toContain('Could not detect Agents on the target host.')
    expect(failed.overlay.last().agents).toMatchObject({ state: 'failed', message: 'Could not detect Agents on the target host.' })
    expect(failed.overlay.last().canStart).toBe(false)
    expect(failed.overlay.last().disabled).toContain('start:no-agent')
    await teardown(ui)

    const empty = await opened((world) => {
      world.agents = { state: 'ready', list: [] }
      delete world.controls.agent
    })
    expect(empty.overlay.view.text()).toContain('No enabled Agents were detected on the target host.')
    expect(empty.overlay.last().agents.message).toBe('No enabled Agents were detected on the target host.')
    expect(empty.overlay.last().canStart).toBe(false)
  })

  test('SC-11: while the agents are loading the message reads Detecting Agents and Start is disabled', async () => {
    const { agentsMessage, disabledOf } = await import('../../src/window/model')
    expect(agentsMessage({ state: 'loading', list: [] })).toBe('Detecting Agents on the target host…')
    const closed = new (await import('../../src/window/model')).HandoffDialog(fakeContext(daemon(makeWorld())).context).getSnapshot()
    expect(disabledOf({ ...closed, shown: true })).toContain('start:agents-loading')
  })
})

describe('SC-13 and SC-15: the content controls', () => {
  test('SC-13: Full is selectable on a usable transcript and changes the recomposed brief', async () => {
    const { overlay, fake } = await opened()
    const [, full] = overlay.view.all('input[type="radio"]') as HTMLInputElement[]
    expect(full!.disabled).toBe(false)
    await overlay.view.click(full!)
    expect(overlay.last().controls.context).toBe('full')
    await afterDebounce()
    expect(fake.callsTo('preview').at(-1)!.params.controls.context).toBe('full')
    expect(overlay.last().preview.text).toContain('Read the whole transcript.')
  })

  test('SC-13: Full is disabled with the reason for an unverifiable and for an unreachable transcript, and the mode stays Focused', async () => {
    const unverifiable = await opened((world) => {
      world.probe = { verdict: 'unverifiable', path: null, reason: 'path-outside-known-roots', candidate: 'reported' }
    })
    const [, full] = unverifiable.overlay.view.all('input[type="radio"]') as HTMLInputElement[]
    expect(full!.disabled).toBe(true)
    expect(unverifiable.overlay.view.text()).toContain('A full saved transcript could not be verified on this target. Focused context will be used.')
    expect(unverifiable.overlay.last().disabled).toContain('control:context-full')
    expect(await unverifiable.fake.run('set', { field: 'context', value: 'full' })).toEqual({ ok: false, reason: 'full-unavailable' })
    expect(unverifiable.overlay.last().controls.context).toBe('focused')
    await teardown(ui)

    const unreachable = await opened((world) => {
      world.probe = { verdict: 'unreachable', path: null, reason: null, candidate: null }
    })
    expect(unreachable.overlay.view.text()).toContain('A full saved transcript is not reachable on this target. Focused context will be used.')
  })

  test('SC-15: with repo state off the diff bodies are off and disabled', async () => {
    const { overlay, fake } = await opened()
    const [repo, diff] = overlay.view.all('input[type="checkbox"]') as HTMLInputElement[]
    await overlay.view.click(diff!)
    expect(overlay.last().controls.include.diffBodies).toBe(true)
    await overlay.view.click(repo!)
    expect(overlay.last().controls.include).toEqual({ repoState: false, diffBodies: false, openEditorTabs: true })
    expect(diff!.checked).toBe(false)
    expect(diff!.disabled).toBe(true)
    expect(overlay.last().disabled).toContain('control:diffBodies')
    expect(await fake.run('set', { field: 'diffBodies', value: true })).toEqual({ ok: false, reason: 'repo-state-off' })
  })
})

describe('SC-63: opening twice and unknown fields', () => {
  test('SC-63: set refuses an unknown field and a closed dialog', async () => {
    const world = makeWorld()
    const fake = fakeContext(daemon(world))
    await mountOverlay(ui, fake)
    expect(await fake.run('set', { field: 'note', value: 'x' })).toEqual({ ok: false, reason: 'not-open' })
    await fake.run('open', { session: 's_1' })
    expect(await fake.run('set', { field: 'bogus', value: 1 })).toEqual({ ok: false, reason: 'unknown-field' })
    expect(await fake.run('open', {})).toEqual({ ok: false, reason: 'session-required' })
  })

  test('SC-63: a second open replaces the first source', async () => {
    const { overlay, fake, world } = await opened()
    world.source = { ...world.source, session: 's_2', key: 'session:s_2', title: 'Other' }
    await fake.run('open', { session: 's_2' })
    await settle()
    expect(overlay.last().source.session).toBe('s_2')
    expect(overlay.view.q('[data-source]')!.textContent).toContain('Other')
  })
})
