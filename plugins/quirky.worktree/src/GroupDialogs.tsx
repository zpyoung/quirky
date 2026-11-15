import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ProjectGroup, Repo, UiPluginContext } from '@quirky/protocol'
import { Button, Dialog, InlineError, NoticeLine, TextField } from '@quirky/ui'
import { changeGroup, messageOf } from './actions'
import { expectedLedgerSnapshots, ledgerRetentionNotice, previewLedgerRemoval, type LedgerRemovalPreview } from './ledger'
import { repoLabel } from './report'
import { registerUiControlScope, requestUiControl, type ScopedUiControlArgs } from './ui-control'

type NameFormProps = {
  title: string
  submitLabel: string
  initial: string
  hint?: string
  onName(name: string, stillCurrent: () => boolean): Promise<boolean>
  onClose(): void
}

function NameForm({ title, submitLabel, initial, hint, onName, onClose }: NameFormProps) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const active = useRef(true)
  const trimmed = name.trim()

  useLayoutEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const stillCurrent = () => active.current
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!trimmed || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    let ok = false
    try {
      ok = await onName(trimmed, stillCurrent)
    } finally {
      if (!stillCurrent()) return
      busyRef.current = false
      setBusy(false)
      if (ok) onClose()
    }
  }

  return (
    <Dialog open title={title} onClose={onClose}>
      {hint && <p className="ui-text-muted">{hint}</p>}
      <form className="ui-stack" onSubmit={onSubmit}>
        <TextField
          type="text"
          label="Section name"
          id="project-group-name"
          autoFocus
          value={name}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="ui-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !trimmed}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Creates a group and puts `repo` in it. */
export function NewGroupDialog({ context, repo, onClose }: { context: UiPluginContext; repo: Repo; onClose(): void }) {
  const owner = useMemo(() => crypto.randomUUID(), [context, repo.id])
  return (
    <NameForm
      key={owner}
      title="New section"
      submitLabel="Create"
      initial=""
      hint={`${repoLabel(repo)} moves into the new section.`}
      onClose={onClose}
      onName={async (name, stillCurrent) => {
        const ok = await changeGroup(context, 'Could not create section', async () => {
          const created = (await context.call('quirky.repo/groupCreate', { name })) as ProjectGroup
          if (!stillCurrent()) return
          await context.call('quirky.repo/groupAdd', { group: created.id, repo: repo.id })
        })
        return ok && stillCurrent()
      }}
    />
  )
}

/** Creates a group and conditionally assigns only the worktree identity captured when opened. */
export function NewWorktreeGroupDialog({
  context,
  worktreeId,
  initialName,
  expectedInstanceId,
  expectedProjectGroupId,
  onClose
}: {
  context: UiPluginContext
  worktreeId: string
  initialName: string
  expectedInstanceId: string
  expectedProjectGroupId: string | null
  onClose(): void
}) {
  const owner = useMemo(
    () => crypto.randomUUID(),
    [context, worktreeId, expectedInstanceId, expectedProjectGroupId]
  )
  return (
    <NameForm
      key={owner}
      title="New section"
      submitLabel="Create"
      initial={initialName}
      hint="Only this worktree moves into the new section."
      onClose={onClose}
      onName={async (name, stillCurrent) => {
        try {
          const result = await context.call('quirky.worktree/createGroup', {
            worktree: worktreeId,
            name,
            expectedInstanceId,
            expectedProjectGroupId
          }) as { assigned: boolean; reason?: string }
          if (!result.assigned) {
            context.toast('Could not create section', result.reason ?? 'The worktree changed before it could be assigned.')
          }
          return stillCurrent()
        } catch (error) {
          context.toast('Could not create section', messageOf(error))
          return false
        }
      }}
    />
  )
}

export function RenameGroupDialog({ context, group, onClose }: { context: UiPluginContext; group: ProjectGroup; onClose(): void }) {
  const owner = useMemo(() => crypto.randomUUID(), [context, group.id])
  return (
    <NameForm
      key={owner}
      title="Rename section"
      submitLabel="Rename"
      initial={group.name}
      onClose={onClose}
      onName={async (name, stillCurrent) => {
        if (name === group.name) return stillCurrent()
        const ok = await changeGroup(context, 'Could not rename section', () =>
          context.call('quirky.repo/groupRename', { group: group.id, name })
        )
        return ok && stillCurrent()
      }}
    />
  )
}

function descendantGroupIds(groups: ProjectGroup[], rootId: string): string[] {
  const groupIds = [rootId]
  const included = new Set(groupIds)
  for (let index = 0; index < groupIds.length; index++) {
    const parentId = groupIds[index]!
    for (const group of groups) {
      if (group.parentId !== parentId || included.has(group.id)) continue
      included.add(group.id)
      groupIds.push(group.id)
    }
  }
  return groupIds
}

async function previewGroupRemoval(
  context: UiPluginContext,
  groupId: string,
  stillCurrent: () => boolean
): Promise<LedgerRemovalPreview[] | null | undefined> {
  const groups = (await context.call('quirky.repo/groupList')) as ProjectGroup[]
  if (!stillCurrent()) return undefined
  const preview = await previewLedgerRemoval(context, { groupIds: descendantGroupIds(groups, groupId) })
  return stillCurrent() ? preview : undefined
}

type PreviewState =
  | { owner: string; status: 'loading' }
  | { owner: string; status: 'ready'; preview: LedgerRemovalPreview[] | null }
  | { owner: string; status: 'error'; message: string }

type GroupControlState = {
  groupId: string
  owner: string
  revision(): number
  preview(): PreviewState
  busy(): boolean
  pending(): boolean
  retry(): void
}

function invalidGroupControl(): never {
  throw new Error('Invalid group-dialog control.')
}

function isGroupControlResult(value: unknown, request: ScopedUiControlArgs): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== 6) return false
  if (result.action !== request.action || result.scope !== request.scope ||
      result.target !== request.target || result.operation !== request.operation) return false
  if (typeof result.payload !== 'object' || result.payload === null || Array.isArray(result.payload)) return false
  const payload = result.payload as Record<string, unknown>
  const expectedKeys = Object.keys(request.payload)
  if (Object.keys(payload).length !== expectedKeys.length) return false
  if (expectedKeys.some((key) => !Object.hasOwn(payload, key) || payload[key] !== request.payload[key])) return false
  return typeof result.delivered === 'number' && Number.isSafeInteger(result.delivered) && result.delivered >= 0
}

export function DeleteGroupDialog({ context, group, onClose }: { context: UiPluginContext; group: ProjectGroup; onClose(): void }) {
  const owner = useMemo(() => crypto.randomUUID(), [context, group.id])
  const ownerRef = useRef<string>(owner)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [preview, setPreview] = useState<PreviewState>({ owner, status: 'loading' })
  const previewRef = useRef(preview)
  const pendingRef = useRef(false)
  const revisionRef = useRef(0)
  const committedOwner = useRef({ context, groupId: group.id, owner })
  const controlRef = useRef<GroupControlState | null>(null)

  const runPreview = useCallback(() => {
    const { context: readContext, groupId, owner: readOwner } = committedOwner.current
    if (ownerRef.current !== readOwner) return
    const ticket = ++revisionRef.current
    pendingRef.current = true
    const loading: PreviewState = { owner: readOwner, status: 'loading' }
    previewRef.current = loading
    setPreview(loading)
    const stillCurrent = () => ownerRef.current === readOwner && revisionRef.current === ticket
    void previewGroupRemoval(readContext, groupId, stillCurrent).then(
      (result) => {
        if (result === undefined || !stillCurrent()) return
        pendingRef.current = false
        revisionRef.current += 1
        const ready: PreviewState = { owner: readOwner, status: 'ready', preview: result }
        previewRef.current = ready
        setPreview(ready)
      },
      (error: unknown) => {
        if (!stillCurrent()) return
        pendingRef.current = false
        revisionRef.current += 1
        const failed: PreviewState = { owner: readOwner, status: 'error', message: messageOf(error) }
        previewRef.current = failed
        setPreview(failed)
      }
    )
  }, [])

  useLayoutEffect(() => {
    if (ownerRef.current !== owner) {
      revisionRef.current += 1
      pendingRef.current = false
      busyRef.current = false
      setBusy(false)
      const loading: PreviewState = { owner, status: 'loading' }
      previewRef.current = loading
      setPreview(loading)
    }
    ownerRef.current = owner
    committedOwner.current = { context, groupId: group.id, owner }
    return () => {
      revisionRef.current += 1
      pendingRef.current = false
      busyRef.current = false
      if (ownerRef.current === owner) ownerRef.current = ''
    }
  }, [context, group.id, owner])

  useLayoutEffect(() => {
    controlRef.current = {
      groupId: group.id,
      owner,
      revision: () => revisionRef.current,
      preview: () => previewRef.current.owner === owner ? previewRef.current : { owner, status: 'loading' },
      busy: () => busyRef.current,
      pending: () => pendingRef.current,
      retry: runPreview
    }
  }, [context, group.id, owner, runPreview])

  useEffect(() => {
    runPreview()
    return () => {
      revisionRef.current += 1
      pendingRef.current = false
    }
  }, [context, group.id, owner, runPreview])

  useLayoutEffect(() => registerUiControlScope(context, 'group-dialog', (args: ScopedUiControlArgs) => {
    const current = controlRef.current
    if (!current || args.target !== current.groupId) return false
    if (args.operation !== 'retry-preview') return invalidGroupControl()
    const payload = args.payload
    if (Object.keys(payload).some((key) => key !== 'owner' && key !== 'revision')) return invalidGroupControl()
    const hasOwner = Object.hasOwn(payload, 'owner')
    if (hasOwner && (typeof payload.owner !== 'string' || payload.owner.trim() === '')) return invalidGroupControl()
    const hasRevision = Object.hasOwn(payload, 'revision')
    if (hasRevision && (typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0)) {
      return invalidGroupControl()
    }
    if (hasOwner && payload.owner !== current.owner) return false
    if (hasRevision && payload.revision !== current.revision()) return false
    if (current.preview().status !== 'error' || current.busy() || current.pending()) return false
    current.retry()
    return true
  }), [context])

  const visiblePreview: PreviewState = preview.owner === owner ? preview : { owner, status: 'loading' }
  const requestRetry = () => {
    const requestedOwner = owner
    const args: ScopedUiControlArgs = {
      action: 'control',
      scope: 'group-dialog',
      target: group.id,
      operation: 'retry-preview',
      payload: { owner: requestedOwner, revision: revisionRef.current }
    }
    void requestUiControl(context, args).then((result) => {
      if (ownerRef.current !== requestedOwner) return
      if (!isGroupControlResult(result, args)) throw new Error('The window returned no UI control result.')
      if (result.delivered === 0) context.log('worktree: retry-preview reached no mounted target')
    }).catch((error: unknown) => {
      if (ownerRef.current !== requestedOwner) return
      context.toast('Could not update section dialog', messageOf(error))
    })
  }

  const remove = async () => {
    const current = previewRef.current
    if (ownerRef.current !== owner || current.owner !== owner || current.status !== 'ready' || busyRef.current || pendingRef.current) return
    const operationOwner = owner
    busyRef.current = true
    setBusy(true)
    const expectedLedgers = expectedLedgerSnapshots(current.preview)
    const ok = await changeGroup(context, 'Could not delete section', () => context.call('quirky.repo/groupDelete', {
      group: group.id,
      ...(expectedLedgers === undefined ? {} : { expectedLedgers })
    }))
    if (ownerRef.current !== operationOwner) return
    busyRef.current = false
    setBusy(false)
    if (ok) onClose()
    else runPreview()
  }

  const retention = visiblePreview.status === 'ready'
    ? visiblePreview.preview?.length === 0
      ? 'Ledger records retained: No affected ledgers.'
      : ledgerRetentionNotice(visiblePreview.preview)
    : null

  return (
    <Dialog open title="Delete section" onClose={onClose}>
      <p className="ui-text-muted">{`Delete the section ${group.name}? Projects in this section stay in Quirky.`}</p>
      {retention && <p className="ui-text-muted">{retention}</p>}
      {visiblePreview.status === 'loading' && <div role="status"><NoticeLine>Checking retained ledger records…</NoticeLine></div>}
      {visiblePreview.status === 'error' && (
        <InlineError
          message={`Could not check retained ledger records: ${visiblePreview.message}`}
          action={{ label: 'Retry', onAction: requestRetry }}
        />
      )}
      <div className="ui-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button
          type="button"
          variant="destructive"
          autoFocus
          disabled={busy || visiblePreview.status !== 'ready' || pendingRef.current}
          onClick={() => void remove()}
        >
          Delete section
        </Button>
      </div>
    </Dialog>
  )
}

