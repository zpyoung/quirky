import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import { AgentSessionViewError } from '../../../native-chat/agent-session-wire/agent-session-view-error'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  StructuredAgentSessionVisuals,
  visualIdentity,
  type VisualJournal
} from '../../../native-chat/agent-session-wire/structured-agent-session-visuals'
import { eraseRpcMethods, type RpcContext } from '../core'
import { STRUCTURED_AGENT_SESSION_VIEW_METHODS } from './structured-agent-session-view'

const SESSION = 'session-alpha'
const SPEC = { title: 'Plan', root: { type: 'markdown', props: { text: 'hello' } } }

type Write = { itemId: string; body: AgentJournalItemBody; turnScope: AgentJournalTurnScope }

function fakeJournal(runningTurnItemId?: string) {
  const items = new Map<string, { body: AgentJournalItemBody; turnScope: AgentJournalTurnScope }>()
  const writes: Write[] = []
  const put = (itemId: string, body: AgentJournalItemBody, turnScope: AgentJournalTurnScope) => {
    items.set(itemId, { body, turnScope })
    writes.push({ itemId, body, turnScope })
  }
  const journal: VisualJournal = {
    itemBody: (itemId) => items.get(itemId)?.body ?? null,
    item: (itemId) => {
      const held = items.get(itemId)
      return held ? { turnScope: held.turnScope } : null
    },
    runningTurn: () => (runningTurnItemId ? { item: { itemId: runningTurnItemId } } : null),
    appendItem: async (identity, body, options) => {
      put(agentJournalItemKey(identity), body, options.turnScope)
    },
    appendResolvedItem: async (resolve, options) => {
      const resolved = resolve()
      if (resolved === null) {
        return null
      }
      put(agentJournalItemKey(resolved.identity), resolved.body, options.turnScope)
      return {}
    }
  }
  return { journal, writes }
}

function installHost(journal: VisualJournal) {
  const visuals = new StructuredAgentSessionVisuals({ fence: () => 1, newViewId: () => 'view-1' })
  const host = {
    sessionAgent: () => 'claude',
    openView: async (id: string, input: Parameters<typeof visuals.open>[2]) =>
      visuals.open(id, journal, input),
    updateView: async (id: string, input: Parameters<typeof visuals.update>[2]) =>
      visuals.update(id, journal, input),
    patchView: async (id: string, input: Parameters<typeof visuals.patch>[2]) =>
      visuals.patch(id, journal, input),
    closeView: async (id: string, input: Parameters<typeof visuals.close>[2]) =>
      visuals.close(id, journal, input),
    readView: async (_id: string, input: Parameters<typeof visuals.read>[1]) =>
      visuals.read(journal, input)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the view methods use only the five view calls and sessionAgent of the host.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
}

function contextFor(sessionId: string | undefined): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the view methods read only orchestrationCaller, clientKind and runtime.ensureStructuredAgentSessionHost.
  return {
    runtime: { ensureStructuredAgentSessionHost: vi.fn(async () => undefined) },
    ...(sessionId ? { orchestrationCaller: { sessionId } } : {})
  } as unknown as RpcContext
}

const envelope = {
  sessionId: SESSION,
  clientOperationId: '1800000000000-00000000000000000000000000000001',
  expectedRuntimeFence: 1,
  payloadFingerprint: 'f'.repeat(64)
}

async function run(
  name: string,
  params: Record<string, unknown>,
  ctx: RpcContext = contextFor(SESSION)
): Promise<unknown> {
  const method = eraseRpcMethods(STRUCTURED_AGENT_SESSION_VIEW_METHODS).find(
    (each) => each.name === name
  )
  if (!method?.params) {
    throw new Error(`no method ${name}`)
  }
  return method.handler(method.params.parse(params), ctx)
}

async function failure(promise: Promise<unknown>): Promise<AgentSessionViewError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof AgentSessionViewError)) {
    throw new Error('expected an AgentSessionViewError')
  }
  return error
}

describe('agentSession.view.*', () => {
  let fake: ReturnType<typeof fakeJournal>

  beforeEach(() => {
    fake = fakeJournal()
    installHost(fake.journal)
  })

  afterEach(() => setStructuredAgentSessionHost(null))

  const itemId = agentJournalItemKey(visualIdentity('view-1'))
  const bodyOf = () => fake.journal.itemBody(itemId)

  it('open writes a version 1 visual item under a stable identity', async () => {
    const result = await run('agentSession.view.open', { envelope, spec: SPEC, title: 'Plan' })

    expect(result).toEqual({ viewId: 'view-1', version: 1 })
    expect(bodyOf()).toMatchObject({
      kind: 'visual',
      viewId: 'view-1',
      version: 1,
      placement: 'inline',
      title: 'Plan'
    })
    const body = bodyOf()
    expect(body?.kind).toBe('visual')
    expect(JSON.parse(body?.kind === 'visual' ? body.spec.head : '')).toEqual(SPEC)
  })

  it('open places a visual opened mid-turn in that turn', async () => {
    fake = fakeJournal('turn-7')
    installHost(fake.journal)

    await run('agentSession.view.open', { envelope, spec: SPEC, placement: 'pane' })

    expect(fake.writes[0]?.turnScope).toEqual({ kind: 'turn', turnItemId: 'turn-7' })
    expect(bodyOf()).toMatchObject({ placement: 'pane' })
  })

  it('update and patch each write the next version of the same item', async () => {
    await run('agentSession.view.open', { envelope, spec: SPEC })

    const updated = await run('agentSession.view.update', {
      envelope,
      viewId: 'view-1',
      spec: { ...SPEC, title: 'Plan 2' }
    })
    const patched = await run('agentSession.view.patch', {
      envelope,
      viewId: 'view-1',
      patch: { ops: [{ op: 'replace', path: '/title', value: 'Plan 3' }] }
    })

    expect(updated).toEqual({ version: 2 })
    expect(patched).toEqual({ version: 3 })
    const read = await run('agentSession.view.get', { sessionId: SESSION, viewId: 'view-1' })
    expect(read).toMatchObject({ version: 3, closed: false, spec: { title: 'Plan 3' } })
    expect(new Set(fake.writes.map((write) => write.itemId))).toEqual(new Set([itemId]))
  })

  it('writes nothing for an invalid spec and says what is wrong', async () => {
    const error = await failure(
      run('agentSession.view.open', { envelope, spec: { title: 'x', root: { type: 'nope' } } })
    )

    expect(error.code).toBe('invalid-spec')
    expect(error.details?.errors).toEqual(expect.any(Array))
    expect(fake.writes).toEqual([])
  })

  it('writes nothing when a patch leaves an invalid spec', async () => {
    await run('agentSession.view.open', { envelope, spec: SPEC })

    const error = await failure(
      run('agentSession.view.patch', {
        envelope,
        viewId: 'view-1',
        patch: { ops: [{ op: 'replace', path: '/root/type', value: 'nope' }] }
      })
    )

    expect(error.code).toBe('invalid-spec')
    expect(fake.writes).toHaveLength(1)
  })

  it.each([
    ['agentSession.view.update', { envelope, viewId: 'missing', spec: SPEC }],
    [
      'agentSession.view.patch',
      {
        envelope,
        viewId: 'missing',
        patch: { ops: [{ op: 'replace', path: '/title', value: 'a' }] }
      }
    ],
    ['agentSession.view.close', { envelope, viewId: 'missing' }],
    ['agentSession.view.get', { sessionId: SESSION, viewId: 'missing' }]
  ])('%s reports an unknown view as not-found', async (name, params) => {
    expect((await failure(run(name, params))).code).toBe('not-found')
    expect(fake.writes).toEqual([])
  })

  it('refuses update and patch of a closed view but lets get and close through', async () => {
    await run('agentSession.view.open', { envelope, spec: SPEC })
    await run('agentSession.view.close', { envelope, viewId: 'view-1' })
    const writesAfterClose = fake.writes.length

    const update = await failure(
      run('agentSession.view.update', { envelope, viewId: 'view-1', spec: SPEC })
    )
    const patch = await failure(
      run('agentSession.view.patch', {
        envelope,
        viewId: 'view-1',
        patch: { ops: [{ op: 'replace', path: '/title', value: 'a' }] }
      })
    )
    const closeAgain = await run('agentSession.view.close', { envelope, viewId: 'view-1' })
    const read = await run('agentSession.view.get', { sessionId: SESSION, viewId: 'view-1' })

    expect([update.code, patch.code]).toEqual(['closed', 'closed'])
    expect(closeAgain).toEqual({ ok: true })
    expect(read).toMatchObject({ closed: true, version: 2, spec: SPEC })
    expect(fake.writes).toHaveLength(writesAfterClose)
  })

  it('refuses a call with no session claim or another session', async () => {
    const noClaim = await failure(
      run('agentSession.view.open', { envelope, spec: SPEC }, contextFor(undefined))
    )
    const other = await failure(
      run('agentSession.view.open', { envelope, spec: SPEC }, contextFor('session-beta'))
    )

    expect([noClaim.code, other.code]).toEqual(['session-refused', 'session-refused'])
    expect(fake.writes).toEqual([])
  })
})
