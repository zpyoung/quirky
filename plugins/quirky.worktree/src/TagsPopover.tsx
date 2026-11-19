import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, Checkbox, EmptyState, InlineError, NoticeLine, Popover, SwatchGroup, TextField } from '@quirky/ui'
import { assignTag, createTag, fetchTags, updateTag, type TagsSnapshot } from './actions'
import { registerUiControlScope, requestUiControl, type ScopedUiControlArgs } from './ui-control'
import type { Tag, TagColor } from './view-types'

type Props = {
  context: UiPluginContext
  /** The worktrees the popover tags: one for a row, several for a selection. */
  worktreeIds: string[]
  anchor: HTMLElement
  onClose(): void
}
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; error: string }
type Registration = { context: UiPluginContext; owner: string; selectionKey: string; active: boolean }
type MutationLease = { registration: Registration; token: number; context: UiPluginContext; worktreeIds: string[] }
type TagsControlResult = {
  action: 'control'
  scope: 'tags-popover'
  target: 'tags'
  operation: string
  payload: Record<string, unknown>
  delivered: number
}

const SCOPE = 'tags-popover'
const TARGET = 'tags'
const INVALID_CONTROL = 'Invalid tags-popover control.'

function invalidControl(): never {
  throw new Error(INVALID_CONTROL)
}

function onlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(payload).some((key) => !allowed.includes(key))) invalidControl()
}

function validWorktreeIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((id) => typeof id === 'string' && id.trim() !== '')
}

function selectionIdentity(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort())
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

function isControlResult(value: unknown, operation: string): value is TagsControlResult {
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

function snapshotHasTag(snapshot: TagsSnapshot | null, tagId: string): boolean {
  return snapshot?.tags.some((tag) => tag.id === tagId) ?? false
}

/**
 * Checks, creates and recolors tags for one or several worktrees. With several, a tag only some of
 * them carry shows a mixed checkbox. It reloads on `tagsChanged`, so other windows' edits show up.
 */
export function TagsPopover({ context, worktreeIds, anchor, onClose }: Props) {
  const selectionKey = selectionIdentity(worktreeIds)
  const owner = useMemo(() => crypto.randomUUID(), [context, selectionKey])
  const anchorRef = useRef<HTMLElement>(anchor)
  const colorAnchors = useRef(new Map<string, HTMLButtonElement>())
  const [snapshot, setSnapshot] = useState<TagsSnapshot | null>(null)
  const snapshotRef = useRef<TagsSnapshot | null>(null)
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' })
  const loadStateRef = useRef<LoadState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const queryRef = useRef('')
  const [coloring, setColoring] = useState<string | null>(null)
  const coloringRef = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const revision = useRef(0)
  const readTicket = useRef(0)
  const mutationToken = useRef(0)
  const currentMutation = useRef<MutationLease | null>(null)
  const registration = useRef<Registration | null>(null)
  const handler = useRef<(args: ScopedUiControlArgs) => boolean>(() => false)
  const previousOwner = useRef({ context, selectionKey, anchor })

  anchorRef.current = anchor

  const currentRegistration = useCallback((candidate: Registration | null): candidate is Registration =>
    candidate !== null && candidate.active && registration.current === candidate &&
    candidate.context === context && candidate.owner === owner && candidate.selectionKey === selectionKey,
  [context, owner, selectionKey])

  const setReadState = useCallback((next: LoadState) => {
    loadStateRef.current = next
    revision.current += 1
    setLoadState(next)
  }, [setLoadState])

  const setColor = useCallback((next: string | null) => {
    if (coloringRef.current === next) return
    coloringRef.current = next
    revision.current += 1
    setColoring(next)
  }, [setColoring])

  const load = useCallback(async () => {
    const mounted = registration.current
    if (!mounted || !currentRegistration(mounted)) return
    const ticket = ++readTicket.current
    setReadState({ kind: 'loading' })
    try {
      const next = await fetchTags(context)
      if (!currentRegistration(mounted) || ticket !== readTicket.current) return
      snapshotRef.current = next
      setSnapshot(next)
      setReadState({ kind: 'ready' })
      if (coloringRef.current !== null && !snapshotHasTag(next, coloringRef.current)) setColor(null)
    } catch (error) {
      if (!currentRegistration(mounted) || ticket !== readTicket.current) return
      const message = errorMessage(error)
      context.log(`could not load tags: ${message}`)
      setReadState({ kind: 'error', error: message })
    }
  }, [context, currentRegistration, owner, selectionKey, setColor, setReadState])

  const finishMutation = (lease: MutationLease) => {
    if (!currentRegistration(lease.registration) || currentMutation.current?.token !== lease.token) return
    currentMutation.current = null
    busyRef.current = false
    setBusy(false)
  }

  const startMutation = (): MutationLease | null => {
    const mounted = registration.current
    if (!mounted || !currentRegistration(mounted) || busyRef.current ||
      loadStateRef.current.kind !== 'ready' || worktreeIds.length === 0) return null
    const lease: MutationLease = {
      registration: mounted,
      token: ++mutationToken.current,
      context,
      worktreeIds: [...worktreeIds]
    }
    currentMutation.current = lease
    busyRef.current = true
    setBusy(true)
    return lease
  }

  const mutationIsCurrent = (lease: MutationLease): boolean =>
    currentRegistration(lease.registration) && currentMutation.current?.token === lease.token

  const toggle = async (tagId: string, assigned: boolean) => {
    if (!snapshotHasTag(snapshotRef.current, tagId)) return
    const lease = startMutation()
    if (!lease) return
    try {
      const updated = await assignTag(lease.context, lease.worktreeIds, tagId, assigned)
      if (!mutationIsCurrent(lease)) return
      if (updated) await load()
    } finally {
      finishMutation(lease)
    }
  }

  const create = async () => {
    const submittedQuery = queryRef.current
    const name = submittedQuery.trim()
    if (name === '') return
    const lease = startMutation()
    if (!lease) return
    try {
      const created = await createTag(lease.context, name)
      if (!created || !mutationIsCurrent(lease)) return
      if (queryRef.current === submittedQuery) {
        queryRef.current = ''
        setQuery('')
      }
      const assigned = await assignTag(lease.context, lease.worktreeIds, created.id, true)
      if (!mutationIsCurrent(lease)) return
      if (assigned) await load()
    } finally {
      finishMutation(lease)
    }
  }

  const recolor = async (tagId: string, color: TagColor | null) => {
    if (!snapshotHasTag(snapshotRef.current, tagId)) return
    const lease = startMutation()
    if (!lease) return
    try {
      const updated = await updateTag(lease.context, tagId, { color })
      if (!mutationIsCurrent(lease)) return
      if (updated) await load()
    } finally {
      finishMutation(lease)
    }
  }

  const handleControl = (args: ScopedUiControlArgs): boolean => {
    if (args.target !== TARGET) return false
    const { payload } = args
    const guards = controlGuards(payload)
    let requestedIds: string[]
    let tagId: string | null = null
    if (args.operation === 'retry') {
      onlyKeys(payload, ['owner', 'revision', 'worktreeIds'])
    } else if (args.operation === 'set-color-picker') {
      onlyKeys(payload, ['owner', 'revision', 'worktreeIds', 'tagId'])
      if (!Object.hasOwn(payload, 'tagId') ||
        (payload.tagId !== null && (typeof payload.tagId !== 'string' || payload.tagId.trim() === ''))) invalidControl()
      tagId = payload.tagId as string | null
    } else {
      return invalidControl()
    }
    if (!validWorktreeIds(payload.worktreeIds)) invalidControl()
    requestedIds = payload.worktreeIds

    const mounted = registration.current
    if (!mounted || !currentRegistration(mounted) || args.action !== 'control' || args.scope !== SCOPE) return false
    if (guards.owner !== undefined && guards.owner !== owner) return false
    if (guards.revision !== undefined && guards.revision !== revision.current) return false
    if (selectionIdentity(requestedIds) !== selectionKey || busyRef.current) return false
    if (args.operation === 'retry') {
      if (loadStateRef.current.kind !== 'error') return false
      void load()
      return true
    }
    if (loadStateRef.current.kind !== 'ready') return false

    if (worktreeIds.length === 0 || !anchorRef.current.isConnected) return false
    const anchorTagId = tagId ?? coloringRef.current
    if (anchorTagId === null || !colorAnchors.current.get(anchorTagId)?.isConnected) return false
    if (tagId !== null && !snapshotHasTag(snapshotRef.current, tagId)) return false
    setColor(tagId)
    return true
  }

  useLayoutEffect(() => {
    const previous = previousOwner.current
    const ownerChanged = previous.context !== context || previous.selectionKey !== selectionKey
    if (ownerChanged || previous.anchor !== anchor) revision.current += 1
    if (ownerChanged) {
      readTicket.current += 1
      currentMutation.current = null
      busyRef.current = false
      setBusy(false)
      setColor(null)
      setReadState({ kind: 'loading' })
    }
    previousOwner.current = { context, selectionKey, anchor }
    handler.current = handleControl
  })

  useLayoutEffect(() => {
    const mounted: Registration = { context, owner, selectionKey, active: true }
    registration.current = mounted
    const unregister = registerUiControlScope(context, SCOPE, (args) => mounted.active && handler.current(args))
    return () => {
      mounted.active = false
      readTicket.current += 1
      if (registration.current === mounted) registration.current = null
      unregister()
    }
  }, [context, owner, selectionKey])

  useEffect(() => {
    void load()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.worktree/tagsChanged') void load()
    })
    return () => {
      readTicket.current += 1
      unsubscribe()
    }
  }, [context, owner, selectionKey, load])

  const sendControl = async (operation: 'retry' | 'set-color-picker', extra: Record<string, unknown>) => {
    const requestContext = context
    const mounted = registration.current
    if (!mounted || !currentRegistration(mounted)) return
    const args = {
      action: 'control' as const,
      scope: SCOPE,
      target: TARGET,
      operation,
      payload: { ...extra, owner, revision: revision.current }
    }
    try {
      const result: unknown = await requestUiControl(requestContext, args)
      if (!currentRegistration(mounted)) return
      if (!isControlResult(result, operation)) throw new Error('The window returned no UI control result.')
      if (result.delivered === 0) requestContext.log(`worktree: ${operation} reached no mounted target`)
    } catch (error) {
      if (!currentRegistration(mounted)) return
      requestContext.toast('Could not update tags', errorMessage(error))
    }
  }

  const tags = snapshot?.tags ?? []
  const assignments = snapshot?.assignments ?? {}
  const needle = query.trim().toLowerCase()
  const shown = needle === '' ? tags : tags.filter((tag) => tag.name.toLowerCase().includes(needle))
  const exact = tags.some((tag) => tag.name.toLowerCase() === needle)
  const canCreate = loadState.kind === 'ready' && needle !== '' && !exact
  const targets = useMemo(() => [...new Set(worktreeIds)], [selectionKey])
  const unavailable = loadState.kind !== 'ready' || busy || targets.length === 0
  const countOf = (tagId: string) => targets.filter((id) => assignments[id]?.includes(tagId)).length
  const setQueryValue = (value: string) => {
    queryRef.current = value
    setQuery(value)
  }

  return (
    <Popover open label="Tags" anchor={anchorRef} onClose={onClose}>
      <div className="ui-stack worktree-tags">
        <TextField
          label="Add or create a tag"
          autoFocus
          value={query}
          onChange={(event) => setQueryValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (canCreate && !unavailable) void create()
            else if (!unavailable && shown.length === 1) void toggle(shown[0]!.id, countOf(shown[0]!.id) !== targets.length)
          }}
        />
        {loadState.kind === 'loading' && <div role="status"><NoticeLine>Loading tags…</NoticeLine></div>}
        {loadState.kind === 'error' && (
          <InlineError
            message={`Could not load tags: ${loadState.error}`}
            action={{
              label: 'Retry',
              onAction: () => void sendControl('retry', { worktreeIds: [...worktreeIds] })
            }}
          />
        )}
        {loadState.kind === 'ready' && tags.length === 0 && !canCreate && (
          <div role="status"><EmptyState message="No tags yet. Type a name to create one." /></div>
        )}
        <fieldset className="ui-stack" disabled={unavailable}>
          <ul className="ui-tree worktree-tags__list">
            {shown.map((item) => {
              const count = countOf(item.id)
              const all = targets.length > 0 && count === targets.length
              return (
                <li key={item.id} className="ui-tree-item">
                  <div className="worktree-tags__row">
                    <Checkbox
                      checked={all}
                      indeterminate={count > 0 && !all}
                      label={item.name}
                      onChange={(assigned) => void toggle(item.id, assigned)}
                    />
                    <button
                      ref={(node) => {
                        if (node) colorAnchors.current.set(item.id, node)
                        else colorAnchors.current.delete(item.id)
                      }}
                      type="button"
                      className="ui-swatch"
                      data-color={item.color ?? 'grey'}
                      aria-label={`Color for ${item.name}`}
                      aria-expanded={coloring === item.id}
                      disabled={unavailable}
                      onClick={() => void sendControl('set-color-picker', {
                        worktreeIds: [...worktreeIds],
                        tagId: coloring === item.id ? null : item.id
                      })}
                    />
                  </div>
                  {coloring === item.id && (
                    <SwatchGroup
                      label={`Color for ${item.name}`}
                      value={item.color}
                      onChange={(color) => void recolor(item.id, color)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
          {canCreate && (
            <Button
              type="button"
              className="worktree-tags__create"
              disabled={unavailable}
              onClick={() => void create()}
            >
              {`Create "${query.trim()}"`}
            </Button>
          )}
        </fieldset>
      </div>
    </Popover>
  )
}
