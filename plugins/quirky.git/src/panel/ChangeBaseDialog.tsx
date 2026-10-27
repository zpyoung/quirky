import { useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Dialog } from './Dialog'
import { messageOf } from './format'

type Ref = { name: string; kind: 'local' | 'remote' }

type Props = {
  context: UiPluginContext
  worktree: string
  /** The base in use, marked in the list. */
  current: string | null
  onClose(): void
  /** Runs after the base was written, so the panel can reload its compare. */
  onChanged(): void
}

const stripRemote = (ref: string): string => ref.replace(/^(?:refs\/)?remotes\//, '')

/** "Change Base Ref": pick the branch compare target, or clear it with Use Primary. */
export function ChangeBaseDialog({ context, worktree, current, onClose, onChanged }: Props) {
  const [query, setQuery] = useState('')
  const [refs, setRefs] = useState<Ref[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    context
      .call('quirky.git/branches', query.trim() === '' ? { worktree } : { worktree, query: query.trim() })
      .then((result) => {
        if (cancelled) return
        setRefs((result as { refs: Ref[] }).refs)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(messageOf(e))
      })
    return () => {
      cancelled = true
    }
  }, [context, worktree, query])

  const save = async (params: { base: string } | { clear: true }) => {
    setSaving(true)
    try {
      await context.call('quirky.git/setBase', { worktree, ...params })
      onChanged()
      onClose()
    } catch (e) {
      setError(messageOf(e))
      setSaving(false)
    }
  }

  const base = current === null ? null : stripRemote(current)
  return (
    <Dialog title="Change Base Ref" onClose={onClose} wide>
      <p className="muted">Pick the branch compare target for this repository.</p>
      <div className="scm-base-current">
        <span className="muted">{base === null ? 'No base ref in use' : `Current: ${base}`}</span>
        <button type="button" disabled={saving} onClick={() => void save({ clear: true })}>
          Use Primary
        </button>
      </div>
      <input type="text" autoFocus aria-label="Search branches" placeholder="Search branches…" value={query} onChange={(event) => setQuery(event.target.value)} />
      {error !== null && <p className="form-error">{error}</p>}
      <ul className="scm-ref-list" role="listbox" aria-label="Branches">
        {refs.map((ref) => (
          <li key={`${ref.kind}:${ref.name}`} role="option" aria-selected={ref.name === base}>
            <button type="button" disabled={saving} data-current={ref.name === base ? '' : undefined} onClick={() => void save({ base: ref.name })}>
              <span>{ref.name}</span>
              <span className="muted">{ref.kind}</span>
            </button>
          </li>
        ))}
        {refs.length === 0 && error === null && <li className="muted scm-pad">No matching branches</li>}
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
