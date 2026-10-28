import { describe, expect, test } from 'bun:test'
import {
  buildAutomationRrule,
  describeAutomationSchedule,
  isRunnableAutomationSchedule,
  isValidAutomationSchedule,
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter,
} from '../schedule'

const at = (value: string) => Date.parse(value)
const UTC = 'UTC'
const NEW_YORK = 'America/New_York'

describe('automation schedule presets and labels', () => {
  test('builds the documented preset shapes and defaults', () => {
    expect(buildAutomationRrule({ preset: 'hourly', minute: 15 })).toBe('FREQ=HOURLY;BYMINUTE=15')
    expect(buildAutomationRrule({ preset: 'daily' })).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
    expect(buildAutomationRrule({ preset: 'weekdays', hour: 10, minute: 5 })).toBe(
      'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10;BYMINUTE=5',
    )
    expect(buildAutomationRrule({ preset: 'weekly' })).toBe(
      'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
    )
    expect(buildAutomationRrule({ preset: 'weekly', day: 0, hour: 12, minute: 30 })).toBe(
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=30',
    )
    expect(buildAutomationRrule({ preset: 'custom', cron: '  15 * * * *  ' })).toBe('15 * * * *')
  })

  test('recognizes preset cron shapes and returns custom or invalid labels', () => {
    expect(describeAutomationSchedule('15 * * * *')).toEqual({
      kind: 'hourly', label: 'Hourly at :15', minute: 15,
    })
    expect(describeAutomationSchedule('0 9 * * *')).toEqual({
      kind: 'daily', label: 'Daily at 9:00 AM', hour: 9, minute: 0,
    })
    expect(describeAutomationSchedule('0 9 * * 1-5')).toEqual({
      kind: 'weekdays', label: 'Weekdays at 9:00 AM', hour: 9, minute: 0,
    })
    expect(describeAutomationSchedule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=14;BYMINUTE=0')).toEqual({
      kind: 'weekly', label: 'Mondays at 2:00 PM', day: 1, hour: 14, minute: 0,
    })
    expect(describeAutomationSchedule('10 11 1 * *')).toEqual({ kind: 'custom', label: 'Custom schedule' })
    expect(describeAutomationSchedule('0 9 30 2 *')).toEqual({ kind: 'invalid', label: 'Invalid schedule' })
  })

  test('labels restricted full day-of-month ranges by their OR semantics', () => {
    const daily = { kind: 'daily' as const, label: 'Daily at 9:00 AM', hour: 9, minute: 0 }
    expect(describeAutomationSchedule('0 9 1-31 * MON')).toEqual(daily)
    expect(describeAutomationSchedule('0 9 1-31 * 1-5')).toEqual(daily)
  })

  test('rejects invalid preset values rather than silently producing a different schedule', () => {
    expect(() => buildAutomationRrule({ preset: 'hourly', minute: 60 })).toThrow()
    expect(() => buildAutomationRrule({ preset: 'daily', hour: -1 })).toThrow()
    expect(() => buildAutomationRrule({ preset: 'weekly', day: 7 })).toThrow()
    expect(() => buildAutomationRrule({ preset: 'custom' })).toThrow()
  })
})

describe('automation cron dialect', () => {
  test('uses N/step as a range from N through the field maximum', () => {
    const rule = '5/20 * * JAN-MAR MON-FRI'
    const origin = at('2026-01-05T00:00:00.000Z')
    expect(nextAutomationOccurrenceAfter(rule, origin, origin, UTC)).toBe(at('2026-01-05T00:05:00.000Z'))
    expect(nextAutomationOccurrenceAfter(rule, origin, at('2026-01-05T00:05:00.000Z'), UTC)).toBe(
      at('2026-01-05T00:25:00.000Z'),
    )
    expect(nextAutomationOccurrenceAfter(rule, origin, at('2026-01-05T00:25:00.000Z'), UTC)).toBe(
      at('2026-01-05T00:45:00.000Z'),
    )
    expect(nextAutomationOccurrenceAfter(rule, origin, at('2026-01-05T00:45:00.000Z'), UTC)).toBe(
      at('2026-01-05T01:05:00.000Z'),
    )
  })

  test('treats a bare value as one value and supports names, lists, ranges, and Sunday 7', () => {
    const origin = at('2026-01-05T00:00:00.000Z')
    expect(nextAutomationOccurrenceAfter('5 * * * *', origin, origin, UTC)).toBe(
      at('2026-01-05T00:05:00.000Z'),
    )
    expect(nextAutomationOccurrenceAfter('0 9 * JAN-MAR MON-FRI', origin, origin, UTC)).toBe(
      at('2026-01-05T09:00:00.000Z'),
    )
    expect(nextAutomationOccurrenceAfter('0 9 * * 7', origin, at('2026-01-09T10:00:00.000Z'), UTC)).toBe(
      at('2026-01-11T09:00:00.000Z'),
    )
    expect(isValidAutomationSchedule('0,30 8-10 * * MON-FRI', UTC)).toBe(true)
  })

  test('splits fields using Unicode whitespace', () => {
    expect(isValidAutomationSchedule('0\u20039\u00a0*\u202f*\u3000MON', UTC)).toBe(true)
    expect(nextAutomationOccurrenceAfter(
      '0\u20039\u00a0*\u202f*\u3000MON',
      at('2026-01-05T00:00:00.000Z'),
      at('2026-01-05T00:00:00.000Z'),
      UTC,
    )).toBe(at('2026-01-05T09:00:00.000Z'))
  })

  test('uses DOM/DOW OR only when both day fields are restricted', () => {
    const origin = at('2026-06-02T09:01:00.000Z')
    expect(nextAutomationOccurrenceAfter('0 9 1 * MON', origin, origin, UTC)).toBe(
      at('2026-06-08T09:00:00.000Z'),
    )
    // The DOM has a lexical wildcard term, so it is unrestricted and combines with Monday using AND.
    expect(nextAutomationOccurrenceAfter('0 9 *,1 * MON', origin, origin, UTC)).toBe(
      at('2026-06-08T09:00:00.000Z'),
    )
  })

  test('rejects malformed, overlong, oversized-step, and impossible cron input', () => {
    expect(isValidAutomationSchedule('0 9 * *')).toBe(false)
    expect(isValidAutomationSchedule('0 9 * * * extra')).toBe(false)
    expect(isValidAutomationSchedule('0 9 30 2 *', UTC)).toBe(false)
    expect(isValidAutomationSchedule('*/90 * * * *', UTC)).toBe(false)
    expect(isValidAutomationSchedule(`${' '.repeat(2049)}0 9 * * *`, UTC)).toBe(false)
    expect(isRunnableAutomationSchedule(`${' '.repeat(2049)}0 9 * * *`, UTC)).toBe(false)
  })

  test('accepts finite leap-day schedules and runs legacy oversized steps', () => {
    expect(isValidAutomationSchedule('0 9 29 2 *', UTC)).toBe(true)
    expect(isRunnableAutomationSchedule('*/90 * * * *', UTC)).toBe(true)
    expect(nextAutomationOccurrenceAfter(
      '*/90 * * * *', at('2026-01-01T00:00:00.000Z'), at('2026-01-01T00:00:00.000Z'), UTC,
    )).toBe(at('2026-01-01T01:00:00.000Z'))
  })
})

describe('automation schedule occurrence bounds', () => {
  test('keeps next strict and latest inclusive at exact occurrence bounds', () => {
    const rule = '0 9 * * *'
    const first = at('2026-01-03T09:00:00.000Z')
    expect(nextAutomationOccurrenceAfter(rule, first, at('2026-01-02T09:00:00.000Z'), UTC)).toBe(first)
    expect(nextAutomationOccurrenceAfter(rule, first, first, UTC)).toBe(at('2026-01-04T09:00:00.000Z'))
    expect(latestAutomationOccurrenceAtOrBefore(rule, first, first, UTC)).toBe(first)
    expect(latestAutomationOccurrenceAtOrBefore(rule, first + 1, first, UTC)).toBeNull()
  })

  test('honors future dtstart and never returns latest before the lower bound', () => {
    const rule = '0 9 * * *'
    const dtstart = at('2026-04-01T10:00:00.000Z')
    expect(latestAutomationOccurrenceAtOrBefore(rule, dtstart, at('2026-04-01T09:00:00.000Z'), UTC)).toBeNull()
    expect(nextAutomationOccurrenceAfter(rule, dtstart, at('2026-03-31T09:00:00.000Z'), UTC)).toBe(
      at('2026-04-02T09:00:00.000Z'),
    )
  })

  test('returns null before the first sparse occurrence but throws for impossible latest math', () => {
    const dtstart = at('2026-03-01T00:00:00.000Z')
    const now = at('2027-01-01T00:00:00.000Z')
    expect(latestAutomationOccurrenceAtOrBefore('0 0 29 2 *', dtstart, now, UTC)).toBeNull()
    expect(() => latestAutomationOccurrenceAtOrBefore('0 0 30 2 *', dtstart, now, UTC)).toThrow()
  })

  test('uses the saved IANA zone rather than the process timezone', () => {
    const originalTZ = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const rule = '0 9 * * *'
      const origin = at('2025-12-31T00:00:00.000Z')
      expect(nextAutomationOccurrenceAfter(rule, origin, origin, 'Asia/Tokyo')).toBe(
        at('2026-01-01T00:00:00.000Z'),
      )
    } finally {
      if (originalTZ === undefined) delete process.env.TZ
      else process.env.TZ = originalTZ
    }
  })

  test('skips New York spring gaps for cron and daily RRULE schedules', () => {
    const dtstart = at('2026-03-08T06:00:00.000Z')
    const after = at('2026-03-08T06:00:00.000Z')
    const expected = at('2026-03-09T06:30:00.000Z')
    expect(nextAutomationOccurrenceAfter('30 2 * * *', dtstart, after, NEW_YORK)).toBe(expected)
    expect(nextAutomationOccurrenceAfter('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', dtstart, after, NEW_YORK)).toBe(expected)
  })

  test('returns both New York fall repetitions and advances after the second fold occurrence', () => {
    const dtstart = at('2026-11-01T04:00:00.000Z')
    const first = at('2026-11-01T05:30:00.000Z')
    const second = at('2026-11-01T06:30:00.000Z')
    const followingDay = at('2026-11-02T06:30:00.000Z')
    expect(nextAutomationOccurrenceAfter('30 1 * * *', dtstart, at('2026-11-01T04:59:00.000Z'), NEW_YORK)).toBe(first)
    expect(nextAutomationOccurrenceAfter('30 1 * * *', dtstart, first, NEW_YORK)).toBe(second)
    expect(latestAutomationOccurrenceAtOrBefore('30 1 * * *', dtstart, second, NEW_YORK)).toBe(second)
    expect(nextAutomationOccurrenceAfter('30 1 * * *', dtstart, second, NEW_YORK)).toBe(followingDay)
  })

  test('applies the same fold policy to hourly RRULE schedules', () => {
    const dtstart = at('2026-11-01T04:00:00.000Z')
    expect(nextAutomationOccurrenceAfter(
      'FREQ=HOURLY;BYMINUTE=30', dtstart, at('2026-11-01T05:30:00.000Z'), NEW_YORK,
    )).toBe(at('2026-11-01T06:30:00.000Z'))
    expect(nextAutomationOccurrenceAfter(
      'FREQ=HOURLY;BYMINUTE=30', dtstart, at('2026-11-01T06:30:00.000Z'), NEW_YORK,
    )).toBe(at('2026-11-01T07:30:00.000Z'))
  })

  test('rejects invalid zones and invalid stored rules', () => {
    expect(isValidAutomationSchedule('0 9 * * *', 'Mars/Olympus')).toBe(false)
    expect(isRunnableAutomationSchedule('not a schedule', UTC)).toBe(false)
    expect(() => nextAutomationOccurrenceAfter('0 9 * * *', 0, 0, 'Mars/Olympus')).toThrow()
    expect(describeAutomationSchedule('FREQ=DAILY;INTERVAL=2')).toEqual({
      kind: 'invalid', label: 'Invalid schedule',
    })
  })
})
