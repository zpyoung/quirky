import { useState, type FormEvent } from 'react'
import type { Repo, UiPluginContext } from '@quirky/protocol'
import { createWorktree } from './actions'
import { Dialog } from './Dialog'

type Props = { context: UiPluginContext; repo: Repo; onClose: () => void }

export function NewWorktreeDialog({ context, repo, onClose }: Props) {
  const [name, setName] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const ok = await createWorktree(context, repo.id, name.trim(), baseRef.trim())
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog title={`New worktree in ${repo.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="feature-x" />
        </label>
        <label>
          Base ref (optional)
          <input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  )
}
