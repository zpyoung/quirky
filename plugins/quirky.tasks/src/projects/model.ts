import type { ProjectTarget } from '../contracts'

export type ProjectRecord = Record<string, unknown>
export type ProjectItem = {
  id: string
  type?: string
  content?: ProjectRecord | null
  fieldValues?: ProjectRecord[]
  [key: string]: unknown
}
export type ProjectFieldOption = ProjectRecord & { id: string; name?: string }
export type ProjectField = ProjectRecord & { id: string; name?: string; dataType?: string; options?: ProjectFieldOption[] }
export type ProjectView = ProjectRecord & {
  id: string
  name?: string
  layout?: string
  filter?: string
  fields?: ProjectField[]
  groupByFields?: ProjectField[]
  verticalGroupByFields?: ProjectField[]
  sortByFields?: ProjectRecord[]
}

export function projectIdentity(project: ProjectTarget): string {
  const host = (project.host ?? hostFromUrl(project.url) ?? '').toLowerCase()
  return JSON.stringify([host, project.ownerType, project.owner.trim().toLowerCase(), project.number])
}

export function projectViewIdentity(project: ProjectTarget, viewId: string): string {
  return JSON.stringify([projectIdentity(project), viewId])
}

export function hostFromUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.host : null
  } catch {
    return null
  }
}

export function normalizeProjectTarget(value: unknown): ProjectTarget | null {
  const raw = record(value)
  const id = nonEmpty(raw?.id)
  const owner = nonEmpty(raw?.owner)
  const ownerType = raw?.ownerType === 'organization' || raw?.ownerType === 'user' ? raw.ownerType : null
  const number = Number(raw?.number)
  const url = nonEmpty(raw?.url)
  if (id === null || owner === null || ownerType === null || !Number.isSafeInteger(number) || number < 1 || url === null || hostFromUrl(url) === null) return null
  const host = nonEmpty(raw?.host) ?? hostFromUrl(url) ?? undefined
  const title = typeof raw?.title === 'string' ? raw.title : undefined
  const viewId = nonEmpty(raw?.viewId) ?? undefined
  const viewNumberValue = Number(raw?.viewNumber)
  const viewNumber = Number.isSafeInteger(viewNumberValue) && viewNumberValue > 0 ? viewNumberValue : undefined
  return { id, owner, ownerType, number, url, ...(host === undefined ? {} : { host }), ...(title === undefined ? {} : { title }), ...(viewId === undefined ? {} : { viewId }), ...(viewNumber === undefined ? {} : { viewNumber }) }
}

export function record(value: unknown): ProjectRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ProjectRecord : null
}

export function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function asItems(value: unknown): ProjectItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const raw = record(candidate)
    const id = nonEmpty(raw?.id)
    if (raw === null || id === null) return []
    return [{ ...raw, id, content: record(raw.content), fieldValues: Array.isArray(raw.fieldValues) ? raw.fieldValues.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [] } as ProjectItem]
  })
}

export function asViews(value: unknown): ProjectView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const raw = record(candidate)
    const id = nonEmpty(raw?.id)
    if (raw === null || id === null) return []
    return [{
      ...raw,
      id,
      fields: Array.isArray(raw.fields) ? raw.fields.flatMap((field) => normalizeField(field) ?? []) : [],
      groupByFields: Array.isArray(raw.groupByFields) ? raw.groupByFields.flatMap((field) => normalizeField(field) ?? []) : [],
      verticalGroupByFields: Array.isArray(raw.verticalGroupByFields) ? raw.verticalGroupByFields.flatMap((field) => normalizeField(field) ?? []) : [],
      sortByFields: Array.isArray(raw.sortByFields) ? raw.sortByFields.flatMap((field) => record(field) ? [record(field)!] : []) : []
    } as ProjectView]
  })
}

export function normalizeField(value: unknown): ProjectField | null {
  const raw = record(value)
  const id = nonEmpty(raw?.id)
  if (raw === null || id === null) return null
  const optionsRaw = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.multiSelectOptions) ? raw.multiSelectOptions : []
  const options = optionsRaw.flatMap((entry) => {
    const option = record(entry)
    const optionId = nonEmpty(option?.id)
    if (option === null || optionId === null) return []
    return [{ ...option, id: optionId, name: typeof option.name === 'string' ? option.name : optionId }]
  })
  return { ...raw, id, name: typeof raw.name === 'string' ? raw.name : id, dataType: typeof raw.dataType === 'string' ? raw.dataType.toUpperCase() : '', options }
}

export function fieldValue(item: ProjectItem, fieldId: string): unknown {
  const value = item.fieldValues?.find((entry) => entry.fieldId === fieldId)
  return value?.value ?? null
}

export function fieldDisplayValue(item: ProjectItem, field: ProjectField): string {
  const value = fieldValue(item, field.id)
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') {
    const option = field.options?.find((candidate) => candidate.id === value || candidate.name === value)
    return typeof option?.name === 'string' ? option.name : value
  }
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map((entry) => {
    const row = record(entry)
    return typeof row?.name === 'string' ? row.name : typeof row?.login === 'string' ? row.login : String(entry)
  }).join(', ')
  const row = record(value)
  if (row) {
    if (typeof row.name === 'string') return row.name
    if (typeof row.title === 'string') return row.title
    if (typeof row.text === 'string') return row.text
    if (typeof row.date === 'string') return row.date
    if (typeof row.number === 'number') return String(row.number)
    if (typeof row.login === 'string') return row.login
    const selectedId = nonEmpty(row.singleSelectOptionId) ?? nonEmpty(row.iterationId) ?? nonEmpty(row.optionId)
    if (selectedId) return String(field.options?.find((option) => option.id === selectedId)?.name ?? selectedId)
    if (Array.isArray(row.multiSelectOptionIds)) return row.multiSelectOptionIds.map((id) => String(field.options?.find((option) => option.id === id)?.name ?? id)).join(', ')
  }
  return String(value)
}

export function fieldDataType(field: ProjectField): string {
  const value = typeof field.dataType === 'string' ? field.dataType.toUpperCase() : ''
  if (value !== '') return value
  const kind = typeof field.__typename === 'string' ? field.__typename : ''
  if (kind.includes('SingleSelect')) return 'SINGLE_SELECT'
  if (kind.includes('Iteration')) return 'ITERATION'
  if (kind.includes('Date')) return 'DATE'
  if (kind.includes('Number')) return 'NUMBER'
  if (kind.includes('Text')) return 'TEXT'
  if (kind.includes('Label')) return 'LABELS'
  if (kind.includes('User')) return 'USERS'
  return ''
}

export function isRestricted(item: ProjectItem): boolean {
  return item.content === null || item.content === undefined || item.type === 'REDACTED' || item.content.kind === 'unknown'
}

export function isDraft(item: ProjectItem): boolean {
  return item.type === 'DRAFT_ISSUE' || item.content?.kind === 'draft'
}

export function isIssue(item: ProjectItem): boolean {
  return item.content?.kind === 'issue'
}

export function boardGroupField(view: ProjectView, fields: ProjectField[]): ProjectField | null {
  const vertical = view.verticalGroupByFields?.[0]
  if (vertical && ['SINGLE_SELECT', 'ITERATION'].includes(fieldDataType(vertical))) return vertical
  const status = fields.find((field) => field.name?.toLowerCase() === 'status' && ['SINGLE_SELECT', 'ITERATION'].includes(fieldDataType(field)))
  if (status) return status
  return fields.find((field) => fieldDataType(field) === 'SINGLE_SELECT') ?? null
}

export type ProjectBoardColumn = { id: string; label: string; value: string | null; readOnly: boolean; items: ProjectItem[] }

export function boardColumns(items: ProjectItem[], field: ProjectField): ProjectBoardColumn[] {
  const options = field.options ?? []
  const columns: ProjectBoardColumn[] = options.map((option) => ({
    id: option.id,
    label: String(option.name ?? option.id),
    value: option.id,
    readOnly: false,
    items: []
  }))
  const known = new Set(options.map((option) => option.id))
  const deleted = new Map<string, ProjectBoardColumn>()
  const noField: ProjectBoardColumn = { id: '__no_field__', label: `No ${field.name ?? 'field'}`, value: null, readOnly: false, items: [] }
  for (const item of items) {
    const current = fieldValue(item, field.id)
    const currentId = typeof current === 'string' ? current : nonEmpty(record(current)?.singleSelectOptionId) ?? nonEmpty(record(current)?.id) ?? nonEmpty(record(current)?.iterationId) ?? nonEmpty(record(current)?.optionId)
    const currentName = typeof current === 'string' ? current : nonEmpty(record(current)?.name) ?? nonEmpty(record(current)?.title)
    if (currentId === null && currentName === null) {
      noField.items.push(item)
      continue
    }
    const existing = columns.find((column) => column.value === currentId || column.label === currentName)
    if (existing) {
      existing.items.push(item)
      continue
    }
    const key = currentId ?? currentName ?? 'unknown'
    let column = deleted.get(key)
    if (!column) {
      column = { id: `deleted:${key}`, label: `Deleted: ${currentName ?? currentId ?? 'option'}`, value: currentId, readOnly: true, items: [] }
      deleted.set(key, column)
    }
    if (currentId !== null && known.has(currentId)) column = columns.find((candidate) => candidate.value === currentId) ?? column
    column.items.push(item)
  }
  return [...columns, ...deleted.values(), noField]
}

export type ProjectGroup = { key: string; label: string; value: unknown; items: ProjectItem[]; current?: boolean; range?: string }

export function groupProjectItems(items: ProjectItem[], field: ProjectField | null): ProjectGroup[] {
  if (field === null) return [{ key: '__all__', label: 'Items', value: null, items }]
  const options = field.options ?? []
  const byValue = new Map<string, ProjectGroup>()
  const order: string[] = []
  const optionOrder = new Map(options.map((option, index) => [option.id, index]))
  for (const item of items) {
    const rawValue = fieldValue(item, field.id)
    const rawValues = Array.isArray(rawValue) ? rawValue : rawValue === null || rawValue === undefined || rawValue === '' ? [] : [rawValue]
    const values = [...new Set(rawValues.flatMap((candidate) => {
      if (typeof candidate === 'string' || typeof candidate === 'number') return [String(candidate)]
      const value = record(candidate)
      const key = nonEmpty(value?.singleSelectOptionId) ?? nonEmpty(value?.id) ?? nonEmpty(value?.iterationId) ?? nonEmpty(value?.optionId) ?? nonEmpty(value?.name) ?? nonEmpty(value?.title) ?? (typeof value?.number === 'number' ? String(value.number) : null)
      return key === null ? [] : [key]
    }))]
    for (const value of values.length === 0 ? [null] : values) {
      const key = value === null ? '__no_value__' : value
      let group = byValue.get(key)
      if (!group) {
        const option = options.find((candidate) => candidate.id === value || candidate.name === value)
        group = { key, label: value === null ? `No ${field.name ?? 'field'}` : String(option?.name ?? value), value: rawValue, items: [] }
        byValue.set(key, group)
        order.push(key)
      }
      group.items.push(item)
    }
  }
  return order.map((key) => byValue.get(key)!).sort((left, right) => {
    if (left.key === '__no_value__') return right.key === '__no_value__' ? 0 : 1
    if (right.key === '__no_value__') return -1
    const a = optionOrder.get(left.key)
    const b = optionOrder.get(right.key)
    if (a !== undefined && b !== undefined) return a - b
    if (a !== undefined) return -1
    if (b !== undefined) return 1
    return 0
  }).map((group) => iterationGroupMetadata(group, field))
}

function iterationGroupMetadata(group: ProjectGroup, field: ProjectField): ProjectGroup {
  if (fieldDataType(field) !== 'ITERATION') return group
  const value = fieldValue(group.items[0]!, field.id)
  const option = field.options?.find((candidate) => candidate.id === group.key || candidate.iterationId === group.key || candidate.name === group.label || candidate.title === group.label)
  const optionRecord = record(option)
  const valueRecord = record(value)
  const start = dateText(optionRecord?.startDate) ?? dateText(valueRecord?.startDate)
  const end = dateText(optionRecord?.endDate) ?? dateText(valueRecord?.endDate) ?? iterationEndDate(start, optionRecord?.duration ?? valueRecord?.duration)
  const now = new Date().toISOString().slice(0, 10)
  const current = start !== null && end !== null && start <= now && end >= now
  return { ...group, ...(start && end ? { range: `${start} – ${end}` } : {}), ...(current ? { current: true } : {}) }
}

function iterationEndDate(start: string | null, duration: unknown): string | null {
  if (!start || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 365_000) return null
  const date = new Date(`${start}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  date.setUTCDate(date.getUTCDate() + Math.ceil(duration) - 1)
  return date.toISOString().slice(0, 10)
}

function dateText(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return value
}
