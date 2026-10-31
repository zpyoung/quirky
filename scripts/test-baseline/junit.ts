import type { TestResult, TestStatus } from './types'

const TESTCASE = /<testcase\b((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(ENTITY, (_, decimal, hex, named) =>
    named ? NAMED[named] : String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16))
  )
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of source.matchAll(ATTRIBUTE)) found[match[1]] = decode(match[2] ?? match[3])
  return found
}

function statusOf(body: string): TestStatus {
  if (/<(failure|error)\b/.test(body)) return 'failed'
  return /<skipped\b/.test(body) ? 'skipped' : 'passed'
}

/**
 * The per-test results in one JUnit report, in report order. Each key is `<file>\0<classname>\0<name>`
 * with the XML entities decoded, and `#2`, `#3` appended to a key that repeats within the report. Every
 * result in one report gets a distinct key, even when a test is literally named like a suffixed repeat. Suite
 * nesting doesn't matter, because every `<testcase>` carries its describes in `classname`. Empty or
 * test-less input gives `[]`. `file` is the path the caller ran, not the report's own `file` attribute.
 */
export function parseJunit(xml: string, file: string): TestResult[] {
  const results: TestResult[] = []
  const seen = new Map<string, number>()
  const used = new Set<string>()
  TESTCASE.lastIndex = 0
  for (let match = TESTCASE.exec(xml); match; match = TESTCASE.exec(xml)) {
    let body = ''
    if (!match[2]) {
      const close = xml.indexOf('</testcase>', TESTCASE.lastIndex)
      const end = close === -1 ? xml.length : close
      body = xml.slice(TESTCASE.lastIndex, end)
      TESTCASE.lastIndex = end
    }
    const { name = '', classname = '' } = attributes(match[1])
    const base = [file, classname, name].join('\0')
    let count = (seen.get(base) ?? 0) + 1
    let key = count === 1 ? base : `${base}#${count}`
    while (used.has(key)) key = `${base}#${++count}`
    seen.set(base, count)
    used.add(key)
    results.push({ key, status: statusOf(body) })
  }
  return results
}
