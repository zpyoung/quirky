import { useId, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button, Dialog, FormRow, SectionHeader, TextField } from '@quirky/ui'
import type { LedgerEntry, LedgerLocation, LedgerResponse, LedgerType } from './types'
import { errorMessage } from './api'
import { ledgerStyles } from './styles'

export type LocationBaseOption = { value: string; label: string; base: LedgerLocation['base'] }

type FieldDefinition = { key: string; label: string; multiline?: boolean; options?: readonly string[] }

const TYPE_FIELDS: Record<LedgerType, FieldDefinition[]> = {
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

function initialField(content: Record<string, unknown>, field: FieldDefinition): string {
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

function fieldLabel(field: FieldDefinition): string {
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
  const formId = useId()
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
  return createPortal(
    <Dialog
      open
      scrollBody
      title={title}
      closeOnBackdrop={false}
      onClose={onCancel}
      actions={
        <div style={ledgerStyles.actions}>
          <Button onClick={onCancel}>{createdMatches ? 'Done' : 'Cancel'}</Button>
          {!createdMatches && (
            <Button type="submit" form={formId} variant="primary" disabled={busy}>
              {entry ? 'Save changes' : 'Create entry'}
            </Button>
          )}
        </div>
      }
    >
      <form id={formId} noValidate onSubmit={(event) => void submit(event)} style={ledgerStyles.stack}>
        {!entry && (
          <FormRow label="Type" htmlFor={`${formId}-type`}>
            <select id={`${formId}-type`} className="ui-text-field__input" value={type} onChange={(event) => {
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
          </FormRow>
        )}
        <TextField label="Title" value={content.title ?? ''} onChange={(event) => setField('title', event.target.value)} error={errors.title || undefined} />
        {TYPE_FIELDS[type].map((field) => {
          const label = fieldLabel(field)
          const id = `${formId}-${field.key}`
          if (field.key === 'file' || field.key === 'file_under_test') {
            return (
              <fieldset style={ledgerStyles.location} key={field.key}>
                <legend>{label}</legend>
                <TextField label={label} value={path} placeholder="Repository-relative path" onChange={(event) => setPath(event.target.value)} error={errors[locationKey] || undefined} />
                <TextField label="Line (optional)" type="number" min="1" step="1" value={line} onChange={(event) => setLine(event.target.value)} error={errors.line || undefined} />
                <FormRow label="Location base" htmlFor={`${id}-base`} error={errors.base || undefined}>
                  <select id={`${id}-base`} className="ui-text-field__input" value={selectedBase} onChange={(event) => setSelectedBase(event.target.value)}>
                    <option value="">Choose a location base</option>
                    {availableBases.map((base) => <option key={base.value} value={base.value}>{base.label}</option>)}
                  </select>
                </FormRow>
                <label style={ledgerStyles.check}>
                  <input type="checkbox" style={ledgerStyles.checkbox} checked={external} onChange={(event) => setExternal(event.target.checked)} />
                  <span>External location</span>
                </label>
                {external && <TextField label="External host" value={host} onChange={(event) => setHost(event.target.value)} error={errors.host || undefined} />}
              </fieldset>
            )
          }
          if (field.options) {
            return (
              <FormRow key={field.key} label={label} htmlFor={id} error={errors[field.key] || undefined}>
                <select id={id} className="ui-text-field__input" value={content[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)}>
                  <option value="">Choose {label.toLowerCase()}</option>
                  {field.options.map((option) => <option value={option} key={option}>{option}</option>)}
                </select>
              </FormRow>
            )
          }
          if (field.multiline) {
            return (
              <FormRow key={field.key} label={label} htmlFor={id} error={errors[field.key] || undefined}>
                <textarea id={id} className="ui-text-field__input" rows={3} value={content[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)} />
              </FormRow>
            )
          }
          return <TextField key={field.key} label={label} value={content[field.key] ?? ''} onChange={(event) => setField(field.key, event.target.value)} error={errors[field.key] || undefined} />
        })}
        {message && <p role="alert" style={conflictRevision === null ? ledgerStyles.message : ledgerStyles.error}>{message}</p>}
        {createdMatches && (
          <section aria-label="Possible duplicate entries" style={ledgerStyles.section}>
            <SectionHeader title="Possible duplicate entries" />
            <p>These similar records are advisory only; creating a duplicate is allowed.</p>
            <ul style={ledgerStyles.list}>{createdMatches.map((match) => <li key={match.id} style={ledgerStyles.row}>{match.id} · {String(match.content.title ?? '')}</li>)}</ul>
          </section>
        )}
      </form>
    </Dialog>,
    document.body
  )
}
