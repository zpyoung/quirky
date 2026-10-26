import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_JOB_TIMEOUT_MS,
  MAX_JOB_DURATION_MS,
  MIN_JOB_INTERVAL_MS,
  formatDuration,
  isReservedLaunchEnv,
  parseDuration,
  type QuirkyEvent
} from '../src'

describe('parseDuration', () => {
  test('parses every unit to milliseconds', () => {
    expect(parseDuration('5ms')).toBe(5)
    expect(parseDuration('1s')).toBe(1000)
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('2d')).toBe(172_800_000)
  })

  test('returns null for anything else', () => {
    for (const text of ['', '1.5s', '10', '-1s', ' 1s', '1s ', 's', '1w', '1S', '1 s']) {
      expect(parseDuration(text)).toBeNull()
    }
  })
})

describe('formatDuration', () => {
  test('uses the largest unit that divides evenly', () => {
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(90_000)).toBe('90s')
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(86_400_000)).toBe('1d')
    expect(formatDuration(1500)).toBe('1500ms')
  })

  test('round-trips through parseDuration', () => {
    for (const ms of [1, 1500, 1000, 60_000, 3_600_000, 172_800_000]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms)
    }
  })
})

describe('isReservedLaunchEnv', () => {
  test('is true for PATH, ZDOTDIR and QUIRKY_ names', () => {
    for (const name of ['PATH', 'ZDOTDIR', 'QUIRKY_SESSION_ID', 'QUIRKY_']) {
      expect(isReservedLaunchEnv(name)).toBe(true)
    }
  })

  test('is false for everything else', () => {
    for (const name of ['path', 'QUIRKYX', 'HOME']) expect(isReservedLaunchEnv(name)).toBe(false)
  })
})

describe('job bounds', () => {
  test('match the contract', () => {
    expect(MIN_JOB_INTERVAL_MS).toBe(1000)
    expect(MAX_JOB_DURATION_MS).toBe(86_400_000)
    expect(DEFAULT_JOB_TIMEOUT_MS).toBe(300_000)
  })
})

describe('QuirkyEvent', () => {
  test('accepts plugin events and still narrows built-in ones', () => {
    const pluginEvent: QuirkyEvent = { type: 'acme.tools/refreshed', data: 1 }
    const title = (event: QuirkyEvent): string | null => (event.type === 'notify' ? event.title : null)
    expect(title(pluginEvent)).toBeNull()
    expect(title({ type: 'notify', title: 't', body: 'b' })).toBe('t')
  })
})
