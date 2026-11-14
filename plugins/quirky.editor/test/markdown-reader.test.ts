import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import type { EditorOpenResult } from '../src/types'

type Fixture = {
  harness: Harness
  client: QuirkyClient
  home: string
  root: string
  worktreeId: string
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>
}
type CliResult = { code: number; stdout: string; stderr: string }

const CLI_ENTRY = fileURLToPath(new URL('../../../packages/cli/src/main.ts', import.meta.url))
const fixtures = new Set<Fixture>()

afterEach(async () => {
  const pending = [...fixtures]
  fixtures.clear()
  const failures: unknown[] = []
  for (const fixture of pending) {
    try {
      await fixture.harness.cleanup()
    } catch (error) {
      failures.push(error)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Editor acceptance fixture cleanup failed')
})

async function boot(): Promise<Fixture> {
  const home = makeHomeWithoutAutoHooks('quirky-editor-markdown-reader-')
  const root = mkdtempSync(join(tmpdir(), 'quirky-editor-markdown-repo-'))
  let harness: Harness | undefined
  try {
    const git = spawnSync('git', ['init', '-q'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        QUIRKY_HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`)
    harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
    const client = await harness.connect('cli', 'editor-markdown-reader-test')
    const call = <T>(method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>
    await call('quirky.repo/add', { path: root })
    const worktree = await call<{ id: string }>('quirky.worktree/resolve', { selector: `path:${root}` })
    const fixture: Fixture = { harness, client, home, root, worktreeId: worktree.id, call }
    fixtures.add(fixture)
    return fixture
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

function writeFixture(fixture: Fixture, path: string, text: string): string {
  const absolute = join(fixture.root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text)
  return absolute
}

async function runCli(fixture: Fixture, args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI_ENTRY, '--json', ...args], {
    cwd: fixture.root,
    env: { PATH: process.env.PATH ?? '', HOME: fixture.home, QUIRKY_HOME: fixture.home },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const { promise: deadline, reject } = Promise.withResolvers<never>()
  const timeout = setTimeout(() => {
    child.kill()
    reject(new Error(`CLI command timed out: ${args.join(' ')}`))
  }, 15_000)
  try {
    const completed = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }))
    const result = await Promise.race([completed, deadline])
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}

function runEditorCli(fixture: Fixture, method: string, params: Record<string, unknown>): Promise<CliResult> {
  const positionals = method === 'open' && typeof params.path === 'string' ? [params.path] : []
  const flags = Object.entries(params)
    .filter(([name]) => !(method === 'open' && name === 'path'))
    .map(([name, value]) => {
      const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      const encoded = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
      return `--${flag}=${encoded}`
    })
  return runCli(fixture, ['editor', method, ...positionals, ...flags])
}

function cliJson<T>(result: CliResult): T {
  if (result.code !== 0) throw new Error(`CLI exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

test('the editor CLI opens a Markdown document in preview mode and reads its rendered headings, table, TOC and exact text', async () => {
  const fixture = await boot()
  const content = '# Project notes\n\nIntro with **bold** text.\n\n## Tasks\n\n| Item | State |\n| --- | --- |\n| parser | done |\n\n[spec](https://example.test/spec)\n\n<script>alert(1)</script>\n'
  writeFixture(fixture, 'docs/notes.md', content)

  const opened = cliJson<EditorOpenResult>(await runEditorCli(fixture, 'open', {
    path: 'docs/notes.md',
    worktree: fixture.worktreeId,
    mode: 'preview',
    focus: false
  }))
  expect(opened).toMatchObject({ relativePath: 'docs/notes.md', mode: 'preview', content })

  const capabilities = cliJson<{ previewAvailable: boolean; previewHtml: string }>(await runEditorCli(fixture, 'markdown', {
    bufferId: opened.id,
    action: 'capabilities',
    includePreview: true
  }))
  expect(capabilities.previewAvailable).toBe(true)
  expect(capabilities.previewHtml).toMatch(/<h1\b[^>]*>Project notes<\/h1>/)
  expect(capabilities.previewHtml).toMatch(/<h2\b[^>]*>Tasks<\/h2>/)
  expect(capabilities.previewHtml).toContain('<table')
  expect(capabilities.previewHtml).toContain('<strong>bold</strong>')
  expect(capabilities.previewHtml).toContain('parser')
  expect(capabilities.previewHtml).not.toMatch(/<script|javascript:|alert\(1\)/i)

  const toc = cliJson<{ count: number; headings: { text: string; level: number }[] }>(await runEditorCli(fixture, 'markdown', {
    bufferId: opened.id,
    action: 'toc'
  }))
  expect(toc).toMatchObject({
    count: 2,
    headings: [
      { text: 'Project notes', level: 1 },
      { text: 'Tasks', level: 2 }
    ]
  })

  const read = cliJson<{ text: string }>(await runEditorCli(fixture, 'read', {
    bufferId: opened.id,
    action: 'text',
    kind: 'content',
    offset: 0,
    contentRevision: opened.contentRevision
  }))
  expect(read.text).toBe(content)

  const missing = await runEditorCli(fixture, 'open', {
    path: 'docs/missing.md',
    worktree: fixture.worktreeId,
    mode: 'preview'
  })
  expect(missing.code).not.toBe(0)
  expect(existsSync(join(fixture.root, 'docs/missing.md'))).toBe(false)
})
