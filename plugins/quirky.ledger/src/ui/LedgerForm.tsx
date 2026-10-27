import { useMemo, useState, type FormEvent } from 'react'
import type { LedgerEntry, LedgerLocation, LedgerResponse, LedgerType } from './types'
import { errorMessage } from './api'

export type LocationBaseOption = { value: string; label: string; base: LedgerLocation['base'] }

type TextField = { key: string; label: string; multiline?: boolean; options?: readonly string[] }

const TYPE_FIELDS: Record<LedgerType, TextField[]> = {
  bug: [
    { key: 'file', label: 'File' },
    { key: 'description', label: 'Description', multiline: true },
    { key: 'severity', label: 'Severity', options: ['critical', 'high', 'medium', 'low'] }
  ],
  deferred: [
    { key: 'why_deferred', label: 'Why deferred', multiline: true },
    { key: 'priority', label: 'Priority', options: ['high', 'medium', 'low'] }
  ],
  'test-gap': [
    { key: 'file_under_test', label: 'File under test' },
    { key: 'reason_skipped', label: 'Reason skipped', multiline: true }
  ],
  proposal: [
    { key: 'context', label: 'Context', multiline: true },
    { key: 'recommendation', label: 'Recommendation', multiline: true }
  ],
  decision: [
    { key: 'context', label: 'Context', multiline: true },
    { key: 'decision', label: 'Decision', multiline: true },
    { key: 'consequences', label: 'Consequences', multiline: true },
    { key: 'status', label: 'Status', options: ['proposed', 'accepted', 'superseded'] }
  ]
}

const TYPE_NAMES: Record<LedgerType, string> = {
  bug: 'Bug',
  deferred: 'Deferred',
  'test-gap': 'Test gap',
  proposal: 'Proposal',
  decision: 'Decision'
}

function initialField(content: Record<string, unknown>, field: TextField): string {
  const value = content[field.key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function locationOf(content: Record<string, unknown>, key: string): LedgerLocation | null {
  const value = content[key]
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<LedgerLocation>
  return typeof candidate.path === 'string' && candidate.base && typeof candidate.base.id === 'string' && (candidate.base.kind === 'project' || candidate.base.kind === 'workspace')
    ? (candidate as LedgerLocation)
    : null
}

function baseKey(base: LedgerLocation['base']): string {
  return `${base.kind}:${base.id}`
}

function fieldLabel(field: TextField): string {
  if (field.key === 'file') return 'File'
  if (field.key === 'file_under_test') return 'File under test'
  return field.label
}


export function LedgerForm({
  entry,
  initialType,
  bases,
  onCancel,
  onSave
}: {
  entry?: LedgerEntry
  initialType?: LedgerType
  bases: LocationBaseOption[]
  onCancel(): void
  onSave(type: LedgerType, content: Record<string, unknown>): Promise<LedgerResponse>
}) {
  const [type, setType] = useState<LedgerType>(entry?.type ?? initialType ?? 'bug')
  const [content, setContent] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = { title: typeof entry?.content.title === 'string' ? entry.content.title : '' }
    for (const field of TYPE_FIELDS[entry?.type ?? initialType ?? 'bug']) {
      if (field.key === 'file' || field.key === 'file_under_test') continue
      values[field.key] = initialField(entry?.content ?? {}, field)
    }
    return values
  })
  const locationKey = type === 'test-gap' ? 'file_under_test' : 'file'
  const existingLocation = locationOf(entry?.content ?? {}, locationKey)
  const [path, setPath] = useState(existingLocation?.path ?? '')
  const [line, setLine] = useState(existingLocation?.line === undefined ? '' : String(existingLocation.line))
  const [selectedBase, setSelectedBase] = useState(() => existingLocation ? baseKey(existingLocation.base) : '')
  const [external, setExternal] = useState(existingLocation?.external === true)
  const [host, setHost] = useState(existingLocation?.host ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [createdMatches, setCreatedMatches] = useState<LedgerEntry[] | null>(null)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)

  const availableBases = useMemo(() => {
    if (!existingLocation) return bases
    const value = baseKey(existingLocation.base)
    if (bases.some((base) => base.value === value)) {
      return bases.map((base) => base.value === value ? { ...base, base: existingLocation.base } : base)
    }
    return [...bases, {
      value,
      label: `Historical ${existingLocation.base.kind}: ${existingLocation.base.id}`,
      base: existingLocation.base
    }]
  }, [bases, existingLocation])
  const selectedBaseOption = availableBases.find((base) => base.value === selectedBase)

  const setField = (key: string, value: string) => {
    setContent((previous) => ({ ...previous, [key]: value }))
    setErrors((previous) => ({ ...previous, [key]: '' }))
    setMessage('')
  }

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {}
    if (!content.title?.trim()) next.title = 'Title is required.'
    for (const field of TYPE_FIELDS[type]) {
      if (field.key === 'file' || field.key === 'file_under_test') {
        if (!path.trim()) next[locationKey] = `${field.label} is required.`
        if (!selectedBaseOption) next.base = 'Location base is required.'
        if (line.trim()) {
          const value = Number(line)
          if (!Number.isSafeInteger(value) || value <= 0) next.line = 'Line must be a positive whole number.'
        }
        if (external && !host.trim()) next.host = 'External host is required.'
      } else if (field.options) {
        if (!field.options.includes(content[field.key] ?? '')) next[field.key] = `${field.label} is required.`
      } else if (!content[field.key]?.trim()) {
        next[field.key] = `${field.label} is required.`
      }
    }
    return next
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const nextErrors = validate()
    setErrors(nextErrors)
    setMessage('')
    setConflictRevision(null)
    if (Object.keys(nextErrors).length > 0) return
    if (createdMatches) {
      onCancel()
      return
    }

    const nextContent: Record<string, unknown> = { ...(entry?.content ?? {}) }
    nextContent.title = content.title.trim()
    for (const field of TYPE_FIELDS[type]) {
      if (field.key === 'file' || field.key === 'file_under_test') continue
      nextContent[field.key] = field.options ? content[field.key] : content[field.key].trim()
    }
    if (TYPE_FIELDS[type].some((field) => field.key === 'file' || field.key === 'file_under_test')) {
      const base = selectedBaseOption!.base
      const location: LedgerLocation = {
        path: path.trim(),
        base,
        ...(line.trim() ? { line: Number(line) } : {}),
        ...(external ? { external: true, host: host.trim() } : {})
      }
      nextContent[locationKey] = location
    }

    setBusy(true)
    try {
      const result = await onSave(type, nextContent)
      const matches = result.matches ?? []
      if (!entry && matches.length > 0) {
        setCreatedMatches(matches)
        setMessage('Entry created. Review these possible duplicates before closing.')
      } else {
        onCancel()
      }
    } catch (error) {
      const data = typeof error === 'object' && error !== null && 'data' in error && typeof error.data === 'object' && error.data !== null ? (error.data as Record<string, unknown>) : {}
      const revision = data.currentRevision
      if (typeof revision === 'number' && Number.isSafeInteger(revision)) {
        setConflictRevision(revision)
        setMessage(`Entry changed while you were editing. Current revision is ${revision}; reload before saving.`)
      } else {
        setMessage(errorMessage(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const title = entry ? `Edit ${entry.id}` : 'New ledger entry'
  return (
    <div className="ledger-modal-backdrop" role="presentation">
      <section className="ledger-dialog ledger-form-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="ledger-dialog-header">
          <h2>{title}</h2>
          {entry && <p>Source revision: {entry.revision}. Save will be checked against this revision.</p>}
        </header>
        <form className="ledger-dialog-body ledger-form" noValidate onSubmit={(event) => void submit(event)}>
          {!entry && (
            <label>
              <span>Type</span>
              <select value={type} onChange={(event) => {
                const nextType = event.target.value as LedgerType
                setType(nextType)
                setContent((previous) => ({ title: previous.title ?? '' }))
                setPath('')
                setLine('')
                setSelectedBase('')
                setExternal(false)
                setHost('')
                setErrors({})
              }}>
                {(Object.keys(TYPE_NAMES) as LedgerType[]).map((value) => <option key={value} value={value}>{TYPE_NAMES[value]}</option>)}
              </select>
            </label>
          )}
          <label aria-invalid={Boolean(errors.title)}>
            <span>Title</span>
            <input value={content.title ?? ''} onChange={(event) => setField('title', event.target.value)} />
            {errors.title && <small role="alert">{errors.title}</small>}
          </label>
          {TYPE_FIELDS[type].map((field) => {
            const label = fieldLabel(field)
            if (field.key === 'file' || field.key === 'file_under_test') {
              return (
                <fieldset className="ledger-location-fields" key={field.key}>
                  <legend>{label}</legend>
                  <label aria-invalid={Boolean(errors[locationKey])}>
                    <span>{label}</span>
                    <input value={path} placeholder="Repository-relative path" onChange={(event) => setPath(event.target.value)} />
                    {errors[locationKey] && <small role="alert">{errors[locationKey]}</small>}
                  </label>
                  <label aria-invalid={Boolean(errors.line)}>
                    <span>Line (optional)</span>
                    <input type="number" min="1" step="1" value={line} onChange={(event) => setLine(event.target.value)} />
                    {errors.line && <small role="alert">{errors.line}</small>}
                  </label>
                  <label aria-invalid={Boolean(errors.base)}>
                    <span>Location base</span>
                    <select value={selectedBase} onChange={(event) => setSelectedBase(event.target.value)}>
                      <option value="">Choose a location base</option>
                      {availableBases.map((base) => <option key={base.value} value={base.value}>{base.label}</option>)}
                    </select>
                    {errors.base && <small role="alert">{errors.base}</small>}
                  </label>
                  <label className="ledger-check-row">
                    <input type="checkbox" checked={external} onChange={(event) => setExternal(event.target.checked)} />
                    <span>External location</span>
                  </label>
                  {external && <label aria-invalid={Boolean(errors.host)}>
                    <span>External host</span>
                    <input value={host} onChange={(event) => setHost(event.target.value)} />
                    {errors.host && <small role="alert">{errors.host}</small>}
                  </label>}
                </fieldset>
              )
            }
            return (
              <label key={field.key} aria-invalid={Boolean(errors[field.key])}>
                <span>{label}</span>
                {field.options ? (
                  <select value={content[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)}>
                    <option value="">Choose {label.toLowerCase()}</option>
                    {field.options.map((option) => <option value={option} key={option}>{option}</option>)}
                  </select>
                ) : field.multiline ? (
                  <textarea rows={3} value={content[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)} />
                ) : (
                  <input value={content[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)} />
                )}
                {errors[field.key] && <small role="alert">{errors[field.key]}</small>}
              </label>
            )
          })}
          {message && <p role="alert" className={conflictRevision === null ? 'ledger-form-message' : 'ledger-form-conflict'}>{message}</p>}
          {createdMatches && <section aria-label="Possible duplicate entries">
            <h3>Possible duplicate entries</h3>
            <p>These similar records are advisory only; creating a duplicate is allowed.</p>
            <ul>{createdMatches.map((match) => <li key={match.id}>{match.id} · {String(match.content.title ?? '')}</li>)}</ul>
          </section>}
        </form>
        <footer className="ledger-dialog-actions">
          <button type="button" onClick={onCancel}>{createdMatches ? 'Done' : 'Cancel'}</button>
          {!createdMatches && <button type="button" className="primary" disabled={busy} onClick={(event) => {
            const form = event.currentTarget.closest('.ledger-dialog')?.querySelector('form')
            form?.requestSubmit()
          }}>{entry ? 'Save changes' : 'Create entry'}</button>}
        </footer>
      </section>
    </div>
  )
}
