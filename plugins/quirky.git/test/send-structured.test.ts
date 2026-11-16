import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type PluginCaller, type PluginContext, type PluginErrorKind, type PluginStore, type Session, type StoreValue, type Worktree } from '@quirky/protocol'
import { createEnv, type DaemonEnv } from '../src/daemon/env'
import { formatNotes } from '../src/daemon/notes-format'
import { noteTargets, sendNotes } from '../src/daemon/targets'
import { migrations } from '../src/daemon/store'

const WORKTREE = { id: 'wt1', path: '/nowhere/wt1', kind: 'git', name: 'wt1' } as Worktree
const CALLER: PluginCaller = { role: 'cli' }
const ERROR_CODES: Record<PluginErrorKind, number> = { 'invalid-params': RpcErrorCode.InvalidParams, 'not-found': RpcErrorCode.NotFound, conflict: RpcErrorCode.Conflict }

const FORMATTED = formatNotes([
  { path: 'src/a.ts', startLine: 4, line: 4, body: 'Cap is 30 s' },
  { path: 'src/a.ts', startLine: 8, line: 8, body: 'Add a 100 ms floor' }
])

type Call = { method: string; params: Record<string, unknown> }

const session = (id: string, kind: Session['kind'], extra: Partial<Session> = {}): Session =>
  ({ id, kind, agent: kind === 'structured' ? 'claude' : 'codex', worktreeId: WORKTREE.id, title: id, status: 'running', lastActivityAt: 1, ...extra }) as Session

let sessions: Session[]
let calls: Call[]
let structuredSend: (params: Record<string, unknown>) => unknown
let db: Database
let env: DaemonEnv

/** A plugin store over an in-memory database with the plugin's own schema. */
function memoryStore(): PluginStore {
  db = new Database(':memory:')
  for (const migration of migrations) db.exec(migration as string)
  const store: PluginStore = {
    version: migrations.length,
    run: (sql, ...params: StoreValue[]) => {
      const { changes, lastInsertRowid } = db.query(sql).run(...(params as never[]))
      return { changes, lastInsertRowid: Number(lastInsertRowid) }
    },
    get: <T>(sql: string, ...params: StoreValue[]) => (db.query(sql).get(...(params as never[])) as T | null) ?? null,
    all: <T>(sql: string, ...params: StoreValue[]) => db.query(sql).all(...(params as never[])) as T[],
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work)()
  }
  return store
}

function fakeContext(): PluginContext {
  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    'quirky.worktree/resolve': () => WORKTREE,
    'quirky.agents/list': () => ({
      agents: [
        { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true },
        { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: false }
      ]
    }),
    'quirky.session/list': () => sessions,
    'quirky.session/get': (params) => {
      const found = sessions.find((candidate) => candidate.id === params.session)
      if (!found) throw Object.assign(new Error('no such session'), { code: RpcErrorCode.NotFound })
      return found
    },
    'quirky.terminal/send': () => ({ ok: true }),
    'quirky.structured/send': (params) => structuredSend(params)
  }
  return {
    pluginId: 'quirky.git',
    emit() {},
    error: (kind: PluginErrorKind, message: string) => Object.assign(new Error(message), { code: ERROR_CODES[kind] }),
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = methods[method]
      if (!handler) throw Object.assign(new Error(`no method ${method}`), { code: RpcErrorCode.MethodNotFound })
      return handler(params)
    }
  } as unknown as PluginContext
}

function addNote(id: string, line: number, body: string): void {
  env.notes.insert({ id, worktreeId: WORKTREE.id, path: 'src/a.ts', startLine: line, line, body, createdAt: line, updatedAt: null })
}

const sendAll = (target: Record<string, unknown>) => sendNotes(env)({ scope: 'all', ...target }, CALLER) as Promise<any>
const callsTo = (method: string) => calls.filter((call) => call.method === method)
const remaining = () => env.notes.list(WORKTREE.id).map((note) => note.id)

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string; data?: { reason?: string } }> {
  try {
    await promise
  } catch (error) {
    return error as { code: number; message: string; data?: { reason?: string } }
  }
  throw new Error('expected the call to fail')
}

beforeEach(() => {
  sessions = [session('chat', 'structured', { status: 'working' }), session('term', 'terminal')]
  calls = []
  structuredSend = () => ({ ok: true })
  env = createEnv(fakeContext(), memoryStore())
  addNote('n1', 4, 'Cap is 30 s')
  addNote('n2', 8, 'Add a 100 ms floor')
})
afterEach(() => db.close())

describe('sending notes to a structured session', () => {
  test('goes through quirky.structured/send when idle, with the formatted notes, and the notes are deleted', async () => {
    const result = await sendAll({ session: 'chat' })

    expect(callsTo('quirky.structured/send')).toEqual([{ method: 'quirky.structured/send', params: { session: 'chat', text: FORMATTED, when: 'idle' } }])
    expect(result).toEqual({ sent: ['n1', 'n2'], kept: [], target: { session: 'chat' }, delivery: 'sent' })
    expect(remaining()).toEqual([])
    expect(callsTo('quirky.terminal/send')).toEqual([])
  })

  test('a note edited while the send runs stays', async () => {
    structuredSend = () => {
      env.notes.setBody('n2', 'Add a 200 ms floor', 99)
      return { ok: true }
    }
    expect(await sendAll({ session: 'chat' })).toMatchObject({ sent: ['n1'], kept: ['n2'] })
    expect(remaining()).toEqual(['n2'])
  })

  test('a send that is not ok keeps every note and says why', async () => {
    structuredSend = () => ({ ok: false, reason: 'recipient_gone' })
    const error = await failure(sendAll({ session: 'chat' }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data?.reason).toBe('recipient_gone')
    expect(remaining()).toEqual(['n1', 'n2'])
  })

  test('an error from the send keeps every note', async () => {
    structuredSend = () => {
      throw Object.assign(new Error('gone'), { code: RpcErrorCode.NotFound })
    }
    expect((await failure(sendAll({ session: 'chat' }))).code).toBe(RpcErrorCode.NotFound)
    expect(remaining()).toEqual(['n1', 'n2'])
  })

  test('an exited session and one of another worktree are refused without sending', async () => {
    sessions.push(session('gone', 'structured', { status: 'exited' }), session('elsewhere', 'structured', { worktreeId: 'other' }))
    expect(await failure(sendAll({ session: 'gone' }))).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'exited' } })
    expect(await failure(sendAll({ session: 'elsewhere' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'not-a-target' } })
    expect(callsTo('quirky.structured/send')).toEqual([])
    expect(remaining()).toEqual(['n1', 'n2'])
  })

  test('an unknown session is not-found', async () => {
    expect((await failure(sendAll({ session: 'missing' }))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('sending notes to a terminal session', () => {
  test('still types them into the terminal and never touches quirky.structured', async () => {
    const result = await sendAll({ session: 'term' })

    expect(callsTo('quirky.terminal/send')).toEqual([
      {
        method: 'quirky.terminal/send',
        params: {
          session: 'term',
          text: FORMATTED,
          enter: true
        }
      }
    ])
    expect(callsTo('quirky.structured/send')).toEqual([])
    expect(result).toEqual({ sent: ['n1', 'n2'], kept: [], target: { session: 'term' }, delivery: 'pasted' })
    expect(remaining()).toEqual([])
  })

  test('a waiting terminal session is still refused', async () => {
    sessions[1] = session('term', 'terminal', { status: 'waiting' })
    expect(await failure(sendAll({ session: 'term' }))).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'waiting' } })
    expect(callsTo('quirky.terminal/send')).toEqual([])
  })
})

describe('noteTargets', () => {
  test('lists live structured sessions beside the terminal ones', async () => {
    sessions.push(
      session('done-chat', 'structured', { status: 'done' }),
      session('gone', 'structured', { status: 'exited' }),
      session('elsewhere', 'structured', { worktreeId: 'other' }),
      session('sh', 'terminal', { agent: 'shell' })
    )

    const targets = (await noteTargets(env)({}, CALLER)) as { sessions: Array<Record<string, unknown>> }

    expect(targets.sessions.map((target) => [target.session, target.label, target.status, target.sendable])).toEqual([
      ['chat', 'Claude', 'working', true],
      ['term', 'Codex', 'running', true],
      ['done-chat', 'Claude', 'done', true],
      ['elsewhere', 'Claude', 'running', false]
    ])
    expect(targets.sessions[3]).toMatchObject({ reason: 'Notes go to an agent session in this worktree.' })
  })
})
