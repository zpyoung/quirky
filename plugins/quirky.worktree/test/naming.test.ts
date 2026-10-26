import { describe, expect, test } from 'bun:test'
import {
  InvalidNameError,
  NoFreeNameError,
  branchName,
  normalizePrefix,
  sanitizeName,
  walkCandidates,
} from '../src/daemon/naming'

describe('sanitizeName', () => {
  const cases: Array<[string, string]> = [
    ['Fix Login: ünïcode!', 'Fix-Login-ünïcode'],
    ['../../etc', 'etc'],
    ['🦀🦀', 'workspace'],
    ['feat/passing', 'feat-passing'],
    ['a--b', 'a-b'],
    ['a..b', 'a.b'],
    ['-.-a-.-', 'a'],
    ['  spaced   out  ', 'spaced-out'],
    ['crab 🦀', 'crab'],
    ['keep_under.score-dash', 'keep_under.score-dash'],
  ]
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(sanitizeName(input)).toBe(expected)
    })
  }

  test('normalises to NFC', () => {
    expect(sanitizeName('ü')).toBe('ü')
  })

  for (const bad of ['...', '', '.', '..', '!!!', '---']) {
    test(`throws for ${JSON.stringify(bad)}`, () => {
      expect(() => sanitizeName(bad)).toThrow(InvalidNameError)
    })
  }

  test('error message', () => {
    expect(() => sanitizeName('...')).toThrow('Invalid worktree name')
  })
})

describe('normalizePrefix', () => {
  const cases: Array<[string, string]> = [
    ['zoe', 'zoe'],
    ['  zoe  ', 'zoe'],
    ['/zoe/', 'zoe'],
    ['team//sub', 'team/sub'],
    ['///team///sub///', 'team/sub'],
    ['', ''],
    ['  / ', ''],
  ]
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(normalizePrefix(input)).toBe(expected)
    })
  }
})

describe('branchName', () => {
  test('joins prefix and name', () => {
    expect(branchName('zoe', 'fix')).toBe('zoe/fix')
    expect(branchName('/team//x/', 'fix')).toBe('team/x/fix')
  })
  test('null or empty prefix gives the bare name', () => {
    expect(branchName(null, 'fix')).toBe('fix')
    expect(branchName('', 'fix')).toBe('fix')
    expect(branchName(' / ', 'fix')).toBe('fix')
  })
})

describe('walkCandidates', () => {
  test('returns the name when free', async () => {
    expect(await walkCandidates('a', async () => false)).toBe('a')
  })

  test('tries candidates in order and returns the first free', async () => {
    const seen: string[] = []
    const taken = new Set(['a', 'a-2'])
    const got = await walkCandidates('a', async (c) => {
      seen.push(c)
      return taken.has(c)
    })
    expect(got).toBe('a-3')
    expect(seen).toEqual(['a', 'a-2', 'a-3'])
  })

  test('can reach name-<max>', async () => {
    const got = await walkCandidates('a', async (c) => c !== 'a-100')
    expect(got).toBe('a-100')
  })

  test('throws after max misses', async () => {
    let calls = 0
    await expect(
      walkCandidates('a', async () => {
        calls++
        return true
      }),
    ).rejects.toThrow(NoFreeNameError)
    expect(calls).toBe(100)
  })

  test('honours a custom max', async () => {
    const seen: string[] = []
    await expect(
      walkCandidates('a', async (c) => (seen.push(c), true), 3),
    ).rejects.toBeInstanceOf(NoFreeNameError)
    expect(seen).toEqual(['a', 'a-2', 'a-3'])
  })
})
