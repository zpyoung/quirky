import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, Dialog, TextField } from '@quirky/ui'
import { isSafeIcon } from './safe-icon'
import { DEFAULT_WORKTREE_STATUSES } from './daemon/statuses'
import type { WorktreeStatusDefinition } from './parity-types'
import { registerUiControlScope, requestUiControl, type ScopedUiControlArgs } from './ui-control'

type Props = {
  context: UiPluginContext
  statuses: WorktreeStatusDefinition[]
  onClose(): void
  onSaved(statuses: WorktreeStatusDefinition[]): void
}

type DraftRow = {
  key: number
  builtinId: string | null
  status: WorktreeStatusDefinition
}
type Registration = { context: UiPluginContext; owner: string; active: boolean }
type StatusControlResult = {
  action: 'control'
  scope: 'status-settings'
  target: 'statuses'
  operation: string
  payload: Record<string, unknown>
  delivered: number
}

const SCOPE = 'status-settings'
const TARGET = 'statuses'
const INVALID_CONTROL = 'Invalid status-settings control.'
const BUILTIN_IDS: Record<string, true> = { todo: true, 'in-progress': true, 'in-review': true, done: true }

function invalidControl(): never {
  throw new Error(INVALID_CONTROL)
}

function onlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(payload).some((key) => !allowed.includes(key))) invalidControl()
}

function controlGuards(payload: Record<string, unknown>): { owner?: string; revision?: number } {
  let owner: string | undefined
  let revision: number | undefined
  if (Object.hasOwn(payload, 'owner')) {
    if (typeof payload.owner !== 'string' || payload.owner.trim() === '') invalidControl()
    owner = payload.owner
  }
  if (Object.hasOwn(payload, 'revision')) {
    if (typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0) invalidControl()
    revision = payload.revision
  }
  return { owner, revision }
}

function isControlResult(value: unknown, operation: string): value is StatusControlResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return result.action === 'control' &&
    result.scope === SCOPE &&
    result.target === TARGET &&
    result.operation === operation &&
    typeof result.payload === 'object' && result.payload !== null && !Array.isArray(result.payload) &&
    typeof result.delivered === 'number' && Number.isSafeInteger(result.delivered) && result.delivered >= 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function StatusSettingsDialog({ context, statuses, onClose, onSaved }: Props) {
  const instanceId = useId()
  const nextRowKey = useRef(0)
  const [draft, setDraft] = useState<DraftRow[]>(() => statuses.map((status) => ({
    key: ++nextRowKey.current,
    builtinId: BUILTIN_IDS[status.id] ? status.id : null,
    status: { ...status }
  })))
  const draftRef = useRef(draft)
  const revision = useRef(0)
  const busyRef = useRef(false)
  const busyOperation = useRef(0)
  const owner = useMemo(() => crypto.randomUUID(), [context])
  const [busy, setBusy] = useState(false)
  const registration = useRef<Registration | null>(null)
  const handler = useRef<(args: ScopedUiControlArgs) => boolean>(() => false)
  const savedCallback = useRef(onSaved)
  const previousOwner = useRef({ context, owner })

  const currentRegistration = (candidate: Registration | null): candidate is Registration =>
    candidate !== null && candidate.active && registration.current === candidate &&
    candidate.context === context && candidate.owner === owner

  const commitDraft = (next: DraftRow[]) => {
    draftRef.current = next
    revision.current += 1
    setDraft(next)
  }

  const update = (key: number, field: keyof WorktreeStatusDefinition, value: string) => {
    if (busyRef.current) return
    const current = draftRef.current
    const row = current.find((item) => item.key === key)
    if (!row || row.status[field] === value) return
    commitDraft(current.map((item) => item.key === key
      ? { ...item, status: { ...item.status, [field]: value } }
      : item))
  }

  const addStatus = () => {
    if (busyRef.current) return
    let suffix = DEFAULT_WORKTREE_STATUSES.length + 1
    while (draftRef.current.some((row) => row.status.id === `custom-${suffix}`)) suffix += 1
    commitDraft([...draftRef.current, {
      key: ++nextRowKey.current,
      builtinId: null,
      status: { id: `custom-${suffix}`, label: 'Custom status', color: DEFAULT_WORKTREE_STATUSES[0]!.color }
    }])
  }

  const removeStatus = (index: number) => {
    if (busyRef.current) return
    const row = draftRef.current[index]
    if (!row || row.builtinId !== null) return
    commitDraft(draftRef.current.filter((_, currentIndex) => currentIndex !== index))
  }

  const handleControl = (args: ScopedUiControlArgs): boolean => {
    if (args.target !== TARGET) return false
    const { payload } = args
    const guards = controlGuards(payload)
    const guardKeys = ['owner', 'revision']

    if (args.operation === 'add-status') {
      onlyKeys(payload, guardKeys)
    } else if (args.operation === 'remove-status') {
      onlyKeys(payload, [...guardKeys, 'index'])
      if (!Object.hasOwn(payload, 'index') || typeof payload.index !== 'number' ||
        !Number.isSafeInteger(payload.index) || payload.index < 0) invalidControl()
    } else {
      return invalidControl()
    }

    const mounted = registration.current
    if (!mounted || !currentRegistration(mounted) || args.action !== 'control' || args.scope !== SCOPE) return false
    if (guards.owner !== undefined && guards.owner !== owner) return false
    if (guards.revision !== undefined && guards.revision !== revision.current) return false
    if (busyRef.current) return false

    if (args.operation === 'add-status') {
      addStatus()
      return true
    }
    const index = payload.index as number
    const row = draftRef.current[index]
    if (!row || row.builtinId !== null) return false
    removeStatus(index)
    return true
  }

  useLayoutEffect(() => {
    if (previousOwner.current.context !== context || previousOwner.current.owner !== owner) {
      busyRef.current = false
      busyOperation.current += 1
      setBusy(false)
    }
    previousOwner.current = { context, owner }
    savedCallback.current = onSaved
    handler.current = handleControl
  })

  useLayoutEffect(() => {
    const mounted: Registration = { context, owner, active: true }
    registration.current = mounted
    const unregister = registerUiControlScope(context, SCOPE, (args) => mounted.active && handler.current(args))
    return () => {
      mounted.active = false
      if (registration.current === mounted) registration.current = null
      unregister()
    }
  }, [context, owner])

  const sendControl = async (operation: 'add-status' | 'remove-status', extra: Record<string, unknown> = {}) => {
    const requestContext = context
    const requestOwner = owner
    const mounted = registration.current
    if (!mounted || !currentRegistration(mounted)) return
    const args = {
      action: 'control' as const,
      scope: SCOPE,
      target: TARGET,
      operation,
      payload: { ...extra, owner: requestOwner, revision: revision.current }
    }
    try {
      const result: unknown = await requestUiControl(requestContext, args)
      if (!currentRegistration(mounted)) return
      if (!isControlResult(result, operation)) throw new Error('The window returned no UI control result.')
      if (result.delivered === 0) requestContext.log(`worktree: ${operation} reached no mounted target`)
    } catch (error) {
      if (!currentRegistration(mounted)) return
      requestContext.toast('Could not update workspace statuses', errorMessage(error))
    }
  }

  const save = async () => {
    if (busyRef.current) return
    const submitted = draftRef.current.map((row) => ({ ...row.status }))
    if (submitted.some((status) => status.icon !== undefined && !isSafeIcon(status.icon))) {
      context.toast('Invalid status icon', 'Use plain-text emoji or symbols; URLs, SVG and HTML are not allowed.')
      return
    }

    const requestContext = context
    const mounted = registration.current
    if (!mounted || !currentRegistration(mounted)) return
    busyRef.current = true
    const operation = ++busyOperation.current
    setBusy(true)
    try {
      const saved: unknown = await requestContext.call('quirky.worktree/setStatusDefinitions', { statuses: submitted })
      if (!currentRegistration(mounted) || busyOperation.current !== operation) return
      if (!Array.isArray(saved)) throw new Error('The workspace status owner returned an invalid result.')
      savedCallback.current(saved as WorktreeStatusDefinition[])
    } catch (error) {
      if (!currentRegistration(mounted) || busyOperation.current !== operation) return
      requestContext.toast('Could not save workspace statuses', errorMessage(error))
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open title="Workspace statuses" onClose={onClose}>
      <div className="ui-stack">
        {draft.map((row, index) => {
          const status = row.status
          return (
            <fieldset key={row.key} className="ui-stack" disabled={busy}>
              <legend>{status.label || status.id || `Status ${index + 1}`}</legend>
              <TextField
                label="Status ID"
                id={`${instanceId}-status-${row.key}-id`}
                aria-label={`Status ID ${index + 1}`}
                value={status.id}
                disabled={row.builtinId !== null}
                onChange={(event) => update(row.key, 'id', event.target.value)}
              />
              <TextField
                label="Status label"
                id={`${instanceId}-status-${row.key}-label`}
                aria-label={`Status label ${index + 1}`}
                value={status.label}
                onChange={(event) => update(row.key, 'label', event.target.value)}
              />
              <TextField
                label="Status color"
                id={`${instanceId}-status-${row.key}-color`}
                aria-label={`Status color ${index + 1}`}
                value={status.color}
                onChange={(event) => update(row.key, 'color', event.target.value)}
                help="Stored color data remains editable; the interface uses shared semantic colors."
              />
              <TextField
                label="Status icon/avatar"
                id={`${instanceId}-status-${row.key}-icon`}
                aria-label={`Status icon ${index + 1}`}
                value={status.icon ?? ''}
                maxLength={32}
                onChange={(event) => update(row.key, 'icon', event.target.value)}
                placeholder="Emoji or symbol"
                help="Plain-text emoji or symbols only; URLs, SVG and HTML are rejected."
              />
              {row.builtinId === null && (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => void sendControl('remove-status', { index })}>
                  Remove status
                </Button>
              )}
            </fieldset>
          )
        })}
        <Button type="button" disabled={busy} onClick={() => void sendControl('add-status')}>Add status</Button>
        <div className="ui-actions">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>Save statuses</Button>
        </div>
      </div>
    </Dialog>
  )
}
