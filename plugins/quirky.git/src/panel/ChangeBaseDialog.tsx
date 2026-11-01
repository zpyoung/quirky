import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Dialog, EmptyState, ListRow, TextField } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from './format'

type Ref = { name: string; kind: 'local' | 'remote' }

type Props = {
  context: UiPluginContext
  worktree: string
  /** The base in use, marked in the list. */
  current: string | null
  onClose(): void
  /** Runs after the base was written, so the panel can reload its compare. */
  onChanged(): Promise<void>
}

const stripRemote = (ref: string): string => ref.replace(/^(?:refs\/)?remotes\//, '')

/** "Change Base Ref": pick the branch compare target, or clear it with Use Primary. */
export function ChangeBaseDialog({ context, worktree, current, onClose, onChanged }: Props) {
  const [query, setQuery] = useState('')
  const [refs, setRefs] = useState<Ref[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const branches = useRef<HTMLDivElement>(null)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const close = () => {
    alive.current = false
    onClose()
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    context
      .call('quirky.git/branches', query.trim() === '' ? { worktree } : { worktree, query: query.trim() })
      .then((result) => {
        if (cancelled) return
        setRefs((result as { refs: Ref[] }).refs)
        setError(null)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setRefs([])
        setError(messageOf(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [context, worktree, query])

  const save = async (params: { base: string } | { clear: true }) => {
    setSaving(true)
    try {
      await context.call('quirky.git/setBase', { worktree, ...params })
      await onChanged()
      if (!alive.current) return
      close()
    } catch (e) {
      if (!alive.current) return
      setError(messageOf(e))
      setSaving(false)
    }
  }

  const base = current === null ? null : stripRemote(current)
  return (
    <Dialog
      open
      title="Change Base Ref"
      onClose={close}
      actions={<Button onClick={close}>Close</Button>}
    >
      <div className="ui-stack">
        <p className="ui-text-muted">Pick the branch compare target for this repository.</p>
        <div className="ui-cluster">
          <span className="ui-text-muted">{base === null ? 'No base ref in use' : `Current: ${base}`}</span>
          <Button disabled={saving} onClick={() => void save({ clear: true })}>
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
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || loading || saving) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              branches.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
            } else if (event.key === 'Enter' && refs.length === 1) {
              event.preventDefault()
              void save({ base: refs[0]!.name })
            }
          }}
        />
        {error !== null && <p role="alert" style={{ color: 'var(--ui-failing)' }}>{error}</p>}
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
              onClick={() => void save({ base: ref.name })}
            />
          ))}
          {refs.length === 0 && error === null && <EmptyState message="No matching branches" />}
        </div>
      </div>
    </Dialog>
  )
}
