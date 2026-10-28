export const MAX_ROADMAP_TICKS = 480
export type RoadmapZoom = 'month' | 'quarter' | 'year'

const MIN_MARK_WIDTH = 8
const DAY_MS = 86_400_000
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type RoadmapField = { id: string; name: string; dataType: 'DATE' | 'ITERATION'; options: unknown[] }
type DateInterval = { from: Date; to: Date }
type FieldChoice = { placement: RoadmapField; target: RoadmapField | null; marker: boolean }

export type RoadmapTick = {
  index: number
  label: string
  startDate: Date
  endDate: Date
}

export type RoadmapItemPlacement = {
  itemId: string
  title: string
  content: unknown
  left: number
  width: number
  marker: boolean
  from: Date
  to: Date
}

export type RoadmapTimeline = {
  placementFieldName: string | null
  targetFieldName: string | null
  ticks: RoadmapTick[]
  todayIndex: number | null
  placements: RoadmapItemPlacement[]
  undatedCount: number
  tickWidth: number
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function normalizeField(value: unknown): RoadmapField | null {
  const field = record(value)
  if (!field || typeof field.id !== 'string' || field.id.trim().length === 0 || typeof field.name !== 'string') return null
  const dataType = typeof field.dataType === 'string' ? field.dataType.trim().toUpperCase() : ''
  if (dataType !== 'DATE' && dataType !== 'ITERATION') return null
  return {
    id: field.id,
    name: field.name,
    dataType,
    options: Array.isArray(field.options) ? field.options : []
  }
}

function chooseField(fields: unknown[]): FieldChoice | null {
  const usable = fields.flatMap((value) => {
    const field = normalizeField(value)
    return field === null ? [] : [field]
  })
  const dates = usable.filter((field) => field.dataType === 'DATE')
  const start = dates.find((field) => /start|kick.?off|begin/i.test(field.name))
  const target = dates.find((field) => /target|end|due|finish|complet|deadline|ship/i.test(field.name) && field.id !== start?.id)
  if (start && target) return { placement: start, target, marker: false }
  if (dates.length >= 2) return { placement: dates[0], target: dates[1], marker: false }
  const iteration = usable.find((field) => field.dataType === 'ITERATION')
  if (iteration) return { placement: iteration, target: null, marker: false }
  if (dates.length === 1) return { placement: dates[0], target: null, marker: true }
  return null
}

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || year > 9999) return null
  const date = utcDate(year, month, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? date : null
}

function normalizedToday(value: Date | undefined): Date | null {
  const date = value === undefined ? new Date() : value
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null
  const year = date.getUTCFullYear()
  if (year < 1 || year > 9999) return null
  return utcDate(year, date.getUTCMonth() + 1, date.getUTCDate())
}

function intervalFromRecord(value: unknown): DateInterval | null {
  const raw = record(value)
  if (!raw) return null
  const from = parseDate(raw.startDate)
  if (!from) return null
  const explicitTo = parseDate(raw.endDate)
  if (explicitTo && explicitTo.getTime() >= from.getTime()) return { from, to: explicitTo }

  const duration = raw.duration
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0) return null
  const durationDays = duration * 7
  if (!Number.isSafeInteger(durationDays)) return null
  const to = new Date(from.getTime() + durationDays * DAY_MS - DAY_MS)
  const year = to.getUTCFullYear()
  if (!Number.isFinite(to.getTime()) || year < 1 || year > 9999) return null
  return { from, to }
}

function iterationKeys(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  const raw = record(value)
  if (!raw) return []
  const keys: string[] = []
  for (const key of ['id', 'iterationId', 'optionId', 'name', 'title']) {
    if (typeof raw[key] === 'string') keys.push(raw[key] as string)
  }
  return keys
}

function iterationInterval(value: unknown, field: RoadmapField): DateInterval | null {
  const direct = intervalFromRecord(value)
  if (direct) return direct
  const keys = iterationKeys(value)
  if (keys.length === 0) return null
  for (const candidate of field.options) {
    const option = record(candidate)
    if (!option) continue
    const matches = keys.some((key) => key === option.id || key === option.name || key === option.title)
    if (!matches) continue
    const interval = intervalFromRecord(option)
    if (interval) return interval
  }
  return null
}

function fieldValue(item: Record<string, unknown>, fieldId: string): unknown {
  if (!Array.isArray(item.fieldValues)) return undefined
  for (const candidate of item.fieldValues) {
    const value = record(candidate)
    if (value?.fieldId === fieldId) return value.value
  }
  return undefined
}

function dateInterval(item: Record<string, unknown>, choice: FieldChoice): DateInterval | null {
  const value = fieldValue(item, choice.placement.id)
  if (choice.placement.dataType === 'ITERATION') return iterationInterval(value, choice.placement)
  const from = parseDate(value)
  if (!from) return null
  if (!choice.target) return { from, to: from }
  const to = parseDate(fieldValue(item, choice.target.id))
  return to && to.getTime() >= from.getTime() ? { from, to } : null
}

function ordinal(date: Date, zoom: RoadmapZoom): number {
  const year = date.getUTCFullYear()
  if (zoom === 'year') return year
  if (zoom === 'quarter') return year * 4 + Math.floor(date.getUTCMonth() / 3)
  return year * 12 + date.getUTCMonth()
}

function ordinalBounds(zoom: RoadmapZoom): [number, number] {
  if (zoom === 'year') return [1, 9999]
  if (zoom === 'quarter') return [4, 39_999]
  return [12, 119_999]
}

function dateAtOrdinal(value: number, zoom: RoadmapZoom): Date {
  if (zoom === 'year') return utcDate(value, 1, 1)
  if (zoom === 'quarter') {
    const year = Math.floor(value / 4)
    const quarter = value - year * 4
    return utcDate(year, quarter * 3 + 1, 1)
  }
  const year = Math.floor(value / 12)
  const month = value - year * 12 + 1
  return utcDate(year, month, 1)
}

function tickLabel(start: Date, zoom: RoadmapZoom): string {
  const year = String(start.getUTCFullYear()).padStart(4, '0')
  if (zoom === 'year') return year
  if (zoom === 'quarter') return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${year}`
  return `${MONTH_LABELS[start.getUTCMonth()]} ${year}`
}

function visibleWindow(minimum: number, maximum: number, today: number | null, zoom: RoadmapZoom): [number, number] {
  if (minimum > maximum) {
    if (today === null) return [0, -1]
    minimum = today
    maximum = today
  }
  const span = maximum - minimum + 1
  if (span <= MAX_ROADMAP_TICKS) return [minimum, maximum]
  const [domainMinimum, domainMaximum] = ordinalBounds(zoom)
  const focus = today ?? Math.floor((minimum + maximum) / 2)
  const first = Math.min(
    domainMaximum - MAX_ROADMAP_TICKS + 1,
    Math.max(domainMinimum, focus - Math.floor((MAX_ROADMAP_TICKS - 1) / 2))
  )
  return [first, first + MAX_ROADMAP_TICKS - 1]
}

function makeTicks(first: number, last: number, zoom: RoadmapZoom): RoadmapTick[] {
  const count = Math.min(MAX_ROADMAP_TICKS, Math.max(0, last - first + 1))
  const ticks: RoadmapTick[] = []
  for (let index = 0; index < count; index += 1) {
    const startDate = dateAtOrdinal(first + index, zoom)
    const nextStart = dateAtOrdinal(first + index + 1, zoom)
    ticks.push({ index, label: tickLabel(startDate, zoom), startDate, endDate: new Date(nextStart.getTime() - DAY_MS) })
  }
  return ticks
}

function coordinate(date: Date, firstOrdinal: number, ticks: RoadmapTick[], tickWidth: number, zoom: RoadmapZoom): number {
  const index = ordinal(date, zoom) - firstOrdinal
  if (index < 0) return index * tickWidth
  if (index >= ticks.length) return ticks.length * tickWidth + (index - ticks.length) * tickWidth
  const tick = ticks[index]
  const start = tick.startDate.getTime()
  const end = tick.endDate.getTime() + DAY_MS
  const fraction = (date.getTime() - start) / (end - start)
  return (index + fraction) * tickWidth
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

function itemTitle(item: Record<string, unknown>): string {
  const contentTitle = record(item.content)?.title
  if (typeof contentTitle === 'string' && contentTitle.trim().length > 0) return contentTitle
  if (typeof item.title === 'string' && item.title.trim().length > 0) return item.title
  return 'Untitled item'
}

export function buildRoadmapTimeline(
  fields: unknown[],
  items: unknown[],
  zoom: RoadmapZoom,
  today?: Date
): RoadmapTimeline {
  const tickZoom: RoadmapZoom = zoom === 'quarter' || zoom === 'year' ? zoom : 'month'
  const tickWidth = tickZoom === 'month' ? 148 : tickZoom === 'quarter' ? 128 : 160
  const choice = chooseField(Array.isArray(fields) ? fields : [])
  if (!choice) {
    const undatedCount = (Array.isArray(items) ? items : []).reduce((count, value) => {
      const item = record(value)
      return item && typeof item.id === 'string' && item.id.trim().length > 0 ? count + 1 : count
    }, 0)
    return {
      placementFieldName: null,
      targetFieldName: null,
      ticks: [],
      todayIndex: null,
      placements: [],
      undatedCount,
      tickWidth
    }
  }

  const placements: RoadmapItemPlacement[] = []
  let undatedCount = 0
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (const value of Array.isArray(items) ? items : []) {
    const item = record(value)
    if (!item || typeof item.id !== 'string' || item.id.trim().length === 0) continue
    const interval = dateInterval(item, choice)
    if (!interval) {
      undatedCount += 1
      continue
    }
    placements.push({
      itemId: item.id,
      title: itemTitle(item),
      content: item.content,
      left: 0,
      width: 0,
      marker: choice.marker,
      from: interval.from,
      to: interval.to
    })
    minimum = Math.min(minimum, ordinal(interval.from, tickZoom), ordinal(interval.to, tickZoom))
    maximum = Math.max(maximum, ordinal(interval.from, tickZoom), ordinal(interval.to, tickZoom))
  }

  const todayDate = normalizedToday(today)
  const todayOrdinal = todayDate ? ordinal(todayDate, tickZoom) : null
  if (todayOrdinal !== null) {
    minimum = Math.min(minimum, todayOrdinal)
    maximum = Math.max(maximum, todayOrdinal)
  }
  const [first, last] = visibleWindow(minimum, maximum, todayOrdinal, tickZoom)
  const ticks = makeTicks(first, last, tickZoom)
  const todayIndex = todayOrdinal !== null && todayOrdinal >= first && todayOrdinal <= last ? todayOrdinal - first : null
  const totalWidth = ticks.length * tickWidth

  for (const placement of placements) {
    const start = coordinate(placement.from, first, ticks, tickWidth, tickZoom)
    if (placement.marker) {
      placement.width = MIN_MARK_WIDTH
      placement.left = clamp(start - MIN_MARK_WIDTH / 2, 0, totalWidth - MIN_MARK_WIDTH)
      continue
    }
    const endDate = new Date(placement.to.getTime() + DAY_MS)
    const end = coordinate(endDate, first, ticks, tickWidth, tickZoom)
    const left = clamp(start, 0, totalWidth)
    const right = clamp(end, 0, totalWidth)
    if (right <= left) {
      placement.width = MIN_MARK_WIDTH
      placement.left = end <= 0 ? 0 : totalWidth - MIN_MARK_WIDTH
    } else {
      placement.left = left
      placement.width = right - left
    }
  }

  return {
    placementFieldName: choice.placement.name,
    targetFieldName: choice.target?.name ?? null,
    ticks,
    todayIndex,
    placements,
    undatedCount,
    tickWidth
  }
}
