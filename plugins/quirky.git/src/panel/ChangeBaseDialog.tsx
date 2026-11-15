import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Dialog, EmptyState, InlineError, ListRow, NoticeLine, TextField } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from './format'

type Ref = { name: string; kind: 'local' | 'remote' }

type Props = {
  context: UiPluginContext
  worktree: string
  /** The base in use, marked in the list. */
  current: string | null
  /** Reviewed or changed-since-review files; a new base clears their marks. */
  marks?: number
  onClose(): void
  /** Runs after the base was written, so the panel can reload its compare. */
  onChanged(): Promise<void>
}

const stripRemote = (ref: string): string => ref.replace(/^(?:refs\/)?remotes\//, '')

/** "Change Base Ref": pick the branch compare target, or clear it with Use Primary. */
export function ChangeBaseDialog({ context, worktree, current, marks = 0, onClose, onChanged }: Props) {
  const [query, setQuery] = useState('')
  const [refs, setRefs] = useState<Ref[]>([])
  const [readError, setReadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const branchRequest = useRef(0)
  const branches = useRef<HTMLDivElement>(null)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const onDialogClose = () => {
    if (!alive.current) return
    onClose()
  }

  const readBranches = useCallback((currentQuery: string) => {
    const request = ++branchRequest.current
    setLoading(true)
    context
      .call('quirky.git/branches', currentQuery.trim() === '' ? { worktree } : { worktree, query: currentQuery.trim() })
      .then((result) => {
        if (request !== branchRequest.current) return
        setRefs((result as { refs: Ref[] }).refs)
        setReadError(null)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (request !== branchRequest.current) return
        setRefs([])
        setReadError(messageOf(e))
        setLoading(false)
      })
  }, [context, worktree])

  useEffect(() => {
    readBranches(query)
    return () => {
      branchRequest.current++
    }
  }, [readBranches, query])

  const onRetryBranches = () => {
    setReadError(null)
    readBranches(query)
  }

  const onSaveBase = async (params: { base: string } | { clear: true }) => {
    setSaving(true)
    setSaveError(null)
    try {
      await context.call('quirky.git/setBase', { worktree, ...params })
      await onChanged()
      if (!alive.current) return
      setSaving(false)
      onDialogClose()
    } catch (e) {
      if (!alive.current) return
      setSaveError(messageOf(e))
      setSaving(false)
    }
  }

  const base = current === null ? null : stripRemote(current)
  return (
    <Dialog
      open
      title="Change Base Ref"
      onClose={onDialogClose}
      actions={<Button onClick={onDialogClose}>Close</Button>}
    >
      <div className="ui-stack">
        <p className="ui-text-muted">Pick the branch compare target for this repository.</p>
        {marks > 0 && <p role="status" data-clears-marks>{`This clears ${marks} review ${marks === 1 ? 'mark' : 'marks'}`}</p>}
        <div className="ui-cluster">
          <span className="ui-text-muted">{base === null ? 'No base ref in use' : `Current: ${base}`}</span>
          <Button disabled={saving} onClick={() => void onSaveBase({ clear: true })}>
            Use Primary
          </Button>
        </div>
        <TextField
          label="Search branches"
          type="text"
          autoFocus
          aria-label="Search branches"
          placeholder="Search branches…"
          value={query}
          onChange={(event) => {
            setLoading(true)
            setReadError(null)
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || loading || saving) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              branches.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
            } else if (event.key === 'Enter' && refs.length === 1) {
              event.preventDefault()
              void onSaveBase({ base: refs[0]!.name })
            }
          }}
        />
        {readError !== null && <InlineError message={readError} action={{ label: 'Retry', onAction: onRetryBranches }} />}
        {saveError !== null && <InlineError message={saveError} />}
        <div
          ref={branches}
          className="ui-stack"
          role="list"
          aria-label="Branches"
          style={{ gap: 'var(--ui-space-2)' }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || loading || saving) return
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
            const index = buttons.indexOf(event.target as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            buttons[(index + direction + buttons.length) % buttons.length]?.focus()
          }}
        >
          {refs.map((ref) => (
            <ListRow
              key={`${ref.kind}:${ref.name}`}
              title={ref.name}
              description={<span className="ui-cluster"><span>{ref.kind}</span>{ref.name === base && <Badge tone="accent">Current</Badge>}</span>}
              selected={ref.name === base}
              disabled={saving || loading}
              onClick={() => void onSaveBase({ base: ref.name })}
            />
          ))}
          {loading && refs.length === 0 && readError === null && <NoticeLine>Loading branches…</NoticeLine>}
          {!loading && refs.length === 0 && readError === null && <EmptyState message="No matching branches" />}
        </div>
      </div>
    </Dialog>
  )
}
