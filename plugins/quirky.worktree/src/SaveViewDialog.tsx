import { useState } from 'react'
import { Button, Checkbox, Dialog, TextField } from '@quirky/ui'

type Props = {
  /** What the new view captures, as a plain sentence. */
  summary: string
  busy?: boolean
  onSave(name: string, starred: boolean): void
  onClose(): void
}

/** Names the filter, grouping and sort on screen as a new saved view. */
export function SaveViewDialog({ summary, busy = false, onSave, onClose }: Props) {
  const [name, setName] = useState('')
  const [starred, setStarred] = useState(true)
  const trimmed = name.trim()
  return (
    <Dialog open title="Save view" onClose={onClose}>
      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed) onSave(trimmed, starred)
        }}
      >
        <TextField type="text" label="Name" id="worktree-view-name" autoFocus maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
        <p className="ui-help-text">{summary}</p>
        <Checkbox label="Show as a tab" checked={starred} onChange={setStarred} />
        <div className="ui-actions">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !trimmed}>Save view</Button>
        </div>
      </form>
    </Dialog>
  )
}
