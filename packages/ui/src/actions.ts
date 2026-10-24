import { RpcError, RpcErrorCode, type AgentKind, type Session, type Worktree } from '@quirky/protocol'
import type { Connection } from './connection'
import { confirmAction } from './components/ConfirmHost'

export async function addRepo(connection: Connection, path: string): Promise<boolean> {
  const repo = await connection.attempt('repo.add', { path }, 'Could not add repo')
  if (!repo) return false
  await connection.refreshRepos().catch(() => {})
  return true
}

export async function createWorktree(
  connection: Connection,
  repoId: string,
  name: string,
  baseRef: string
): Promise<boolean> {
  const worktree = await connection.attempt(
    'worktree.create',
    { repoId, name, baseRef: baseRef || undefined },
    'Could not create worktree'
  )
  if (!worktree) return false
  await connection.refreshWorktrees().catch(() => {})
  connection.store.dispatch({ type: 'selectWorktree', id: worktree.id })
  return true
}

export async function removeWorktree(connection: Connection, worktree: Worktree): Promise<void> {
  const ok = await confirmAction({
    title: 'Remove worktree',
    message: `Remove worktree "${worktree.name}" and close its sessions? The directory ${worktree.path} will be deleted.`,
    confirmLabel: 'Remove',
    danger: true
  })
  if (!ok) return
  try {
    await connection.call('worktree.remove', { worktreeId: worktree.id })
  } catch (error) {
    if (!(error instanceof RpcError && error.code === RpcErrorCode.Conflict)) {
      connection.toastError('Could not remove worktree', error)
      return
    }
    const force = await confirmAction({
      title: 'Force remove',
      message: `${error.message}\n\nRemove it anyway?`,
      confirmLabel: 'Force remove',
      danger: true
    })
    if (!force) return
    await connection.attempt('worktree.remove', { worktreeId: worktree.id, force: true }, 'Could not remove worktree')
  }
  await connection.refreshWorktrees().catch(() => {})
}

export async function createSession(
  connection: Connection,
  worktreeId: string,
  agent: AgentKind,
  prompt: string,
  background: boolean
): Promise<void> {
  const text = prompt.trim()
  const session: Session | undefined = background
    ? await connection.attempt(
        'session.createStructured',
        { worktreeId, agent, prompt: text },
        'Could not start session'
      )
    : await connection.attempt(
        'session.create',
        { worktreeId, agent, prompt: text || undefined },
        'Could not start session'
      )
  if (!session) return
  connection.store.dispatch({ type: 'session', session })
  connection.store.dispatch({ type: 'selectSession', id: session.id })
}

export async function closeSession(connection: Connection, session: Session): Promise<void> {
  if (session.status !== 'exited') {
    const ok = await confirmAction({
      title: 'Close session',
      message: `"${session.title}" is still running. Close it?`,
      confirmLabel: 'Close',
      danger: true
    })
    if (!ok) return
  }
  const result = await connection.attempt('session.close', { sessionId: session.id }, 'Could not close session')
  if (result) connection.store.dispatch({ type: 'event', event: { type: 'session.removed', sessionId: session.id } })
}
