import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RULES_DIR = join(import.meta.dir, '..', 'src', 'rules')
const NETWORK_MODULES = ['http', 'https', 'net', 'dns', 'tls', 'http2', 'dgram']

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('rules never touch the network', () => {
  const files = readdirSync(RULES_DIR).filter((name) => name.endsWith('.ts'))

  test('the rules directory has the modules this test is meant to watch', () => {
    expect(files).toEqual(expect.arrayContaining(['format.ts', 'match.ts', 'safety.ts', 'sources.ts', 'matcher.ts', 'matcher-worker.ts']))
  })

  for (const file of files) {
    test(`SC-13: ${file} imports no network module and calls no fetch`, () => {
      const code = stripComments(readFileSync(join(RULES_DIR, file), 'utf8'))
      for (const name of NETWORK_MODULES) {
        expect(code).not.toMatch(new RegExp(`['"](?:node:)?${name}['"]`))
      }
      expect(code).not.toMatch(/\bfetch\s*\(/)
      expect(code).not.toMatch(/\bWebSocket\b|\bXMLHttpRequest\b|\bBun\.connect\b|\bBun\.listen\b|\bBun\.serve\b/)
    })
  }
})
