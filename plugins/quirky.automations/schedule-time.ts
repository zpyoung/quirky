export type CalendarDate = { year: number; month: number; day: number }
export type CalendarSchedule = {
  minutes: readonly number[]
  hours: readonly number[]
  matchesDate: (date: CalendarDate, weekday: number) => boolean
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const SEARCH_DAYS = 9 * 366
const MAX_ABSOLUTE_ZONE_OFFSET_MS = 48 * HOUR_MS
const OFFSET_SAMPLE_HOURS = 3
const OFFSET_SAMPLE_LIMIT_HOURS = 36

type ZonedParts = CalendarDate & { hour: number; minute: number; second: number }
type ZonedEngine = { formatter: Intl.DateTimeFormat; dayAt: (epoch: number) => number }

function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    makeFormatter(timezone)
    return true
  } catch {
    return false
  }
}

export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function zonedParts(epoch: number, formatter: Intl.DateTimeFormat): ZonedParts {
  let year = 0
  let month = 0
  let day = 0
  let hour = 0
  let minute = 0
  let second = 0
  for (const part of formatter.formatToParts(new Date(epoch))) {
    switch (part.type) {
      case 'year': year = Number(part.value); break
      case 'month': month = Number(part.value); break
      case 'day': day = Number(part.value); break
      case 'hour': hour = Number(part.value); break
      case 'minute': minute = Number(part.value); break
      case 'second': second = Number(part.value); break
    }
  }
  return { year, month, day, hour, minute, second }
}

function utcEpoch(date: CalendarDate, hour = 0, minute = 0, second = 0): number {
  const value = new Date(0)
  value.setUTCFullYear(date.year, date.month - 1, date.day)
  value.setUTCHours(hour, minute, second, 0)
  return value.getTime()
}

function dayNumber(date: CalendarDate): number {
  return Math.floor(utcEpoch(date) / DAY_MS)
}

function dateFromDayNumber(day: number): CalendarDate {
  const value = new Date(day * DAY_MS)
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

function createEngine(timezone: string): ZonedEngine {
  const formatter = makeFormatter(timezone)
  return {
    formatter,
    dayAt(epoch) {
      return dayNumber(zonedParts(epoch, formatter))
    },
  }
}

function offsetAt(epoch: number, formatter: Intl.DateTimeFormat): number {
  const roundedEpoch = Math.floor(epoch / 1000) * 1000
  const local = zonedParts(roundedEpoch, formatter)
  return utcEpoch(local, local.hour, local.minute, local.second) - roundedEpoch
}

function offsetsAroundDay(day: number, formatter: Intl.DateTimeFormat): number[] {
  const wallStart = day * DAY_MS
  const offsets = new Set<number>()
  for (let hours = -OFFSET_SAMPLE_LIMIT_HOURS; hours <= OFFSET_SAMPLE_LIMIT_HOURS; hours += OFFSET_SAMPLE_HOURS) {
    offsets.add(offsetAt(wallStart + hours * HOUR_MS, formatter))
  }
  return [...offsets]
}

function sameWallMinute(actual: ZonedParts, date: CalendarDate, hour: number, minute: number): boolean {
  return actual.year === date.year && actual.month === date.month && actual.day === date.day &&
    actual.hour === hour && actual.minute === minute && actual.second === 0
}

function instantsForWallMinute(
  date: CalendarDate,
  hour: number,
  minute: number,
  offsets: readonly number[],
  formatter: Intl.DateTimeFormat,
): number[] {
  const wallEpoch = utcEpoch(date, hour, minute)
  if (offsets.length === 1) return [wallEpoch - offsets[0]]

  const instants: number[] = []
  for (const offset of offsets) {
    const instant = wallEpoch - offset
    if (sameWallMinute(zonedParts(instant, formatter), date, hour, minute)) instants.push(instant)
  }
  return [...new Set(instants)].sort((a, b) => a - b)
}

function assertFiniteTime(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite timestamp.`)
}

function firstOccurrence(
  schedule: CalendarSchedule,
  dtstart: number,
  after: number,
  timezone: string,
): number {
  assertFiniteTime(dtstart, 'dtstart')
  assertFiniteTime(after, 'after')
  const engine = createEngine(timezone)
  const floor = Math.max(dtstart, after)
  const horizon = floor + SEARCH_DAYS * DAY_MS
  const firstDay = engine.dayAt(floor) - 1
  const lastDay = engine.dayAt(horizon) + 3
  const offsetsByDay = new Map<number, number[]>()
  let earliest = Number.POSITIVE_INFINITY

  for (let day = firstDay; day <= lastDay; day++) {
    const date = dateFromDayNumber(day)
    const weekday = new Date(day * DAY_MS).getUTCDay()
    if (schedule.matchesDate(date, weekday)) {
      let offsets = offsetsByDay.get(day)
      if (!offsets) {
        offsets = offsetsAroundDay(day, engine.formatter)
        offsetsByDay.set(day, offsets)
      }
      for (const hour of schedule.hours) {
        for (const minute of schedule.minutes) {
          for (const instant of instantsForWallMinute(date, hour, minute, offsets, engine.formatter)) {
            if (instant > after && instant >= dtstart && instant <= horizon && instant < earliest) {
              earliest = instant
            }
          }
        }
      }
    }
    if (Number.isFinite(earliest) && (day + 1) * DAY_MS - MAX_ABSOLUTE_ZONE_OFFSET_MS > earliest) break
  }

  if (!Number.isFinite(earliest)) throw new RangeError('Unable to compute next automation run.')
  return earliest
}

function latestOccurrence(
  schedule: CalendarSchedule,
  dtstart: number,
  now: number,
  timezone: string,
): number | null {
  assertFiniteTime(dtstart, 'dtstart')
  assertFiniteTime(now, 'now')
  const engine = createEngine(timezone)
  if (dtstart > now) return null

  const floor = Math.max(dtstart, now - SEARCH_DAYS * DAY_MS)
  const firstDay = engine.dayAt(now) + 1
  const lastDay = engine.dayAt(floor) - 3
  const offsetsByDay = new Map<number, number[]>()
  let latest = Number.NEGATIVE_INFINITY

  for (let day = firstDay; day >= lastDay; day--) {
    const date = dateFromDayNumber(day)
    const weekday = new Date(day * DAY_MS).getUTCDay()
    if (schedule.matchesDate(date, weekday)) {
      let offsets = offsetsByDay.get(day)
      if (!offsets) {
        offsets = offsetsAroundDay(day, engine.formatter)
        offsetsByDay.set(day, offsets)
      }
      for (const hour of schedule.hours) {
        for (const minute of schedule.minutes) {
          for (const instant of instantsForWallMinute(date, hour, minute, offsets, engine.formatter)) {
            if (instant >= dtstart && instant >= floor && instant <= now && instant > latest) latest = instant
          }
        }
      }
    }
    if (Number.isFinite(latest) && ((day - 1) * DAY_MS + DAY_MS + MAX_ABSOLUTE_ZONE_OFFSET_MS) < latest) break
  }

  return Number.isFinite(latest) ? latest : null
}

export function nextCalendarOccurrenceAfter(
  schedule: CalendarSchedule,
  dtstart: number,
  after: number,
  timezone: string,
): number {
  return firstOccurrence(schedule, dtstart, after, timezone)
}

export function latestCalendarOccurrenceAtOrBefore(
  schedule: CalendarSchedule,
  dtstart: number,
  now: number,
  timezone: string,
): number | null {
  return latestOccurrence(schedule, dtstart, now, timezone)
}
