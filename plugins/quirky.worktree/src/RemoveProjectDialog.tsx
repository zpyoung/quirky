import { useEffect, useRef, useState } from 'react'
import type { Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import { Button, Dialog, InlineError, NoticeLine } from '@quirky/ui'
import { removeProject } from './actions'
import { expectedLedgerSnapshots, ledgerRetentionNotice, previewLedgerRemoval, type LedgerRemovalPreview } from './ledger'
import { repoLabel } from './report'

type Props = {
  context: UiPluginContext
  repo: Repo
  worktrees: Worktree[]
  /** Null while `quirky.session` is off, in which case there is nothing to close. */
  sessions: Session[] | null
  onClose(): void
}

/** Confirms forgetting a project, saying how many open terminals go with it. */
export function RemoveProjectDialog({ context, repo, worktrees, sessions, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<LedgerRemovalPreview[] | null>()
  const [previewError, setPreviewError] = useState('')
  const generation = useRef(0)
  const ids = new Set(worktrees.filter((w) => w.repoId === repo.id).map((w) => w.id))
  const terminals = (sessions ?? []).filter((s) => s.worktreeId !== null && ids.has(s.worktreeId)).length
  const name = repoLabel(repo)

  async function loadPreview() {
    const current = ++generation.current
    setPreview(undefined)
    setPreviewError('')
    try {
      const result = await previewLedgerRemoval(context, { repoIds: [repo.id] })
      if (generation.current === current) setPreview(result)
    } catch (error) {
      if (generation.current === current) setPreviewError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    void loadPreview()
    return () => { generation.current++ }
  }, [context, repo.id])

  const remove = async () => {
    if (preview === undefined || previewError) return
    setBusy(true)
    const ok = await removeProject(context, repo.id, expectedLedgerSnapshots(preview))
    setBusy(false)
    if (ok) onClose()
    else void loadPreview()
  }

  const retention = ledgerRetentionNotice(preview ?? null)
  return (
    <Dialog open title="Remove Project" onClose={onClose}>
      <p className="ui-text-muted">
        {`This only removes ${name} from Quirky. It is still on your disk.`}
        {terminals > 0 && ` ${terminals} open ${terminals === 1 ? 'terminal' : 'terminals'} in this project will be closed.`}
      </p>
      {retention && <p className="ui-text-muted">{retention}</p>}
      {preview === undefined && !previewError && (
        <div role="status"><NoticeLine>Checking retained ledger records…</NoticeLine></div>
      )}
      {previewError && (
        <InlineError
          message={`Could not check retained ledger records: ${previewError}`}
          action={{ label: 'Retry', onAction: () => void loadPreview() }}
        />
      )}
      <div className="ui-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="destructive" autoFocus disabled={busy || preview === undefined || Boolean(previewError)} onClick={() => void remove()}>
          Remove
        </Button>
      </div>
    </Dialog>
  )
}
