import { useState } from 'react'

type Props = { canCommit: boolean; onCommit: (message: string) => Promise<boolean> }

export function CommitBox({ canCommit, onCommit }: Props) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = canCommit && message.trim().length > 0 && !busy

  const commit = async () => {
    if (!ready) return
    setBusy(true)
    if (await onCommit(message.trim())) setMessage('')
    setBusy(false)
  }

  return (
    <div className="commit-box">
      <textarea
        rows={3}
        value={message}
        placeholder="Commit message"
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void commit()
        }}
      />
      <button className="primary" disabled={!ready} onClick={() => void commit()}>
        Commit
      </button>
    </div>
  )
}
