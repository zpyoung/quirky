import type { ScheduleBuildInput, ScheduleDescription } from './types'
import { parseCronExpression, type CronSchedule } from './schedule-cron'
import {
  defaultTimeZone,
  isValidTimeZone,
  latestCalendarOccurrenceAtOrBefore,
  nextCalendarOccurrenceAfter,
  type CalendarDate,
  type CalendarSchedule,
} from './schedule-time'

type RRuleSchedule = {
  kind: 'rrule'
  frequency: 'HOURLY' | 'DAILY' | 'WEEKLY'
  minutes: number[]
  hours: number[]
  weekdays: Set<number>
}
type ParsedSchedule = CronSchedule | RRuleSchedule

const WEEKDAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'] as const
const RRULE_WEEKDAYS: Readonly<Record<string, number>> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
}
const RRULE_DAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

function parseBoundedInteger(source: string, minimum: number, maximum: number, name: string): number {
  if (!/^\d+$/.test(source)) throw new RangeError(`Invalid ${name}.`)
  const value = Number(source)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Invalid ${name}.`)
  }
  return value
}

function parseRRule(rule: string): RRuleSchedule {
  const entries = new Map<string, string>()
  for (const entry of rule.trim().split(';')) {
    const equals = entry.indexOf('=')
    if (equals <= 0 || equals !== entry.lastIndexOf('=')) throw new RangeError('Invalid automation recurrence.')
    const key = entry.slice(0, equals).trim().toUpperCase()
    const value = entry.slice(equals + 1).trim().toUpperCase()
    if (!key || !value || entries.has(key)) throw new RangeError('Invalid automation recurrence.')
    entries.set(key, value)
  }

  for (const key of entries.keys()) {
    if (key !== 'FREQ' && key !== 'BYHOUR' && key !== 'BYMINUTE' && key !== 'BYDAY') {
      throw new RangeError('Unsupported automation recurrence.')
    }
  }
  const frequency = entries.get('FREQ')
  if (frequency !== 'HOURLY' && frequency !== 'DAILY' && frequency !== 'WEEKLY') {
    throw new RangeError('Unsupported automation recurrence.')
  }
  if (frequency !== 'WEEKLY' && entries.has('BYDAY')) throw new RangeError('Unsupported automation recurrence.')
  if (frequency === 'HOURLY' && entries.has('BYHOUR')) throw new RangeError('Unsupported automation recurrence.')

  const minute = parseBoundedInteger(entries.get('BYMINUTE') ?? '0', 0, 59, 'BYMINUTE')
  const hour = frequency === 'HOURLY'
    ? undefined
    : parseBoundedInteger(entries.get('BYHOUR') ?? '9', 0, 23, 'BYHOUR')
  const weekdays = new Set<number>()
  if (frequency === 'WEEKLY') {
    const byday = entries.get('BYDAY')
    if (!byday) throw new RangeError('Weekly automation recurrence requires BYDAY.')
    for (const weekday of byday.split(',')) {
      const day = RRULE_WEEKDAYS[weekday]
      if (day === undefined) throw new RangeError('Invalid BYDAY.')
      weekdays.add(day)
    }
    if (!weekdays.size) throw new RangeError('Invalid BYDAY.')
  }

  return {
    kind: 'rrule',
    frequency,
    minutes: [minute],
    hours: frequency === 'HOURLY' ? Array.from({ length: 24 }, (_, value) => value) : [hour as number],
    weekdays,
  }
}

function parseSchedule(rule: string, allowOversizedSteps: boolean): ParsedSchedule {
  if (typeof rule !== 'string' || !rule.trim()) throw new RangeError('Invalid automation schedule.')
  return rule.includes('=') ? parseRRule(rule) : parseCronExpression(rule, allowOversizedSteps)
}

function calendarSchedule(rule: ParsedSchedule): CalendarSchedule {
  if (rule.kind === 'rrule') {
    return {
      minutes: rule.minutes,
      hours: rule.hours,
      matchesDate(_date: CalendarDate, weekday: number) {
        return rule.frequency !== 'WEEKLY' || rule.weekdays.has(weekday)
      },
    }
  }

  return {
    minutes: rule.minutes,
    hours: rule.hours,
    matchesDate(date: CalendarDate, weekday: number) {
      if (!rule.months.has(date.month)) return false
      const matchesDayOfMonth = rule.daysOfMonth.has(date.day)
      const matchesDayOfWeek = rule.daysOfWeek.has(weekday)
      const matchesDay = rule.dayOfMonthUnrestricted || rule.dayOfWeekUnrestricted
        ? matchesDayOfMonth && matchesDayOfWeek
        : matchesDayOfMonth || matchesDayOfWeek
      return matchesDay
    },
  }
}

function assertPresetValue(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`Invalid schedule ${name}.`)
  }
  return selected
}

function formatTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM'
  const displayHour = hour % 12 || 12
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`
}

function invalidDescription(): ScheduleDescription {
  return { kind: 'invalid', label: 'Invalid schedule' }
}

function customDescription(): ScheduleDescription {
  return { kind: 'custom', label: 'Custom schedule' }
}

function hasAllValues(values: Set<number>, minimum: number, maximum: number): boolean {
  if (values.size !== maximum - minimum + 1) return false
  for (let value = minimum; value <= maximum; value++) if (!values.has(value)) return false
  return true
}

function setEquals(values: Set<number>, expected: readonly number[]): boolean {
  return values.size === expected.length && expected.every((value) => values.has(value))
}

function isRunnableParsed(rule: ParsedSchedule, timezone: string): boolean {
  const now = Date.now()
  nextCalendarOccurrenceAfter(calendarSchedule(rule), now, now, timezone)
  return true
}

function describeParsed(rule: ParsedSchedule): ScheduleDescription {
  if (rule.kind === 'rrule') {
    if (!isRunnableParsed(rule, defaultTimeZone())) return invalidDescription()
    if (rule.frequency === 'HOURLY') {
      const minute = rule.minutes[0]
      return { kind: 'hourly', label: `Hourly at :${String(minute).padStart(2, '0')}`, minute }
    }
    const hour = rule.hours[0]
    const minute = rule.minutes[0]
    const time = formatTime(hour, minute)
    if (rule.frequency === 'DAILY') return { kind: 'daily', label: `Daily at ${time}`, hour, minute }
    if (setEquals(rule.weekdays, [1, 2, 3, 4, 5])) {
      return { kind: 'weekdays', label: `Weekdays at ${time}`, hour, minute }
    }
    if (rule.weekdays.size === 1) {
      const day = rule.weekdays.values().next().value as number
      return { kind: 'weekly', label: `${WEEKDAY_NAMES[day]} at ${time}`, day, hour, minute }
    }
    return customDescription()
  }

  if (!isRunnableParsed(rule, defaultTimeZone())) return invalidDescription()
  const dayOfMonthAll = hasAllValues(rule.daysOfMonth, 1, 31)
  const monthsAll = hasAllValues(rule.months, 1, 12)
  const daysOfWeekAll = hasAllValues(rule.daysOfWeek, 0, 6)
  const bothDayFieldsRestricted = !rule.dayOfMonthUnrestricted && !rule.dayOfWeekUnrestricted
  const matchesEveryDay = bothDayFieldsRestricted
    ? dayOfMonthAll || daysOfWeekAll
    : dayOfMonthAll && daysOfWeekAll
  const allDates = monthsAll && matchesEveryDay
  const presetDayShape = monthsAll && dayOfMonthAll && rule.dayOfMonthUnrestricted
  if (presetDayShape && setEquals(rule.daysOfWeek, [1, 2, 3, 4, 5]) && rule.hours.length === 1 && rule.minutes.length === 1) {
    const hour = rule.hours[0]
    const minute = rule.minutes[0]
    return { kind: 'weekdays', label: `Weekdays at ${formatTime(hour, minute)}`, hour, minute }
  }
  if (allDates && rule.hours.length === 1 && rule.minutes.length === 1) {
    const hour = rule.hours[0]
    const minute = rule.minutes[0]
    return { kind: 'daily', label: `Daily at ${formatTime(hour, minute)}`, hour, minute }
  }
  if (presetDayShape && rule.daysOfWeek.size === 1 && rule.hours.length === 1 && rule.minutes.length === 1) {
    const day = rule.daysOfWeek.values().next().value as number
    const hour = rule.hours[0]
    const minute = rule.minutes[0]
    return { kind: 'weekly', label: `${WEEKDAY_NAMES[day]} at ${formatTime(hour, minute)}`, day, hour, minute }
  }
  if (allDates && rule.hours.length === 24 && rule.minutes.length === 1) {
    const minute = rule.minutes[0]
    return { kind: 'hourly', label: `Hourly at :${String(minute).padStart(2, '0')}`, minute }
  }
  return customDescription()
}

export function buildAutomationRrule(input: ScheduleBuildInput): string {
  const minute = assertPresetValue(input.minute, 0, 0, 59, 'minute')
  switch (input.preset) {
    case 'hourly':
      return `FREQ=HOURLY;BYMINUTE=${minute}`
    case 'daily': {
      const hour = assertPresetValue(input.hour, 9, 0, 23, 'hour')
      return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`
    }
    case 'weekdays': {
      const hour = assertPresetValue(input.hour, 9, 0, 23, 'hour')
      return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${hour};BYMINUTE=${minute}`
    }
    case 'weekly': {
      const hour = assertPresetValue(input.hour, 9, 0, 23, 'hour')
      const day = assertPresetValue(input.day, 1, 0, 6, 'day')
      return `FREQ=WEEKLY;BYDAY=${RRULE_DAY_NAMES[day]};BYHOUR=${hour};BYMINUTE=${minute}`
    }
    case 'custom':
      if (typeof input.cron !== 'string' || !input.cron.trim()) throw new RangeError('Custom schedule requires cron text.')
      return input.cron.trim()
    default:
      throw new RangeError('Unsupported automation schedule preset.')
  }
}

export function describeAutomationSchedule(rule: string): ScheduleDescription {
  try {
    return describeParsed(parseSchedule(rule, true))
  } catch {
    return invalidDescription()
  }
}

export function isValidAutomationSchedule(rule: string, timezone?: string): boolean {
  const zone = timezone ?? defaultTimeZone()
  if (!isValidTimeZone(zone)) return false
  try {
    const parsed = parseSchedule(rule, false)
    return isRunnableParsed(parsed, zone)
  } catch {
    return false
  }
}

export function isRunnableAutomationSchedule(rule: string, timezone?: string): boolean {
  const zone = timezone ?? defaultTimeZone()
  if (!isValidTimeZone(zone)) return false
  try {
    const parsed = parseSchedule(rule, true)
    return isRunnableParsed(parsed, zone)
  } catch {
    return false
  }
}

export function nextAutomationOccurrenceAfter(
  rule: string,
  dtstart: number,
  after: number,
  timezone: string,
): number {
  return nextCalendarOccurrenceAfter(calendarSchedule(parseSchedule(rule, true)), dtstart, after, timezone)
}

export function latestAutomationOccurrenceAtOrBefore(
  rule: string,
  dtstart: number,
  now: number,
  timezone: string,
): number | null {
  const schedule = calendarSchedule(parseSchedule(rule, true))
  nextCalendarOccurrenceAfter(schedule, now, now, timezone)
  return latestCalendarOccurrenceAtOrBefore(schedule, dtstart, now, timezone)
}
