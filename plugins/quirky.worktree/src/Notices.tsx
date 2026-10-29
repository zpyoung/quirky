import { Button, SectionHeader } from '@quirky/ui'
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
    <div className="ui-stack" role="status">
      <p>{`Kept branch ${kept.branch} because it isn't merged.`}</p>
      <div className="ui-cluster ui-actions">
        <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
          Delete branch
        </Button>
        <Button type="button" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

/** Notices with actions, shown inside the section because plugin toasts carry none. */
export function Notices({ context, kept, onDismiss }: Props) {
  if (kept.length === 0) return null
  return (
    <section className="ui-stack" aria-label="Kept branches">
      <SectionHeader title="Kept branches" />
      {kept.map((entry) => (
        <KeptBranchNotice key={`${entry.repoId}:${entry.branch}`} context={context} kept={entry} onDismiss={() => onDismiss(entry)} />
      ))}
    </section>
  )
}
