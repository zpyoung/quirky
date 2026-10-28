import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

async function runBrowserCli(h: BrowserTestHarness, argv: string[]) {
  let stdout = ''
  let stderr = ''
  const client = await h.daemon.connect('cli')
  const code = await run({
    argv,
    env: { QUIRKY_HOME: h.home },
    cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, { yes: argv.includes('--yes') }),
    openDesktopApp: async () => ({ ok: false, reason: 'not used by Browser extras CLI tests' })
  })
  return { code, stdout, stderr }
}

const call = (h: BrowserTestHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${method}`, params)

test('CLI keeps @file text literal and reads large fill values only through explicit file mode', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await call(h, 'tabCreate', { url: `${h.fixtureUrl}events` }) as { browserPageId: string }
    const listed = await runBrowserCli(h, ['browser', 'tab', 'list', '--worktree', 'all', '--show-profile', '--json'])
    expect(listed.code).toBe(0)
    const listResult = JSON.parse(listed.stdout) as { tabs: Array<{ browserPageId: string; profileLabel: string | null }> }
    expect(listResult.tabs).toContainEqual(expect.objectContaining({ browserPageId: page.browserPageId, profileLabel: 'Default' }))

    const literalFile = join(h.home, 'literal source.txt')
    const literal = `@file:${literalFile}`
    writeFileSync(literalFile, 'must not be read implicitly')

    const literalResult = await runBrowserCli(h, ['browser', 'fill', '--page', page.browserPageId, '--element', '#text', '--value', literal, '--json'])
    expect(literalResult.code).toBe(0)
    expect(await call(h, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: literal })

    const largeValue = `${'private-cookie-free text '.repeat(450)}🧪 end`
    const valueFile = join(h.home, 'large text.txt')
    writeFileSync(valueFile, largeValue)
    const fileResult = await runBrowserCli(h, ['browser', 'fill', '--page', page.browserPageId, '--element', '#text', '--value-file', valueFile, '--json'])
    expect(fileResult.code).toBe(0)
    expect(await call(h, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: largeValue })

    const conflict = await runBrowserCli(h, ['browser', 'fill', '--page', page.browserPageId, '--element', '#text', '--value', 'inline', '--value-file', valueFile, '--json'])
    expect(conflict.code).toBe(2)
    expect(await call(h, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: largeValue })
  } finally { await h.cleanup() }
}, 90_000)

test('file import uses an explicit --file source and the dispatcher confirmation path', async () => {
  const h = await startBrowserHarness()
  try {
    const source = join(h.home, 'selected-cookies.json')
    writeFileSync(source, JSON.stringify([{
      name: 'session', value: 'fixture-only', domain: 'example.test', path: '/', secure: false, httpOnly: false, hostOnly: true
    }]))
    const imported = await runBrowserCli(h, ['browser', 'import', 'file', '--file', source, '--profile', 'default', '--yes', '--json'])
    expect(imported.code).toBe(0)
    expect(JSON.parse(imported.stdout)).toMatchObject({ totalCookies: 1, importedCookies: 1, domains: ['example.test'] })

    const started = await runBrowserCli(h, ['browser', 'import', 'start', '--file', source, '--profile', 'default', '--yes', '--json'])
    expect(started.code).toBe(0)
    const startedResult = JSON.parse(started.stdout) as { id: string }
    const jobId = startedResult.id
    const job = await runBrowserCli(h, ['browser', 'import', 'get', '--id', jobId, '--json'])
    expect(job.code).toBe(0)
    expect(JSON.parse(job.stdout)).toMatchObject({ id: jobId, profileId: 'default' })
    const listed = await runBrowserCli(h, ['browser', 'import', 'list', '--profile', 'default', '--json'])
    expect(listed.code).toBe(0)
    const listedResult = JSON.parse(listed.stdout) as { jobs: Array<{ id: string }> }
    expect(listedResult.jobs.map(({ id }) => id)).toContain(jobId)
  } finally { await h.cleanup() }
}, 90_000)
