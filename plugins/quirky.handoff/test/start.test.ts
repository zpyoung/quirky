import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type Session, type Worktree } from '@quirky/protocol'
import type { Preview } from '../src/daemon/types'
import { HandoffRig, PASTE_END, PASTE_START } from './support'

let rig: HandoffRig
let stopReady: (() => void) | undefined
afterEach(async () => {
  stopReady?.()
  stopReady = undefined
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

const NOTICE_HEADING = '## Locked Quirky handoff notice'

type Started = {
  child: { session: string; tab: string; worktreeId: string }
  lineageId: string | null
  worktreeCreated: string | null
  delivery: string
}

const preview = (params: Record<string, unknown>) => rig.call('quirky.handoff/preview', params) as Promise<Preview>
const prepare = (session: string) => rig.call('quirky.handoff/prepare', { source: { session } }) as Promise<Record<string, any>>
const start = (params: Record<string, unknown>) => rig.call('quirky.handoff/start', params) as Promise<Started>
const sessionOf = (id: string) => rig.call('quirky.session/get', { session: id }) as Promise<Session>
const sessions = async () => ((await rig.call('quirky.session/list', {})) as Session[]).map((session) => session.id)
const lineage = (session?: string) =>
  rig.call('quirky.handoff/lineage', session === undefined ? {} : { session }) as Promise<{ records: Record<string, any>[] }>

const pasted = (id: string) => rig.h.pty.inputs.filter((input) => input.sessionId === id).map((input) => input.text)

/** A claude session `name` with terminal history, ready to hand off, and an agent that is ready as soon as it starts. */
async function opened(name = 'w') {
  rig = await HandoffRig.start()
  const s = await rig.session(name)
  rig.setHistory(['some output'])
  stopReady = rig.autoReady()
  return s
}

describe('SC-43: a handoff in the same worktree opens beside the source and delivers', () => {
  test('a new tab opens in the source group without taking focus, and the brief is pasted then submitted', async () => {
    const s = await opened()
    const before = await rig.layout(s.worktreeId)
    const group = before.root
    expect(group.kind).toBe('group')
    const activeBefore = group.activeTab

    const controls = { agent: 'gemini', note: 'Take over the tests' }
    const expected = await preview({ source: { session: s.id }, controls })
    const result = await start({ source: { session: s.id }, controls, wait: true })

    expect(result.delivery).toBe('delivered')
    expect(result.lineageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.worktreeCreated).toBeNull()
    expect(result.child.worktreeId).toBe(s.worktreeId)
    expect(result.child.session).not.toBe(s.id)

    const after = await rig.layout(s.worktreeId)
    expect(after.activeGroup).toBe(before.activeGroup)
    expect(after.root.tabs.map((tab: { id: string }) => tab.id)).toContain(result.child.tab)
    expect(after.root.tabs).toHaveLength(2)
    expect(after.root.activeTab).toBe(activeBefore)

    const child = await sessionOf(result.child.session)
    expect(child.agent).toBe('gemini')
    expect(pasted(result.child.session)).toEqual([`${PASTE_START}${expected.brief.replace(/\n/g, '\r')}\r\r${expected.notice.replace(/\n/g, '\r')}${PASTE_END}`, '\r'])
    expect(pasted(s.id)).toEqual([])
  })

  test('lineage, badges, remembered agent and the cleared draft follow the start', async () => {
    const s = await opened()
    const base = (await prepare(s.id)).controls
    await rig.call('quirky.handoff/draft', { source: { session: s.id }, draft: { controls: { ...base, note: 'draft' }, preview: null } })

    const result = await start({ source: { session: s.id }, controls: { ...base, agent: 'gemini', note: 'x', relationship: 'reviews' }, wait: true })

    const { records } = await lineage(s.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: result.lineageId,
      relationship: 'reviews',
      parent: { session: s.id, agent: 'claude', worktreeId: s.worktreeId },
      child: { session: result.child.session, agent: 'gemini', tab: result.child.tab, worktreeId: s.worktreeId }
    })
    expect(await lineage(result.child.session)).toEqual({ records })

    const reopened = await prepare(s.id)
    expect(reopened.draft).toBeNull()
    expect(reopened.controls.agent).toBe('gemini')
  })
})

describe('SC-44: a handoff to another worktree opens there and keeps the source details', () => {
  test('the child starts in the target path and its tab joins the target active group', async () => {
    const s = await opened('w')
    const w2 = await rig.worktree('w2')
    const sourceLayout = await rig.layout(s.worktreeId)
    const targetBefore = await rig.layout(w2.id)

    const result = await start({ source: { session: s.id }, controls: { target: { worktree: w2.id }, agent: 'gemini' }, wait: true })

    expect(result.child.worktreeId).toBe(w2.id)
    expect((await sessionOf(result.child.session)).cwd).toBe(w2.path)
    const targetAfter = await rig.layout(w2.id)
    expect(targetAfter.activeGroup).toBe(targetBefore.activeGroup)
    expect(targetAfter.root.tabs.map((tab: { id: string }) => tab.id)).toContain(result.child.tab)
    expect((await rig.layout(s.worktreeId)).root.tabs).toHaveLength(sourceLayout.root.tabs.length)

    const text = pasted(result.child.session)[0]!
    expect(text).toContain(`Original working directory: ${s.cwd}`)
    expect(text).toContain('Branch: w')
  })
})

describe('SC-6: a new worktree is created at Start and the child runs in it', () => {
  test('nothing exists before Start; afterwards the worktree is the target', async () => {
    const s = await opened()
    const names = async () => ((await rig.call('quirky.worktree/list', {})) as Worktree[]).map((worktree) => worktree.name)
    const before = await names()
    expect(before).not.toContain('handoff-follow-up')

    const result = await start({
      source: { session: s.id },
      controls: { target: { create: { name: 'handoff-follow-up' } }, agent: 'gemini' },
      wait: true
    })

    expect(await names()).toContain('handoff-follow-up')
    expect(result.worktreeCreated).toBe(result.child.worktreeId)
    const created = (await rig.call('quirky.worktree/list', {})) as Worktree[]
    const worktree = created.find((item) => item.id === result.worktreeCreated)!
    expect(worktree.name).toBe('handoff-follow-up')
    expect((await sessionOf(result.child.session)).cwd).toBe(worktree.path)
  })
})

describe('SC-7: a blank base branch cuts from the source branch', () => {
  async function baseOf(worktreeId: string): Promise<string | null> {
    return ((await rig.call('quirky.worktree/show', { worktree: `id:${worktreeId}` })) as Worktree).baseRef
  }

  test('next is cut from the source branch, not the default branch', async () => {
    const s = await opened('feature')
    const result = await start({ source: { session: s.id }, controls: { target: { create: { name: 'next' } }, agent: 'gemini' } })
    expect(await baseOf(result.child.worktreeId)).toBe('feature')
  })

  test('an explicit base wins', async () => {
    const s = await opened('feature')
    const result = await start({ source: { session: s.id }, controls: { target: { create: { name: 'next', base: 'release' } }, agent: 'gemini' } })
    expect(await baseOf(result.child.worktreeId)).toBe('release')
  })

  test('a detached source cuts from its commit', async () => {
    const s = await opened('feature')
    const entry = rig.git.worktreesByRepo.get(rig.repo.path)!.find((item) => item.path.endsWith('/feature'))!
    entry.branch = null
    const result = await start({ source: { session: s.id }, controls: { target: { create: { name: 'next' } }, agent: 'gemini' } })
    expect(await baseOf(result.child.worktreeId)).toBe(entry.head)
  })
})

describe('SC-9: a worktree creation failure keeps everything', () => {
  test('a worktree that cannot be created fails with the creation error and launches nothing', async () => {
    const s = await opened()
    await rig.worktree('taken')
    rig.git.addNewBranchWorktree = async () => {
      throw new Error('fatal: cannot create the worktree')
    }
    const base = (await prepare(s.id)).controls
    await rig.call('quirky.handoff/draft', { source: { session: s.id }, draft: { controls: { ...base, note: 'keep me' }, preview: null } })
    const sessionsBefore = await sessions()

    const error = await rig.failure('quirky.handoff/start', {
      source: { session: s.id },
      controls: { ...base, target: { create: { name: 'taken' } }, note: 'keep me', agent: 'gemini' }
    })

    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toMatchObject({ reason: 'worktree-create-failed' })
    expect((error.data as { message: string }).message).toBe(error.message)
    expect(error.message.length).toBeGreaterThan(0)
    expect(await sessions()).toEqual(sessionsBefore)
    expect((await lineage()).records).toEqual([])
    const reopened = await prepare(s.id)
    expect(reopened.draft.controls.note).toBe('keep me')
  })

  test('a later failure keeps the new worktree and names it on the error', async () => {
    const s = await opened()
    await rig.call('quirky.agents/setEnabled', { agent: 'gemini', enabled: false })

    const error = await rig.failure('quirky.handoff/start', {
      source: { session: s.id },
      controls: { target: { create: { name: 'kept' } }, agent: 'gemini' }
    })

    expect(error.data).toMatchObject({ reason: 'agent-unavailable' })
    const made = ((await rig.call('quirky.worktree/list', {})) as Worktree[]).find((worktree) => worktree.name === 'kept')!
    expect(made).toBeDefined()
    expect((error.data as { worktreeCreated: unknown }).worktreeCreated).toEqual({ id: made.id, name: 'kept', path: made.path })

    await rig.call('quirky.agents/setEnabled', { agent: 'gemini', enabled: true })
    const retry = await start({ source: { session: s.id }, controls: { target: { worktree: made.id }, agent: 'gemini' } })
    expect(retry.child.worktreeId).toBe(made.id)
    expect(((await rig.call('quirky.worktree/list', {})) as Worktree[]).filter((worktree) => worktree.name === 'kept')).toHaveLength(1)
  })

  test('a launch failure after creating the worktree names it too', async () => {
    const s = await opened()
    rig.h.pty.failRequests('create', 'no pty')
    const error = await rig.failure('quirky.handoff/start', {
      source: { session: s.id },
      controls: { target: { create: { name: 'kept2' } }, agent: 'gemini' }
    })
    expect(error.data).toMatchObject({ reason: 'launch-failed', worktreeCreated: { name: 'kept2' } })
  })
})

describe('SC-17: a repo-state failure does not block', () => {
  test('the brief has no repository block and Start succeeds', async () => {
    const s = await opened()
    rig.git.statusV2 = async () => {
      throw new Error('git is down')
    }
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini' }, wait: true })
    expect(result.delivery).toBe('delivered')
    expect(pasted(result.child.session)[0]).not.toContain('## Repository state')
  })
})

describe('SC-39: likely secrets never block Start', () => {
  test('a note holding secrets starts and travels as written', async () => {
    const s = await opened()
    const note = 'AKIAABCDEFGHIJKLMNOP and api_key=abcdefghijklmnop1234'
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini', note }, wait: true })
    expect(result.delivery).toBe('delivered')
    expect(pasted(result.child.session)[0]).toContain('AKIAABCDEFGHIJKLMNOP')
  })
})

describe('SC-62: a successful start clears the draft and remembers choices', () => {
  test('the next dialog defaults to the agent, toggles and template that were used', async () => {
    const s = await opened()
    const other = await rig.session('w')
    const include = { repoState: true, diffBodies: true, openEditorTabs: false }
    const base = (await prepare(s.id)).controls
    await rig.call('quirky.handoff/draft', { source: { session: s.id }, draft: { controls: { ...base, note: 'draft' }, preview: null } })
    const debug = ((await rig.call('quirky.handoff/templates', {})) as { templates: { id: string; name: string }[] }).templates.find(
      (template) => template.name === 'Debug the failure'
    )!

    await start({ source: { session: s.id }, controls: { ...base, agent: 'codex', include, templateId: debug.id }, wait: false })

    expect((await prepare(s.id)).draft).toBeNull()
    const next = (await prepare(other.id)).controls
    expect(next).toMatchObject({ agent: 'codex', include, templateId: debug.id })

    await rig.call('quirky.handoff/templateMutate', { op: 'remove', id: debug.id })
    expect((await prepare(other.id)).controls.templateId).toBeNull()
  })

  test('a failed start leaves the remembered choices alone', async () => {
    const s = await opened()
    await rig.call('quirky.agents/setEnabled', { agent: 'codex', enabled: false })
    await rig.failure('quirky.handoff/start', { source: { session: s.id }, controls: { agent: 'codex' } })
    expect((await prepare(s.id)).controls.agent).toBe('claude')
  })
})

describe('SC-37: a detached preview is sent as edited', () => {
  test('the child receives the edited text followed by the notice, unchanged', async () => {
    const s = await opened()
    const edited = 'My own brief\n\nwith two paragraphs'
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini', note: 'ignored' }, body: edited, wait: true })

    const composed = await preview({ source: { session: s.id }, controls: {} })
    expect(pasted(result.child.session)[0]).toBe(
      `${PASTE_START}${`${edited}\n\n${composed.notice}`.replace(/\n/g, '\r')}${PASTE_END}`
    )
  })
})

describe('SC-38: the locked notice is never editable and always last', () => {
  test('the delivered text ends with the notice while the preview never holds it', async () => {
    const s = await opened()
    const composed = await preview({ source: { session: s.id }, controls: { note: 'n' } })
    expect(composed.brief).not.toContain(NOTICE_HEADING)
    expect(composed.characters).toBe(composed.brief.length)

    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini', note: 'n' }, wait: true })
    const text = pasted(result.child.session)[0]!.slice(PASTE_START.length, -PASTE_END.length)
    expect(text.endsWith(composed.notice.replace(/\n/g, '\r'))).toBe(true)
    expect(text.indexOf(NOTICE_HEADING)).toBe(text.lastIndexOf(NOTICE_HEADING))
  })
})

describe('SC-45: an attached preview that went out of date is refused', () => {
  test('nothing launches and the fresh preview comes back', async () => {
    const s = await opened()
    const controls = { agent: 'gemini' }
    const shown = (await preview({ source: { session: s.id }, controls })).brief
    rig.setHistory(['some output', 'new output after the preview'])
    const sessionsBefore = await sessions()

    const error = await rig.failure('quirky.handoff/start', { source: { session: s.id }, controls, shown })

    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('The source session changed. The preview was refreshed — review it, then start again.')
    const data = error.data as { reason: string; preview: Preview }
    expect(data.reason).toBe('source-changed')
    expect(data.preview.brief).toContain('new output after the preview')
    expect(data.preview.brief).not.toBe(shown)
    expect(await sessions()).toEqual(sessionsBefore)
    expect((await lineage()).records).toEqual([])
  })

  test('a shown text that equals a fresh composition is accepted', async () => {
    const s = await opened()
    const controls = { agent: 'gemini', note: 'same' }
    const shown = (await preview({ source: { session: s.id }, controls })).brief
    const result = await start({ source: { session: s.id }, controls, shown, wait: true })
    expect(result.delivery).toBe('delivered')
    expect(pasted(result.child.session)[0]).toContain(shown.split('\n')[0]!)
  })

  test('a detached body is not compared with a composition', async () => {
    const s = await opened()
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini' }, body: 'edited', shown: 'something else', wait: true })
    expect(result.delivery).toBe('delivered')
  })
})

describe('SC-46: an agent that disappeared is refused', () => {
  test('nothing launches and the message names the agent', async () => {
    const s = await opened()
    await rig.call('quirky.agents/setEnabled', { agent: 'codex', enabled: false })
    const sessionsBefore = await sessions()
    const error = await rig.failure('quirky.handoff/start', { source: { session: s.id }, controls: { agent: 'codex' } })
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('The selected Agent is no longer available on the target host.')
    expect(error.data).toMatchObject({ reason: 'agent-unavailable' })
    expect(await sessions()).toEqual(sessionsBefore)
  })
})

describe('SC-47: a launch failure keeps the handoff', () => {
  test('the error says the handoff is unchanged and nothing was recorded', async () => {
    const s = await opened()
    rig.h.pty.failRequests('create', 'no pty')
    const error = await rig.failure('quirky.handoff/start', { source: { session: s.id }, controls: { agent: 'gemini', note: 'keep' } })
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('Could not start the new Agent session. Your handoff is unchanged.')
    expect(error.data).toMatchObject({ reason: 'launch-failed' })
    expect((await lineage()).records).toEqual([])
    expect((await prepare(s.id)).controls.agent).toBe('claude')
  })
})

describe('SC-57: a lineage failure does not fail the start', () => {
  test('the child launches and the lineage is empty', async () => {
    const s = await opened()
    rig.refuseLineageWrites()
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini' }, wait: true })
    expect(result.lineageId).toBeNull()
    expect(result.delivery).toBe('delivered')
    expect(await sessions()).toContain(result.child.session)
    expect((await lineage(result.child.session)).records).toEqual([])
    expect((await sessionOf(result.child.session)).badges ?? {}).toEqual({})
  })
})

describe('SC-32: an archived source travels on notes alone', () => {
  test('Start is allowed, the parent has no session and only the child is badged', async () => {
    rig = await HandoffRig.start()
    stopReady = rig.autoReady()
    const main = rig.worktrees.main!
    const archived = { agent: 'codex', providerSessionId: 'X', lastMessage: 'Half the migration is done', worktree: main.id }

    const result = await start({ source: { archived }, controls: { agent: 'gemini' }, wait: true })

    expect(pasted(result.child.session)[0]).toContain('Half the migration is done')
    const [record] = (await lineage(result.child.session)).records
    expect(record).toMatchObject({ parent: { session: null, agent: 'codex', providerSessionId: 'X' }, child: { session: result.child.session } })
    expect(Object.keys((await sessionOf(result.child.session)).badges ?? {})).toEqual([`quirky.handoff/lineage:${record!.id}`])
  })

  test('an archived source with nothing to carry is refused', async () => {
    rig = await HandoffRig.start()
    const error = await rig.failure('quirky.handoff/start', { source: { archived: { agent: 'codex' } }, controls: {} })
    expect(error.data).toEqual({ reason: 'no-context' })
  })
})

describe('start: result shape and logging', () => {
  test('without wait the delivery is pending and the outcome arrives as an event', async () => {
    const s = await opened()
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini' } })
    expect(result.delivery).toBe('pending')
    const event = await rig.waitFor(() => rig.pluginEvents('delivery').find((data) => data.child === result.child.session), 4000)
    expect(event).toEqual({ child: result.child.session, lineageId: result.lineageId, outcome: 'delivered' })
  })

  test('one log line per start names the child and outcome and never the brief', async () => {
    const s = await opened()
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini', note: 'a private note' }, wait: true })
    const lines = rig.logs.filter((line) => line.includes(result.child.session))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('delivered')
    expect(rig.logs.join('\n')).not.toContain('a private note')
  })

  test('the source keeps its tab and gets no input', async () => {
    const s = await opened()
    const result = await start({ source: { session: s.id }, controls: { agent: 'gemini' }, wait: true })
    expect(result.child.session).not.toBe(s.id)
    expect(pasted(s.id)).toEqual([])
    expect((await sessionOf(s.id)).status).not.toBe('exited')
  })

  test('an unknown target worktree is an invalid target and nothing is created', async () => {
    const s = await opened()
    const error = await rig.failure('quirky.handoff/start', { source: { session: s.id }, controls: { target: { create: { name: '  ' } } } })
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.data).toEqual({ reason: 'invalid-target' })
  })

  test('a source with no context is refused before anything starts', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory([])
    const error = await rig.failure('quirky.handoff/start', { source: { session: s.id }, controls: {} })
    expect(error.data).toEqual({ reason: 'no-context' })
  })
})
