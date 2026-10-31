import { describe, expect, test } from 'bun:test'
import { MARINE_NAMES, pickGeneratedName } from '../src/daemon/names'

describe('MARINE_NAMES', () => {
  test('has at least 200 names', () => {
    expect(MARINE_NAMES.length).toBeGreaterThanOrEqual(200)
  })
  test('names are distinct', () => {
    expect(new Set(MARINE_NAMES).size).toBe(MARINE_NAMES.length)
  })
  test('names are lowercase ASCII single words', () => {
    for (const n of MARINE_NAMES) expect(n).toMatch(/^[a-z]+$/)
  })
  test('includes the examples', () => {
    for (const n of ['narwhal', 'octopus', 'manta', 'nautilus']) expect(MARINE_NAMES).toContain(n)
  })
})

describe('pickGeneratedName', () => {
  test.each([1, 2, 3])('excludes the truncated sperm whale name in tier %i', (tier) => {
    const unavailable = new Set<string>()
    for (let occupiedTier = 1; occupiedTier < tier; occupiedTier++) {
      const suffix = occupiedTier === 1 ? '' : `-${occupiedTier}`
      for (const name of MARINE_NAMES) unavailable.add(`${name}${suffix}`)
    }

    for (let index = 0; index < MARINE_NAMES.length; index++) {
      const name = pickGeneratedName(unavailable, () => (index + 0.5) / MARINE_NAMES.length)
      expect(name).not.toMatch(/^sperm(?:-\d+)?$/)
    }
  })

  test('picks from the pool by random index', () => {
    expect(pickGeneratedName(new Set(), () => 0)).toBe(MARINE_NAMES[0])
    expect(pickGeneratedName(new Set(), () => 0.999999)).toBe(MARINE_NAMES[MARINE_NAMES.length - 1])
  })

  test('skips unavailable names', () => {
    const unavailable = new Set(MARINE_NAMES.slice(0, 5))
    expect(pickGeneratedName(unavailable, () => 0)).toBe(MARINE_NAMES[5])
  })

  test('picks uniformly among the remaining names', () => {
    const rest = MARINE_NAMES.slice(0, -2)
    const unavailable = new Set(rest)
    const last2 = MARINE_NAMES.slice(-2)
    expect(pickGeneratedName(unavailable, () => 0)).toBe(last2[0])
    expect(pickGeneratedName(unavailable, () => 0.5)).toBe(last2[1])
  })

  test('falls back to -2 when every base name is unavailable', () => {
    const all = new Set(MARINE_NAMES)
    expect(pickGeneratedName(all, () => 0)).toBe(`${MARINE_NAMES[0]}-2`)
  })

  test('falls back to -3 when -2 is also exhausted', () => {
    const all = new Set([...MARINE_NAMES, ...MARINE_NAMES.map((n) => `${n}-2`)])
    expect(pickGeneratedName(all, () => 0)).toBe(`${MARINE_NAMES[0]}-3`)
  })

  test('uses the first tier with any availability', () => {
    const all = new Set([...MARINE_NAMES, ...MARINE_NAMES.map((n) => `${n}-2`).slice(1)])
    expect(pickGeneratedName(all, () => 0.9)).toBe(`${MARINE_NAMES[0]}-2`)
  })

  test('defaults to Math.random and returns a pool name', () => {
    expect(MARINE_NAMES).toContain(pickGeneratedName(new Set()))
  })
})
