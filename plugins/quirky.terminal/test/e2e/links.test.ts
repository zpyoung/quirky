import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SCENARIO_MS, cleanupAll, fails, startE2e } from './support'

const logDirs: string[] = []
afterEach(async () => {
  await cleanupAll()
  for (const dir of logDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const lines = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { target: string; reveal: boolean })
    : []

test(
  'SC-41: `open-link` opens a URL or path through the logged opener and refuses other targets',
  async () => {
    const dir = mkdtempSync('/tmp/ql-')
    logDirs.push(dir)
    const log = join(dir, 'open.log')
    const h = await startE2e({ env: { QUIRKY_TEST_OPEN_LOG: log } })
    const file = join(h.repo, 'src', 'app.ts')

    expect(await h.ok(['terminal', 'open-link', 'https://example.com/x'])).toBe('opened https://example.com/x\n')
    expect(await h.ok(['terminal', 'open-link', file])).toBe(`opened ${file}\n`)
    expect(await h.ok(['terminal', 'open-link', file, '--reveal'])).toBe(`revealed ${file}\n`)
    await h.ok(['terminal', 'open-link', 'mailto:someone@example.com'])
    expect(await h.json<{ ok: boolean }>(['terminal', 'open-link', 'http://example.com/docs'])).toEqual({ ok: true })
    expect(lines(log)).toEqual([
      { target: 'https://example.com/x', reveal: false },
      { target: file, reveal: false },
      { target: file, reveal: true },
      { target: 'mailto:someone@example.com', reveal: false },
      { target: 'http://example.com/docs', reveal: false }
    ])

    for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/x', 'src/app.ts', 'https://example.com/\u0007x']) {
      const refused = await fails(h, ['terminal', 'open-link', target])
      expect(refused.code, target).toBe(1)
      expect(refused.stderr, target).toMatch(/^quirky: (only http, https and mailto links can be opened|target must be an http|target contains control characters)/)
    }
    expect(lines(log)).toHaveLength(5)
  },
  SCENARIO_MS
)
