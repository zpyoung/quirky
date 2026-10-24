import { useState } from 'react'
import type { Repo, Worktree } from '@quirky/protocol'
import { removeWorktree } from '../actions'
import { useAppState, useConnection, useDispatch } from '../context'
import { worktreeStatus } from '../lib/status'
import { AddRepoForm } from './AddRepoForm'
import { NewWorktreeDialog } from './NewWorktreeDialog'
import { StatusDot } from './StatusDot'

function WorktreeRow({ worktree }: { worktree: Worktree }) {
  const state = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const selected = state.selectedWorktreeId === worktree.id

  return (
    <li className={`worktree${selected ? ' selected' : ''}`}>
      <button
        className="worktree-main"
        onClick={() => dispatch({ type: 'selectWorktree', id: worktree.id })}
        title={worktree.path}
      >
        <StatusDot status={worktreeStatus(state.sessions, worktree.id)} />
        <span className="worktree-name">{worktree.name}</span>
      </button>
      {!worktree.isMain && (
        <button
          className="icon-button"
          aria-label={`Remove worktree ${worktree.name}`}
          title="Remove worktree"
          onClick={() => void removeWorktree(connection, worktree)}
        >
          ×
        </button>
      )}
    </li>
  )
}

function RepoSection({ repo, worktrees }: { repo: Repo; worktrees: Worktree[] }) {
  const [creating, setCreating] = useState(false)

  return (
    <section className="repo">
      <header className="repo-header">
        <span className="repo-name" title={repo.path}>
          {repo.name}
        </span>
        <button
          className="icon-button"
          aria-label={`New worktree in ${repo.name}`}
          title="New worktree"
          onClick={() => setCreating(true)}
        >
          +
        </button>
      </header>
      <ul className="worktree-list">
        {worktrees.map((worktree) => (
          <WorktreeRow key={worktree.id} worktree={worktree} />
        ))}
      </ul>
      {creating && <NewWorktreeDialog repo={repo} onClose={() => setCreating(false)} />}
    </section>
  )
}

export function Sidebar() {
  const state = useAppState()

  return (
    <aside className="sidebar">
      <div className="repo-scroll">
        {state.repos.length === 0 && <p className="muted pad">No repositories yet.</p>}
        {state.repos.map((repo) => (
          <RepoSection
            key={repo.id}
            repo={repo}
            worktrees={state.worktrees.filter((w) => w.repoId === repo.id)}
          />
        ))}
      </div>
      <AddRepoForm />
    </aside>
  )
}
