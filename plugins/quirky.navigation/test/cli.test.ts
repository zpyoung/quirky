import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'

let harness: Harness | undefined
let client: QuirkyClient | undefined
let tempRoot: string | undefined
let savedEnv: Map<string, string | undefined> | undefined
const trackedPids = new Set<number>()
const ISOLATED_ENV_KEYS = ['HOME', 'QUIRKY_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_HOME', 'OPENAI_HOME']

type NavigationStatus = { servers?: { pid: number | null }[] }

type CliOptions = { home: string; cwd: string; env: Record<string, string> }

function isolateEnvironment(): void {
  savedEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]))
  tempRoot = join(tmpdir(), `quirky-navigation-${process.pid}-${randomUUID()}`)
  mkdirSync(tempRoot, { recursive: true })
  process.env.HOME = tempRoot
  process.env.QUIRKY_HOME = join(tempRoot, '.quirky')
  for (const key of ISOLATED_ENV_KEYS.slice(2)) delete process.env[key]
}

async function start(): Promise<{ client: QuirkyClient; home: string; root: string }> {
  isolateEnvironment()
  const home = process.env.QUIRKY_HOME!
  harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  client = await harness.connect()
  return { client, home, root: tempRoot! }
}

function call<T>(activeClient: QuirkyClient, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return activeClient.callAny(method, params) as Promise<T>
}

function rememberServerPids(status: NavigationStatus): void {
  for (const server of status.servers ?? []) {
    if (typeof server.pid === 'number') trackedPids.add(server.pid)
  }
}

function cleanupEnvironment(): void {
  for (const [key, value] of savedEnv ?? []) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv = undefined
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = undefined
}

afterEach(async () => {
  try {
    if (client) {
      try {
        rememberServerPids(await call<NavigationStatus>(client, 'quirky.navigation/status'))
      } catch {
        // The method may be unavailable if harness startup failed.
      }
    }
    await harness?.cleanup()
  } finally {
    harness = undefined
    client = undefined
    for (const pid of trackedPids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* The server has already exited. */ }
    }
    trackedPids.clear()
    cleanupEnvironment()
  }
})

describe('quirky.navigation CLI', () => {
  test('answers definitions and references from the worktree cwd', async () => {
    const { client: daemonClient, home, root } = await start()
    const fixture = join(import.meta.dir, 'fixtures', 'ts')
    const workspace = join(root, 'nav ts é')
    cpSync(fixture, workspace, { recursive: true })
    await call(daemonClient, 'quirky.repo/add', { path: workspace, folder: true })
    const worktree = await call<{ id: string; path: string }>(daemonClient, 'quirky.worktree/resolve', {
      selector: 'current',
      cwd: workspace
    })
    const worktreePath = realpathSync(worktree.path)
    const greetPath = join(worktreePath, 'src', 'greet.ts')
    const cliOptions: CliOptions = {
      home,
      cwd: workspace,
      env: { HOME: root, QUIRKY_HOME: home }
    }

    const definition = await runCli([
      'nav', 'definition', 'src/use.ts', '--line', '4', '--column', '27', '--json'
    ], cliOptions)
    expect(definition.code).toBe(0)
    expect(JSON.parse(definition.stdout)).toEqual({
      worktreeId: worktree.id,
      language: 'typescript',
      truncated: false,
      locations: [{
        path: greetPath,
        relativePath: 'src/greet.ts',
        line: 3,
        column: 17,
        endLine: 3,
        endColumn: 22,
        preview: 'export function greet(name: Name): string {'
      }]
    })

    const references = await runCli([
      'navigation', 'references', 'src/use.ts', '--line', '4', '--column', '27', '--json'
    ], cliOptions)
    expect(references.code).toBe(0)
    expect(JSON.parse(references.stdout)).toEqual({
      worktreeId: worktree.id,
      language: 'typescript',
      truncated: false,
      locations: [
        {
          path: greetPath,
          relativePath: 'src/greet.ts',
          line: 3,
          column: 17,
          endLine: 3,
          endColumn: 22,
          preview: 'export function greet(name: Name): string {'
        },
        {
          path: greetPath,
          relativePath: 'src/greet.ts',
          line: 11,
          column: 30,
          endLine: 11,
          endColumn: 35,
          preview: '    return `${this.prefix} ${greet(name)}`'
        },
        {
          path: join(worktreePath, 'src', 'index.ts'),
          relativePath: 'src/index.ts',
          line: 1,
          column: 10,
          endLine: 1,
          endColumn: 15,
          preview: "export { greet, Greeter } from './greet'"
        },
        {
          path: join(worktreePath, 'src', 'use.ts'),
          relativePath: 'src/use.ts',
          line: 1,
          column: 10,
          endLine: 1,
          endColumn: 15,
          preview: "import { greet, Greeter, type Name } from './index'"
        },
        {
          path: join(worktreePath, 'src', 'use.ts'),
          relativePath: 'src/use.ts',
          line: 4,
          column: 27,
          endLine: 4,
          endColumn: 32,
          preview: "const label = 'héllo 🙂'; greet(who)"
        },
        {
          path: join(worktreePath, 'src', 'use.ts'),
          relativePath: 'src/use.ts',
          line: 7,
          column: 23,
          endLine: 7,
          endColumn: 28,
          preview: 'export const twice = [greet(label), greeter.hello(label)]'
        }
      ]
    })

    const status = await runCli(['nav', 'status', '--json'], cliOptions)
    expect(status.code).toBe(0)
    const statusJson = JSON.parse(status.stdout) as NavigationStatus
    expect(Array.isArray(statusJson.servers)).toBe(true)
    rememberServerPids(statusJson)

    const missingLine = await runCli([
      'nav', 'definition', 'src/use.ts', '--column', '27', '--json'
    ], cliOptions)
    expect(missingLine.code).toBe(2)

    const plain = await runCli([
      'nav', 'definition', 'src/use.ts', '--line', '4', '--column', '27'
    ], cliOptions)
    expect(plain.code).toBe(0)
    expect(plain.stdout).toContain('src/greet.ts')
  }, 60000)
})
