import { describe, expect, test } from 'bun:test'
import { matchesPattern } from '../../src/core/pattern'

describe('matchesPattern', () => {

  test('keeps optional, lazy and zero-count literals optional', () => {
    for (const [source, value] of [
      ['^a?b$', 'b'],
      ['^a*?b$', 'b'],
      ['^a{0}b$', 'b'],
      ['^a{0,3}b$', 'b'],
      ['^a{1,2}?b$', 'ab']
    ]) {
      expect(matchesPattern(new RegExp(source), value)).toBe(true)
    }
  })

  test('rejects inputs missing positively quantified literals', () => {
    for (const source of ['^a+b$', '^a{1,3}b$']) {
      expect(matchesPattern(new RegExp(source), 'b')).toBe(false)
    }
  })

  test('does not infer required characters from classes', () => {
    for (const [source, value] of [
      ['^[a-z]+$', 'z'],
      ['^[^x]+x?$', 'a'],
      ['^[\\]]+$', ']'],
      ['^[a-z]*!$', 'abc!']
    ]) {
      expect(matchesPattern(new RegExp(source), value)).toBe(true)
    }
  })

  test('closes empty character classes before following alternatives', () => {
    expect(matchesPattern(new RegExp('[^]a|b]c'), 'xa')).toBe(true)
    expect(matchesPattern(new RegExp('[]a|b]c'), 'xa')).toBe(false)
  })

  test('does not infer top-level literals across alternation', () => {
    expect(matchesPattern(new RegExp('a*b|c'), 'c')).toBe(true)
    expect(matchesPattern(new RegExp('a*b|c'), 'aaab')).toBe(true)
  })

  test('preserves escaped tokens, groups, lookarounds and backreferences', () => {
    for (const [source, value] of [
      ['^\\d+$', '123'],
      ['^(?:ab)+$', 'abab'],
      ['(?=b)b', 'b'],
      ['^(a)\\1$', 'aa']
    ]) {
      const regex = new RegExp(source)
      expect(matchesPattern(regex, value)).toBe(regex.test(value))
    }
  })

  test('preserves empty, unanchored, Unicode and newline matches', () => {
    for (const [source, value] of [
      ['^a*$', ''],
      ['^a+$', ''],
      ['a*b', 'xxbzz'],
      ['^é+$', 'éé'],
      ['a\nb', 'a\nb'],
      ['.*', 'line\nbreak']
    ]) {
      const regex = new RegExp(source)
      expect(matchesPattern(regex, value)).toBe(regex.test(value))
    }
  })

  test('preserves braces treated as literals in non-Unicode regexes', () => {
    for (const [source, value] of [
      ['a{b}', 'a{b}'],
      ['a{2', 'a{2'],
    ]) {
      const regex = new RegExp(source)
      expect(matchesPattern(regex, value)).toBe(regex.test(value))
    }
  })

  test('matches a deterministic corpus exactly like native RegExp.test', () => {
    const cases: Array<[string, string]> = [
      ['^a*b$', 'b'],
      ['a+b', 'xaayb'],
      ['^a{1,3}b$', 'aab'],
      ['^a{0,3}b$', 'b'],

      ['^[a-z]*!$', 'abc!'],
      ['a*b|c', 'c'],
      ['^(?:ab)+$', 'abab'],
      ['(?=b)b', 'b'],
      ['^(a)\\1$', 'aa'],
      ['^\\w+$', 'word_2'],
      ['^é+$', 'éé'],
      ['a\nb', 'a\nb'],
      ['a{b}', 'a{b}'],
      ['^a?$', ''],
      ['^$', 'x']
    ]

    for (const [source, value] of cases) {
      const expected = new RegExp(source).test(value)
      expect(matchesPattern(new RegExp(source), value)).toBe(expected)
    }
  })

  test('uses native matching when flags are present', () => {
    expect(matchesPattern(/b/i, 'B')).toBe(true)

    const globalRegex = /b/g
    expect(matchesPattern(globalRegex, 'b')).toBe(true)
    expect(matchesPattern(globalRegex, 'b')).toBe(false)
    expect(globalRegex.lastIndex).toBe(0)
  })

})
