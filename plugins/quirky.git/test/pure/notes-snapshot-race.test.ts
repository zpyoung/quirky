import { describe, expect, test } from 'bun:test'
import type { PluginCaller, Session, Worktree } from '@quirky/protocol'
import { deleteNote, NoteHolds, type Note } from '../../src/daemon/notes'
import type { DaemonEnv } from '../../src/daemon/env'
import { sendNotes } from '../../src/daemon/targets'

const worktree = { id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt-1' } as Worktree
const caller = {} as unknown as PluginCaller
const note: Note = {
  id: 'note-1',
  worktreeId: worktree.id,
  path: 'math.ts',
  startLine: 1,
  line: 1,
  body: 'Review this line',
  createdAt: 1,
  updatedAt: null
}

describe('Git note snapshots during shelf loading', () => {
  test('keeps a held snapshot sent once when a concurrent shelf load finishes later', async () => {
    const shelves = [0, 1].map(() => ({
      result: Promise.withResolvers<unknown>(),
      started: Promise.withResolvers<void>()
    }))
    let shelfIndex = 0
    let current: Note | null = note
    const delivered: string[] = []
    const env = {
      context: {
        async call(method: string, params: Record<string, unknown>) {
          if (method === 'quirky.editor/workspaceNotes' && params.action === 'list') {
            const shelf = shelves[shelfIndex++]
            if (!shelf) throw new Error('unexpected extra shelf list')
            shelf.started.resolve()
            return shelf.result.promise
          }
          if (method === 'quirky.agents/list') {
            return { agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true }] }
          }
          if (method === 'quirky.session/get') {
            return { id: 'session-1', kind: 'terminal', agent: 'claude', worktreeId: worktree.id, status: 'working' } as unknown as Session
          }
          if (method === 'quirky.terminal/send') {
            delivered.push(params.text as string)
            return {}
          }
          throw new Error(`unexpected call ${method}`)
        },
        emit() {}
      },
      resolve: async () => worktree,
      notes: {
        list: () => current === null ? [] : [current],
        get: (_worktreeId: string, id: string) => current?.id === id ? current : null,
        remove: (id: string) => { if (current?.id === id) current = null },
        settle: (_worktreeId: string, picked: readonly Note[]) => {
          const sent: string[] = []
          const kept: string[] = []
          for (const pickedNote of picked) {
            if (current === null) sent.push(pickedNote.id)
            else if (current.id === pickedNote.id && current.body === pickedNote.body) {
              current = null
              sent.push(pickedNote.id)
            } else kept.push(pickedNote.id)
          }
          return { sent, kept }
        }
      },
      holds: new NoteHolds(),
      errors: { reasoned: (_kind: string, _reason: string, message: string) => new Error(message) }
    } as unknown as DaemonEnv

    const first = sendNotes(env)({ scope: 'all', session: 'session-1' }, caller)
    await shelves[0]!.started.promise
    expect(env.holds.has(worktree.id, note.id)).toBe(true)

    const second = sendNotes(env)({ scope: 'all', session: 'session-1' }, caller)
    await shelves[1]!.started.promise
    expect(env.holds.has(worktree.id, note.id)).toBe(true)

    expect(await deleteNote(env)({ id: note.id }, caller)).toEqual({ ok: true })
    shelves[0]!.result.resolve({ notes: [] })
    await expect(first).resolves.toMatchObject({
      sent: [note.id],
      kept: [],
      target: { session: 'session-1' },
      delivery: 'pasted'
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('User comment: "Review this line"')
    expect(env.holds.has(worktree.id, note.id)).toBe(false)

    shelves[1]!.result.resolve({ notes: [] })
    await expect(second).rejects.toThrow('All notes are already being sent.')
    expect(delivered).toHaveLength(1)
  })
})
