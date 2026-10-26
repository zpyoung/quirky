import { useState, type FormEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { addRepo } from './actions'

export function AddRepoForm({ context }: { context: UiPluginContext }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!path.trim()) return
    setBusy(true)
    if (await addRepo(context, path.trim())) setPath('')
    setBusy(false)
  }

  return (
    <form className="add-repo" onSubmit={submit}>
      <input
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="Add repo: /path/to/repo"
        aria-label="Repository path"
      />
      <button type="submit" disabled={busy || !path.trim()}>
        Add
      </button>
    </form>
  )
}
