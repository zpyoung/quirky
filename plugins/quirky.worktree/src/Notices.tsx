import { useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { deleteKeptBranch, type KeptBranch } from './actions'

type Props = {
  context: UiPluginContext
  kept: KeptBranch[]
  onDismiss(kept: KeptBranch): void
}

function KeptBranchNotice({ context, kept, onDismiss }: { context: UiPluginContext; kept: KeptBranch; onDismiss(): void }) {
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    const ok = await deleteKeptBranch(context, kept)
    setBusy(false)
    if (ok) onDismiss()
  }
  return (
    <div className="notice" role="status">
      <p className="notice-text">{`Kept branch ${kept.branch} because it isn't merged.`}</p>
      <div className="notice-actions">
        <button type="button" disabled={busy} onClick={() => void remove()}>
          Delete branch
        </button>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

/** Notices with actions, shown inside the section because plugin toasts carry none. */
export function Notices({ context, kept, onDismiss }: Props) {
  if (kept.length === 0) return null
  return (
    <div className="notices">
      {kept.map((entry) => (
        <KeptBranchNotice key={`${entry.repoId}:${entry.branch}`} context={context} kept={entry} onDismiss={() => onDismiss(entry)} />
      ))}
    </div>
  )
}
