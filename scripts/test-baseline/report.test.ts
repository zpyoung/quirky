import { describe, expect, test } from 'bun:test'
import { COMMENT_MARKER, displayKey, renderComment } from './report'
import type { Verdict } from './types'

const NOW = new Date('2026-10-30T12:00:00Z')
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'

const key = (file: string, classname: string, name: string) => `${file}\0${classname}\0${name}`

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    ok: true,
    advisory: false,
    baseline: { commit: COMMIT, createdAt: '2026-10-30T09:00:00Z' },
    selection: { mode: 'some', files: ['a.test.ts'], reasons: [] },
    new: [],
    known: [],
    flaky: [],
    fixed: [],
    missing: [],
    incomplete: [],
    notOnCi: [],
    runBroken: false,
    ...overrides,
  }
}

describe('displayKey', () => {
  test('joins file, describes and name readably', () => {
    const text = displayKey(key('packages/ui/a.test.ts', 'inner > outer', 'opens a pane'))
    expect(text).not.toContain('\0')
    expect(text).toContain('packages/ui/a.test.ts')
    expect(text).toContain('inner > outer')
    expect(text).toContain('opens a pane')
  })

  test('skips an empty classname', () => {
    const text = displayKey(key('a.test.ts', '', 'works'))
    expect(text).toBe('a.test.ts > works')
  })

  test('leaves a bare file path unchanged', () => {
    expect(displayKey('packages/ui/a.test.ts')).toBe('packages/ui/a.test.ts')
  })

  test('keeps the repeat suffix', () => {
    expect(displayKey(key('a.test.ts', 'suite', 'works#2'))).toContain('works#2')
  })
})

describe('renderComment', () => {
  test('starts with the marker', () => {
    expect(COMMENT_MARKER).toBe('<!-- test-baseline-verdict -->')
    expect(renderComment(verdict(), NOW).startsWith(COMMENT_MARKER)).toBe(true)
  })

  test('opens with the result and counts', () => {
    const body = renderComment(
      verdict({ ok: false, new: [key('a.test.ts', 's', 'one')], known: [key('b.test.ts', 's', 'two'), key('b.test.ts', 's', 'three')] }),
      NOW,
    )
    const opening = body.split('\n').slice(1, 6).join('\n')
    expect(opening).toContain('1 new failure')
    expect(opening).toContain('2 known failures')
    expect(opening.toLowerCase()).toContain('fail')
  })

  test('says passed when ok', () => {
    expect(renderComment(verdict(), NOW).toLowerCase()).toContain('pass')
  })

  test('has a section per non-empty label and none for empty ones', () => {
    const body = renderComment(
      verdict({
        ok: false,
        new: [key('a.test.ts', 's', 'new one')],
        known: [key('a.test.ts', 's', 'known one')],
        flaky: [key('a.test.ts', 's', 'flaky one')],
        fixed: [key('a.test.ts', 's', 'fixed one')],
        missing: [key('a.test.ts', 's', 'missing one')],
        incomplete: ['c.test.ts'],
        notOnCi: ['d.test.ts'],
      }),
      NOW,
    )
    for (const heading of ['New failures', 'Known failures', 'Flaky', 'Fixed', 'Missing', 'Incomplete', 'Not checked on CI']) {
      expect(body).toContain(`### ${heading}`)
    }
    for (const text of ['new one', 'known one', 'flaky one', 'fixed one', 'missing one', 'c.test.ts', 'd.test.ts']) {
      expect(body).toContain(text)
    }
    const empty = renderComment(verdict(), NOW)
    expect(empty).not.toContain('###')
  })

  test('names the baseline commit and age', () => {
    const body = renderComment(verdict(), NOW)
    expect(body).toContain('abcdef0')
    expect(body).toContain('3 hours')
  })

  test('ages in minutes, days and under a minute', () => {
    const at = (createdAt: string) => renderComment(verdict({ baseline: { commit: COMMIT, createdAt } }), NOW)
    expect(at('2026-10-30T11:59:30Z')).toContain('less than a minute')
    expect(at('2026-10-30T11:15:00Z')).toContain('45 minutes')
    expect(at('2026-10-28T12:00:00Z')).toContain('2 days')
    expect(at('2026-10-30T11:00:00Z')).toContain('1 hour')
    expect(at('2026-10-30T11:00:00Z')).not.toContain('1 hours')
  })

  test('says when no baseline was available', () => {
    const body = renderComment(verdict({ baseline: null }), NOW)
    expect(body.toLowerCase()).toContain('no baseline')
  })

  test('says no tests were needed when nothing was selected', () => {
    const body = renderComment(verdict({ selection: { mode: 'none', files: [], reasons: [] } }), NOW)
    expect(body.toLowerCase()).toContain('no tests were needed')
    expect(renderComment(verdict(), NOW).toLowerCase()).not.toContain('no tests were needed')
  })

  test('says a broken run cannot be trusted', () => {
    const body = renderComment(verdict({ ok: false, runBroken: true }), NOW)
    expect(body.toLowerCase()).toContain('run itself broke')
    expect(body.toLowerCase()).toContain("can't be trusted")
    expect(renderComment(verdict(), NOW).toLowerCase()).not.toContain('broke')
  })

  test('caps each section at 50 lines with a count of the rest', () => {
    const many = Array.from({ length: 120 }, (_, i) => key('a.test.ts', 's', `test ${i}`))
    const body = renderComment(verdict({ ok: false, new: many, known: many.slice(0, 51) }), NOW)
    expect(body).toContain('test 49')
    expect(body).not.toContain('test 50`')
    expect(body).toContain('70 more')
    expect(body).toContain('1 more')
    const lines = body.split('\n').filter((line) => line.startsWith('- '))
    expect(lines.length).toBe(50 + 50)
  })

  test('does not cap a section of exactly 50', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => key('a.test.ts', 's', `test ${i}`))
    const body = renderComment(verdict({ ok: false, new: fifty }), NOW)
    expect(body).not.toContain('more')
    expect(body).toContain('test 49')
  })

  test('uses no emoji', () => {
    const body = renderComment(verdict({ ok: false, runBroken: true, new: ['a.test.ts'], fixed: ['b.test.ts'] }), NOW)
    expect(body).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})
