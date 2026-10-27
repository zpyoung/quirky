import { describe, expect, test } from 'bun:test'
import { Cooldown } from '../src/cooldown'

describe('Cooldown', () => {
  test('a key is within the window after reserve', () => {
    const c = new Cooldown({ now: () => 1000 })
    expect(c.check('w1')).toBe(false)
    c.reserve('w1')
    expect(c.check('w1')).toBe(true)
  })

  test('other keys are independent', () => {
    const c = new Cooldown({ now: () => 1000 })
    c.reserve('w1')
    expect(c.check('w2')).toBe(false)
    expect(c.check('global')).toBe(false)
  })

  test('the window ends after 5 seconds', () => {
    let now = 1000
    const c = new Cooldown({ now: () => now })
    c.reserve('w1')
    now = 5999
    expect(c.check('w1')).toBe(true)
    now = 6000
    expect(c.check('w1')).toBe(false)
  })

  test('reserving again restarts the window', () => {
    let now = 0
    const c = new Cooldown({ now: () => now })
    c.reserve('w1')
    now = 4000
    c.reserve('w1')
    now = 8000
    expect(c.check('w1')).toBe(true)
  })

  test('keeps at most 50 keys, dropping the oldest', () => {
    const c = new Cooldown({ now: () => 1000 })
    for (let i = 0; i < 51; i++) c.reserve(`w${i}`)
    expect(c.check('w0')).toBe(false)
    expect(c.check('w1')).toBe(true)
    expect(c.check('w50')).toBe(true)
  })

  test('re-reserving a key makes it the newest for eviction', () => {
    const c = new Cooldown({ now: () => 1000, maxKeys: 3 })
    c.reserve('a')
    c.reserve('b')
    c.reserve('c')
    c.reserve('a')
    c.reserve('d')
    expect(c.check('b')).toBe(false)
    expect(c.check('a')).toBe(true)
  })
})
