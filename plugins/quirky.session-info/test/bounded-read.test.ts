import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { MAX_CONFIG_BYTES, readBoundedConfig } from '../src/bounded-read'

type Fixture = { root: string; home: string; scope: ProcessScope }
const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.scope.cleanup()
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'quirky-bounded-read-'))
  const home = join(root, 'home')
  const quirkyHome = join(root, 'quirky-home')
  mkdirSync(home)
  mkdirSync(quirkyHome)
  const fixture = { root, home, scope: createProcessScope(quirkyHome) }
  fixtures.push(fixture)
  return fixture
}

function jsonAtLimit(): string {
  const prefix = '{"padding":"'
  const suffix = '"}'
  return `${prefix}${'x'.repeat(MAX_CONFIG_BYTES - prefix.length - suffix.length)}${suffix}`
}

test('reads a regular config file at the 4 MiB limit', async () => {
  const fixture = makeFixture()
  const path = join(fixture.root, 'at-limit.json')
  const contents = jsonAtLimit()
  writeFileSync(path, contents)

  const read = await readBoundedConfig(path)

  expect(read.byteLength).toBe(MAX_CONFIG_BYTES)
  expect(read.toString('utf8')).toBe(contents)
})

test('rejects a config file over 4 MiB with a visible size error', async () => {
  const fixture = makeFixture()
  const path = join(fixture.root, 'over-limit.json')
  writeFileSync(path, `${jsonAtLimit()} `)

  await expect(readBoundedConfig(path)).rejects.toThrow(`exceeds ${MAX_CONFIG_BYTES} bytes`)
})

test('follows a symlink to a regular config file', async () => {
  const fixture = makeFixture()
  const target = join(fixture.root, 'target.json')
  const link = join(fixture.root, 'config.json')
  const contents = '{"linked":true}'
  writeFileSync(target, contents)
  symlinkSync(target, link)

  expect((await readBoundedConfig(link)).toString('utf8')).toBe(contents)
})

test('rejects a FIFO promptly without blocking the test worker', async () => {
  const fixture = makeFixture()
  const path = join(fixture.root, 'settings.fifo')
  const mkfifo = fixture.scope.spawn(['/usr/bin/mkfifo', path], {
    env: { HOME: fixture.home, PATH: '/usr/bin:/bin' },
    stdout: 'ignore',
    stderr: 'ignore'
  })
  expect(await mkfifo.exited).toBe(0)

  const modulePath = join(import.meta.dir, '../src/bounded-read.ts')
  const script = `import { readBoundedConfig } from ${JSON.stringify(modulePath)}; try { await readBoundedConfig(${JSON.stringify(path)}); process.exitCode = 3 } catch (error) { if (error instanceof Error && error.message.includes('regular file')) console.log('REJECTED'); else { console.error(error); process.exitCode = 1 } }`
  const reader = fixture.scope.spawn([process.execPath, '-e', script], {
    env: { HOME: fixture.home, PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe'
  })

  // A child-process timeout isolates a regression that could block while opening or reading a FIFO.
  const timeout = Promise.withResolvers<never>()
  const timeoutTimer = setTimeout(() => timeout.reject(new Error('bounded config reader blocked on a FIFO')), 1_000)
  try {
    const outcome = await Promise.race([
      (async () => ({ code: await reader.exited, stdout: await new Response(reader.stdout).text() }))(),
      timeout.promise
    ])
    expect(outcome).toEqual({ code: 0, stdout: 'REJECTED\n' })
  } finally {
    clearTimeout(timeoutTimer)
  }
})
