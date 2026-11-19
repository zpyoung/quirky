import { expect, test } from 'bun:test'
import { NATIVE_BROWSER_NAVIGATION_RULES } from '../src/native-browser'

test('native browser rules let iframes load srcdoc, data: and blob: without allowing them top-level', () => {
  const rules: readonly string[] = NATIVE_BROWSER_NAVIGATION_RULES
  expect(rules[0]).toBe('^*')
  expect(rules).toEqual(expect.arrayContaining(['frame:about:srcdoc', 'frame:data:*', 'frame:blob:*']))
  expect(rules.filter((rule) => /^(about:srcdoc|data:|blob:)/.test(rule))).toEqual([])
})
