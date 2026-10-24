import { useState, type FormEvent } from 'react'
import { addRepo } from '../actions'
import { useConnection } from '../context'

export function AddRepoForm() {
  const connection = useConnection()
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!path.trim()) return
    setBusy(true)
    if (await addRepo(connection, path.trim())) setPath('')
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
