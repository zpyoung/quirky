import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { readRuntime, rpcUrl } from '@quirky/protocol/node'
import { startAgentsE2E, type E2E, type FakeBehavior } from '../../../quirky.agents/test/support/e2e'
import { writePlugin } from '../../../../packages/daemon/test/plugins/fixtures'
import type { CliResult } from '../fixture'

const PLUGINS_DIR = resolve(import.meta.dir, '../../../..', 'plugins')
const ORCHESTRATION_DB = (home: string) => join(home, 'plugin-data', 'quirky.orchestration', 'store.db')
const CLIENT_IDS = ['acme.orchestration-a', 'acme.orchestration-b'] as const
const CLI_MAIN = resolve(import.meta.dir, '../../../../packages/cli/src/main.ts')
const AGENT_FIXTURE = resolve(import.meta.dir, '../workers/acceptance-agent.ts')

export type ServiceClientId = 'a' | 'b'
export type ServiceE2E = E2E & {
  eventClient: QuirkyClient
  events: QuirkyEvent[]
  fixtureDir: string
  cleanup(): Promise<void>
}

function fixtureSource(id: string): string {
  return `import type { PluginContext } from '@quirky/protocol'\n` +
    `export function activate(context: PluginContext): void {\n` +
    `  context.provide('method:${id}/call', (value: unknown) => {\n` +
    `    if (typeof value !== 'object' || value === null || Array.isArray(value) || !('method' in value) || typeof value.method !== 'string') {\n` +
    `      throw context.error('invalid-params', 'method is required')\n` +
    `    }\n` +
    `    const input = 'params' in value && typeof value.params === 'object' && value.params !== null && !Array.isArray(value.params)\n` +
    `      ? value.params as Record<string, unknown> : {}\n` +
    `    return context.call('quirky.orchestration/' + value.method, input)\n` +
    `  })\n` +
    `}\n`
}

function createFixturePlugin(root: string, id: string): void {
  writePlugin(root, {
    id,
    name: `Orchestration service fixture ${id.slice(-1)}`,
    version: '1.0.0',
    main: 'main.ts',
    dependencies: ['quirky.orchestration'],
    contributes: {
      method: [{
        id: 'call',
        params: {
          type: 'object',
          required: ['method'],
          properties: {
            method: { type: 'string' },
            params: { type: 'object', additionalProperties: true }
          },
          additionalProperties: false
        }
      }]
    }
  }, { 'main.ts': fixtureSource(id) })
}

function pluginDependencies(pluginId: string): string[] {
  const manifestPath = join(PLUGINS_DIR, pluginId, 'quirky-plugin.json')
  if (!existsSync(manifestPath)) throw new Error(`required test plugin ${pluginId} has no manifest`)
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest) || !('dependencies' in manifest)) return []
  const dependencies = manifest.dependencies
  if (dependencies === undefined) return []
  if (!Array.isArray(dependencies) || !dependencies.every((dependency) => typeof dependency === 'string')) {
    throw new Error(`plugin ${pluginId} has an invalid dependencies list`)
  }
  return dependencies
}

function linkPlugin(root: string, pluginId: string, linked: Set<string>): void {
  if (linked.has(pluginId)) return
  const source = join(PLUGINS_DIR, pluginId)
  if (!existsSync(join(source, 'quirky-plugin.json'))) throw new Error(`required test plugin ${pluginId} is unavailable`)
  symlinkSync(source, join(root, pluginId), 'dir')
  linked.add(pluginId)
  for (const dependency of pluginDependencies(pluginId)) linkPlugin(root, dependency, linked)
}

function createFixturePluginsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-orchestration-service-fixtures-'))
  const linked = new Set<string>()
  for (const pluginId of ['quirky.orchestration', 'quirky.agents', 'quirky.repo']) linkPlugin(root, pluginId, linked)
  for (const id of CLIENT_IDS) createFixturePlugin(root, id)
  return root
}
function inputDrivenAgentSource(cliMain: string, args?: readonly string[]): string {
  const base = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
if (process.argv.includes('--version')) { console.log('1.0.0 (isolated orchestration fixture)'); process.exit(0) }
process.env.WORKER_TEST_CLI = ${JSON.stringify(cliMain)}
process.stdout.write('\\x1b[?2004h')
// This side-effect fixture must initialize after its per-child CLI env and terminal mode; static imports are hoisted.
await import(${JSON.stringify(AGENT_FIXTURE)})
`
  if (!args) return base
  const command = args.includes('--json') ? [...args] : [...args, '--json']
  return base + `
const root = join(process.env.QUIRKY_HOME, 'worker-fixture')
const session = process.env.QUIRKY_SESSION_ID
const events = join(root, session + '.events.jsonl')
const timer = setInterval(() => {
  if (!existsSync(events)) return
  const started = readFileSync(events, 'utf8').split('\\n').filter(Boolean).some((line) => JSON.parse(line).type === 'turn_started')
  if (!started) return
  clearInterval(timer)
  appendFileSync(join(root, session + '.requests.jsonl'), JSON.stringify({ id: crypto.randomUUID(), args: ${JSON.stringify(command)} }) + '\\n')
}, 20)
`
}


export async function startServicesE2E(options: { fakes?: Record<string, FakeBehavior | true> } = {}): Promise<ServiceE2E> {
  const fixtureDir = createFixturePluginsDir()
  let harness: E2E | undefined
  let eventClient: QuirkyClient | undefined
  try {
    harness = await startAgentsE2E({
      fakes: { claude: true, ...options.fakes },
      extraEnv: { QUIRKY_BUILTIN_PLUGINS_DIR: fixtureDir, WORKER_TEST_CLI: CLI_MAIN }
    })
    if (options.fakes?.claude === undefined) {
      const path = join(harness.fakebin, 'claude')
      writeFileSync(path, inputDrivenAgentSource(CLI_MAIN))
      chmodSync(path, 0o755)
    }
    const plugins = await harness.client.call('plugin.list', {})
    const invalid = plugins.filter((plugin) =>
      (plugin.id === 'quirky.orchestration' || CLIENT_IDS.some((id) => id === plugin.id)) &&
      (plugin.state === 'invalid' || plugin.state === 'failed' || plugin.state === 'disabled'))
    if (invalid.length > 0) {
      throw new Error(`service fixture dependency is not executable: ${JSON.stringify(invalid.map(({ id, state, diagnostics }) => ({ id, state, diagnostics })))}`)
    }
    const runtime = readRuntime(harness.home)
    if (!runtime) throw new Error('the service test daemon did not publish its runtime information')
    eventClient = await QuirkyClient.connect(rpcUrl(runtime), { role: 'ui', name: 'orchestration-service-events' })
    const events: QuirkyEvent[] = []
    eventClient.onEvent((event) => events.push(event))
    await eventClient.call('events.subscribe', {})
    let cleanupPromise: Promise<void> | undefined
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        try {
          eventClient?.close()
        } finally {
          eventClient = undefined
          try {
            await harness?.cleanup()
          } finally {
            harness = undefined
            rmSync(fixtureDir, { recursive: true, force: true })
          }
        }
      })()
      return cleanupPromise
    }
    return { ...harness, eventClient, events, fixtureDir, cleanup }
  } catch (error) {
    eventClient?.close()
    try {
      await harness?.cleanup()
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
    throw error
  }
}

export async function callAs(
  harness: ServiceE2E,
  client: ServiceClientId,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return harness.call(`acme.orchestration-${client}/call`, { method, params })
}

export async function failureOf(promise: Promise<unknown>): Promise<string | null> {
  const error = await promise.then(() => null, (cause: unknown) => cause)
  if (error === null) return null
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}

export function openOrchestrationDb(harness: ServiceE2E): Database {
  return new Database(ORCHESTRATION_DB(harness.home))
}

export function installAgentCli(harness: ServiceE2E, cliMain: string, args: readonly string[]): void {
  const source = inputDrivenAgentSource(cliMain, args)
  const path = join(harness.fakebin, 'claude')
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

export async function runAgentCli(harness: ServiceE2E, sessionId: string, args: readonly string[]): Promise<CliResult> {
  const id = randomUUID()
  const root = join(harness.home, 'worker-fixture')
  const path = join(root, `${id}.reply.json`)
  appendFileSync(join(root, `${sessionId}.requests.jsonl`), JSON.stringify({
    id,
    args: args.includes('--json') ? args : [...args, '--json']
  }) + '\n')
  const value: unknown = await waitFor(() => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null,
    30_000, 'actual provider CLI reply')
  if (typeof value !== 'object' || value === null ||
    !('code' in value) || typeof value.code !== 'number' ||
    !('stdout' in value) || typeof value.stdout !== 'string' ||
    !('stderr' in value) || typeof value.stderr !== 'string') {
    throw new Error('the actual provider CLI returned an invalid result')
  }
  return { code: value.code, stdout: value.stdout, stderr: value.stderr }
}

export async function waitFor<T>(
  check: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
  description = 'condition'
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    // A real daemon child and PTY emit through sockets; fake timers cannot drive their state changes.
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${description}`)
}

export function requestId(): string {
  return randomUUID()
}
