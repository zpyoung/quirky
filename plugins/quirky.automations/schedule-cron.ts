export type CronSchedule = {
  kind: 'cron'
  minutes: number[]
  hours: number[]
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  dayOfMonthUnrestricted: boolean
  dayOfWeekUnrestricted: boolean
}

type CronField = {
  name: string
  minimum: number
  maximum: number
  maximumStep: number
  aliases?: Readonly<Record<string, number>>
  normalize?: (value: number) => number
}

type ParsedField = { values: Set<number>; unrestricted: boolean }

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}
const WEEKDAYS: Readonly<Record<string, number>> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}
const CRON_FIELDS: readonly CronField[] = [
  { name: 'minute', minimum: 0, maximum: 59, maximumStep: 60 },
  { name: 'hour', minimum: 0, maximum: 23, maximumStep: 24 },
  { name: 'day-of-month', minimum: 1, maximum: 31, maximumStep: 31 },
  { name: 'month', minimum: 1, maximum: 12, maximumStep: 12, aliases: MONTHS },
  { name: 'day-of-week', minimum: 0, maximum: 7, maximumStep: 7, aliases: WEEKDAYS, normalize: (value) => value % 7 },
]
const UNICODE_WHITESPACE = /\p{White_Space}+/u

function parseAtom(source: string, field: CronField): number {
  const atom = source.toUpperCase()
  let value: number
  if (/^\d+$/.test(atom)) {
    value = Number(atom)
    if (!Number.isSafeInteger(value)) throw new RangeError(`Invalid ${field.name} value.`)
  } else if (field.aliases && Object.hasOwn(field.aliases, atom)) {
    value = field.aliases[atom]
  } else {
    throw new RangeError(`Invalid ${field.name} value.`)
  }
  if (value < field.minimum || value > field.maximum) {
    throw new RangeError(`Invalid ${field.name} value.`)
  }
  return value
}

function parseField(source: string, field: CronField, allowOversizedStep: boolean): ParsedField {
  if (!source) throw new RangeError(`Invalid ${field.name} field.`)
  const terms = source.split(',')
  const values = new Set<number>()
  let unrestricted = false
  for (const term of terms) {
    if (!term) throw new RangeError(`Invalid ${field.name} field.`)
    const slashParts = term.split('/')
    if (slashParts.length > 2 || !slashParts[0]) throw new RangeError(`Invalid ${field.name} field.`)
    const base = slashParts[0]
    if (base.includes('*')) unrestricted = true

    let step = 1
    if (slashParts.length === 2) {
      if (!/^\d+$/.test(slashParts[1])) throw new RangeError(`Invalid ${field.name} step.`)
      step = Number(slashParts[1])
      if (!Number.isSafeInteger(step) || step < 1) throw new RangeError(`Invalid ${field.name} step.`)
      if (!allowOversizedStep && step > field.maximumStep) {
        throw new RangeError(`${field.name} step is too large.`)
      }
    }

    let first: number
    let last: number
    if (base === '*') {
      first = field.minimum
      last = field.maximum
    } else {
      const rangeParts = base.split('-')
      if (rangeParts.length > 2 || rangeParts.some((part) => !part)) {
        throw new RangeError(`Invalid ${field.name} range.`)
      }
      first = parseAtom(rangeParts[0], field)
      if (rangeParts.length === 1) {
        last = slashParts.length === 2 ? field.maximum : first
      } else {
        last = parseAtom(rangeParts[1], field)
        if (last < first) throw new RangeError(`Invalid ${field.name} range.`)
      }
    }

    for (let value = first; value <= last; value += step) {
      values.add(field.normalize ? field.normalize(value) : value)
      if (last - value < step) break
    }
  }
  if (values.size === 0) throw new RangeError(`Empty ${field.name} field.`)
  return { values, unrestricted }
}

export function parseCronExpression(expression: string, allowOversizedSteps: boolean): CronSchedule {
  if (new TextEncoder().encode(expression).byteLength > 2048) {
    throw new RangeError('Automation cron expression exceeds 2048 bytes.')
  }
  const fields = expression.split(UNICODE_WHITESPACE).filter(Boolean)
  if (fields.length !== 5) throw new RangeError('Automation cron requires exactly five fields.')

  const parsed = CRON_FIELDS.map((field, index) => parseField(fields[index], field, allowOversizedSteps))
  return {
    kind: 'cron',
    minutes: [...parsed[0].values].sort((a, b) => a - b),
    hours: [...parsed[1].values].sort((a, b) => a - b),
    daysOfMonth: parsed[2].values,
    months: parsed[3].values,
    daysOfWeek: parsed[4].values,
    dayOfMonthUnrestricted: parsed[2].unrestricted,
    dayOfWeekUnrestricted: parsed[4].unrestricted,
  }
}
