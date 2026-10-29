import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { HandoffRig } from './support'

let rig: HandoffRig
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

type Prepared = { controls: Record<string, any>; draft: { controls: Record<string, any>; preview: { text: string; stale: string[] } | null } | null }
const prepare = (source: Record<string, unknown>) => rig.call('quirky.handoff/prepare', { source }) as Promise<Prepared>
const saveDraft = (source: Record<string, unknown>, draft: unknown) => rig.call('quirky.handoff/draft', { source, draft })

/** A claude session `w` with terminal history, and its opened controls. */
async function opened() {
  rig = await HandoffRig.start()
  const s = await rig.session('w')
  rig.setHistory(['output'])
  const source = { session: s.id }
  return { s, source, base: (await prepare(source)).controls }
}

describe('SC-58: Cancel keeps a draft for the source', () => {
  test('the note, agent and toggles come back for that source only', async () => {
    const { s, source, base } = await opened()
    const other = await rig.session('w')
    const include = { repoState: true, diffBodies: true, openEditorTabs: true }
    expect(await saveDraft(source, { controls: { ...base, note: 'keep this', agent: 'codex', include }, preview: null })).toEqual({ ok: true })

    const reopened = await prepare(source)
    expect(reopened.controls).toMatchObject({ note: 'keep this', agent: 'codex', include })
    expect(reopened.draft?.controls.note).toBe('keep this')
    const elsewhere = await prepare({ session: other.id })
    expect(elsewhere.draft).toBeNull()
    expect(elsewhere.controls.note).toBe('')
    expect(s.id).not.toBe(other.id)
  })

  test('null clears the draft', async () => {
    const { source, base } = await opened()
    await saveDraft(source, { controls: { ...base, note: 'keep this' }, preview: null })
    await saveDraft(source, null)
    expect((await prepare(source)).draft).toBeNull()
  })

  test('an archived source keeps its own draft', async () => {
    rig = await HandoffRig.start()
    const archived = { agent: 'codex', providerSessionId: 'X', lastMessage: 'half done' }
    const base = (await prepare({ archived })).controls
    await saveDraft({ archived }, { controls: { ...base, note: 'for the vault' }, preview: null })
    expect((await prepare({ archived })).controls.note).toBe('for the vault')
    expect((await prepare({ archived: { ...archived, providerSessionId: 'Y' } })).draft).toBeNull()
  })

  test('a draft without controls is refused', async () => {
    const { source } = await opened()
    const error = await rig.failure('quirky.handoff/draft', { source, draft: { preview: null } })
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('a source that is both or neither is refused', async () => {
    rig = await HandoffRig.start()
    for (const source of [{}, { session: 's_1', archived: { agent: 'codex' } }]) {
      const error = await rig.failure('quirky.handoff/prepare', { source })
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
    }
  })
})

describe('SC-60: a detached draft keeps its edited text', () => {
  test('the preview text and stale reasons come back with the draft', async () => {
    const { source, base } = await opened()
    const preview = { text: 'My edited brief.\nSecond line.', stale: ['The edited preview is stale relative to newer controls, target data, or session context.'] }
    await saveDraft(source, { controls: base, preview })
    const reopened = await prepare(source)
    expect(reopened.draft?.preview).toEqual(preview)
  })
})

describe('SC-61: a restored target that is gone falls back', () => {
  test('the source worktree is used and the rest of the draft is restored', async () => {
    const { s, source, base } = await opened()
    const w2 = await rig.worktree('w2')
    await saveDraft(source, { controls: { ...base, target: { worktree: w2.id }, note: 'still here' }, preview: null })
    expect((await prepare(source)).controls.target).toEqual({ worktree: w2.id })

    await rig.call('quirky.worktree/remove', { worktree: w2.id, force: true, yes: true })
    const reopened = await prepare(source)
    expect(reopened.controls.target).toEqual({ worktree: s.worktreeId })
    expect(reopened.controls.note).toBe('still here')
  })

  test('a create target is kept only while the source can create worktrees', async () => {
    const { source, base } = await opened()
    await saveDraft(source, { controls: { ...base, target: { create: { name: 'next', base: 'main' } } }, preview: null })
    expect((await prepare(source)).controls.target).toEqual({ create: { name: 'next', base: 'main' } })
  })
})

describe('SC-62: remembered choices seed the next dialog', () => {
  const prefs = {
    lastAgent: 'codex',
    includeToggles: { repoState: true, diffBodies: true, openEditorTabs: true },
    lastTemplateId: 'debug-failure'
  }

  test('any session defaults to the remembered agent, toggles and template', async () => {
    const { source } = await opened()
    rig.seedKv('prefs', prefs)
    const other = await rig.session('w')
    for (const target of [source, { session: other.id }]) {
      const seeded = (await prepare(target)).controls
      expect(seeded).toMatchObject({ agent: 'codex', templateId: 'debug-failure', include: prefs.includeToggles })
    }
  })

  test('a remembered template that was deleted reads as none', async () => {
    const { source } = await opened()
    rig.seedKv('prefs', prefs)
    await rig.call('quirky.handoff/templateMutate', { op: 'remove', id: 'debug-failure' })
    expect((await prepare(source)).controls.templateId).toBeNull()
  })

  test('a draft wins over the remembered choices, including no template', async () => {
    const { source, base } = await opened()
    rig.seedKv('prefs', prefs)
    await saveDraft(source, { controls: { ...base, templateId: null, include: { repoState: false, diffBodies: false, openEditorTabs: false } }, preview: null })
    expect((await prepare(source)).controls).toMatchObject({
      templateId: null,
      include: { repoState: false, diffBodies: false, openEditorTabs: false }
    })
  })

  test('a damaged preferences row is ignored', async () => {
    const { source } = await opened()
    rig.seedKv('prefs', 'nonsense')
    expect((await prepare(source)).controls).toMatchObject({ agent: 'claude', templateId: null })
  })
})

