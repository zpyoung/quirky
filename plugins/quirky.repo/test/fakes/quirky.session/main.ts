export type FakeSession = { id: string; worktreeId: string; agent: string }

export type FakeSessionState = {
  sessions: FakeSession[]
  closed: string[]
  /** When set, `close` rejects with this message. */
  closeError: string | null
}

declare global {
  var __FAKE_SESSIONS__: FakeSessionState | undefined
}

/** Test handle on the fake's records; the daemon runs in the test process so the global is shared. */
export function fakeSessionState(): FakeSessionState {
  globalThis.__FAKE_SESSIONS__ ??= { sessions: [], closed: [], closeError: null }
  return globalThis.__FAKE_SESSIONS__
}

export function activate(context: any): void {
  const id = (name: string) => `method:quirky.session/${name}`
  context.provide(id('list'), (params: { worktree?: string }) =>
    fakeSessionState().sessions.filter((s) => params.worktree === undefined || s.worktreeId === params.worktree)
  )
  context.provide(id('create'), (params: { worktree: string; agent: string }) => {
    const state = fakeSessionState()
    const session = { id: `s_${state.sessions.length + state.closed.length + 1}`, worktreeId: params.worktree, agent: params.agent }
    state.sessions.push(session)
    return session
  })
  context.provide(id('close'), (params: { session: string }) => {
    const state = fakeSessionState()
    if (state.closeError) throw new Error(state.closeError)
    state.sessions = state.sessions.filter((s) => s.id !== params.session)
    state.closed.push(params.session)
    return { ok: true }
  })
}
