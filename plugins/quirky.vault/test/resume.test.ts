import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { HISTORY_AGENTS } from '../src/agents'
import type { PublicListResult } from '../src/types'
import { writeEveryAgentFixture } from './fixtures/scanner-fixtures'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'

const PLUGIN_IDS = ['quirky.repo', 'quirky.cli', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.vault', 'quirky.ask']
const SOURCE_HOME_ENV = 'QUIRKY_VAULT_SOURCE_HOME'
const ENV_KEYS = ['HOME', 'QUIRKY_HOME', 'CODEX_HOME', SOURCE_HOME_ENV, 'QUIRKY_AGENT_SEARCH_DIRS'] as const
const COLLECTOR = `#!/bin/sh
{
  printf '%s\\n' "$PWD" "$HOME" "\${QUIRKY_HOME-}" "$PATH" "\${CODEX_HOME-}" "\${VAULT_LITERAL_ENV-}"
  printf '%s\\n' "$@"
} > "\${VAULT_CAPTURE_LOG}"
`

let harness: Harness | undefined
let temporaryRoot: string | undefined
let previousEnvironment: Map<string, string | undefined> | undefined

type PublicSession = PublicListResult['sessions'][number]
type PreparedResume = { command: string; env: Record<string, string | null> }
type AgentInfo = { resumable: boolean }
type CapturedInvocation = {
  cwd: string
  home: string
  quirkyHome: string
  path: string
  codexHome: string
  literalEnv: string
  argv: string[]
}

afterEach(async () => {
  try {
    await harness?.cleanup()
  } finally {
    harness = undefined
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
    if (previousEnvironment) {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    previousEnvironment = undefined
  }
})

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function snapshotTree(root: string): Promise<string[]> {
  const entries: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      const name = relative(root, path)
      if (item.isDirectory()) await visit(path)
      else if (item.isFile()) {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex')
        entries.push(`${name}:${digest}`)
      } else if (item.isSymbolicLink()) entries.push(`${name}:link:${await readlink(path)}`)
    }
  }
  await visit(root)
  return entries.sort()
}

async function runCopiedCommand(command: string, options: {
  cwd: string
  path: string
  home: string
  quirkyHome: string
}): Promise<void> {
  const child = Bun.spawn(['/bin/sh', '-c', command], {
    cwd: options.cwd,
    env: { PATH: options.path, HOME: options.home, QUIRKY_HOME: options.quirkyHome },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe'
  })
  let expired = false
  // Use wall-clock time because fake timers cannot kill a real operating-system child.
  const timeout = setTimeout(() => {
    expired = true
    child.kill()
  }, 5_000)
  let exitCode: number
  try {
    exitCode = await child.exited
  } finally {
    clearTimeout(timeout)
  }
  if (expired) throw new Error('copied resume command exceeded the 5-second child limit')
  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text()
    throw new Error(`copied resume command exited ${exitCode}: ${stderr}`)
  }
}

async function readCapturedInvocation(path: string): Promise<CapturedInvocation> {
  const fields = (await readFile(path, 'utf8')).split('\n')
  const [cwd, home, quirkyHome, searchPath, codexHome, literalEnv] = fields
  if (cwd === undefined || home === undefined || quirkyHome === undefined || searchPath === undefined || codexHome === undefined || literalEnv === undefined) {
    throw new Error(`collector output is incomplete: ${path}`)
  }
  return { cwd, home, quirkyHome, path: searchPath, codexHome, literalEnv, argv: fields.slice(6, -1) }
}

function requiredResumeArgs(agent: string, session: PublicSession): string[] {
  const id = session.sessionId
  const transcript = session.source.filePath
  switch (agent) {
    case 'codex': return ['resume', id]
    case 'rovo': return ['--restore', id]
    case 'opencode': case 'opencode2': case 'kimi': return ['--session', id]
    case 'pi': return ['--session', transcript ?? '']
    case 'copilot': return [`--resume=${id}`]
    case 'muse': return ['resume', id]
    case 'cline': return ['--id', id]
    case 'kiro': return ['--resume-id', id]
    case 'antigravity': return ['--conversation', id]
    case 'omp': case 'prime-agent': return ['--resume', transcript ?? '']
    default: return ['--resume', id]
  }
}

function hasSubsequence(actual: string[], expected: string[]): boolean {
  let next = 0
  for (const value of actual) if (value === expected[next]) next++
  return next === expected.length
}

describe('vault resume command consumer acceptance', () => {
  test('prepares and executes copied commands for all 25 real history sources through public APIs', async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'quirky-vault-resume-'))
    const root = temporaryRoot
    const home = join(root, 'quirky-home')
    const sourceHome = join(root, `source home #history with 'quote'; $HOME`)
    const cwdRoot = join(sourceHome, `owned working dirs with 'quote'; $HOME`)
    const userHome = join(root, 'restricted-user-home')
    const restrictedPath = join(root, 'empty-agent-path')
    for (const directory of [home, sourceHome, userHome, restrictedPath]) mkdirSync(directory, { recursive: true })

    previousEnvironment = new Map(ENV_KEYS.map((name) => [name, process.env[name]] as const))
    process.env.HOME = userHome
    process.env.QUIRKY_HOME = home
    process.env.CODEX_HOME = join(sourceHome, '.codex')
    process.env[SOURCE_HOME_ENV] = sourceHome
    process.env.QUIRKY_AGENT_SEARCH_DIRS = restrictedPath

    const fixture = await writeEveryAgentFixture(sourceHome, { cwdRoot })
    const sourceBefore = await snapshotTree(sourceHome)
    const agentHomeBefore = await snapshotTree(userHome)
    const injectionMarker = join(root, 'shell-injection-ran')
    const collectorPath = join(root, `owned collector's $HOME; inert`, 'capture')
    mkdirSync(dirname(collectorPath), { recursive: true })
    writeFileSync(collectorPath, COLLECTOR, { mode: 0o700 })

    const builtinPluginsDir = join(home, 'builtins')
    mkdirSync(builtinPluginsDir, { recursive: true })
    const pluginsRoot = join(import.meta.dir, '..', '..')
    for (const id of PLUGIN_IDS) symlinkSync(join(pluginsRoot, id), join(builtinPluginsDir, id), 'dir')
    harness = await startHarness({ home, builtinPluginsDir })
    const client = await harness.connect('cli')

    const failures: string[] = []
    const agentSettings = await client.callAny('quirky.agents/list', {}) as { workspaceTrust: boolean }
    if (agentSettings.workspaceTrust !== true) failures.push('isolated test setup did not enable workspace trust')
    const agentInfos = new Map<string, AgentInfo>()
    const configuredArgs = new Map<string, string>()
    const configuredEnv = new Map<string, string>()
    const capturePaths = new Map<string, string>()
    for (const agent of HISTORY_AGENTS) {
      const literalArgument = `configured-${agent}; : > ${injectionMarker}; 'quoted' $HOME`
      const literalEnv = `env-${agent}; : > ${injectionMarker}; 'quoted' $HOME`
      const capturePath = join(root, `${agent}.capture`)
      const args = `--vault-configured ${quotePosix(literalArgument)}`
      await client.callAny('quirky.agents/configure', {
        agent,
        command: quotePosix(collectorPath),
        args,
        env: { VAULT_CAPTURE_LOG: capturePath, VAULT_LITERAL_ENV: literalEnv }
      })
      configuredArgs.set(agent, literalArgument)
      configuredEnv.set(agent, literalEnv)
      capturePaths.set(agent, capturePath)
      agentInfos.set(agent, await client.callAny('quirky.agents/get', { agent }) as AgentInfo)
    }

    const listing = await client.callAny('quirky.vault/list', { host: 'local', unlimited: true }) as PublicListResult
    const sessions = new Map(listing.sessions.map((session) => [session.agent, session] as const))
    if (listing.sessions.length !== HISTORY_AGENTS.length) {
      failures.push(`expected ${HISTORY_AGENTS.length} history sources, found ${listing.sessions.length}`)
    }
    for (const agent of HISTORY_AGENTS) {
      if (!sessions.has(agent)) failures.push(`history source missing from public list: ${agent}`)
      if (agentInfos.get(agent)?.resumable !== true) failures.push(`catalog marks history source nonresumable: ${agent}`)
    }

    const prepared: { agent: string; session: PublicSession; plan: PreparedResume }[] = []
    for (const agent of HISTORY_AGENTS) {
      const session = sessions.get(agent)
      if (!session) continue
      const expectedCwd = fixture.expected[agent]?.cwd
      if (session.cwd !== expectedCwd) failures.push(`${agent}: source cwd ${String(session.cwd)} differs from fixture cwd ${String(expectedCwd)}`)
      try {
        const plan = await client.callAny('quirky.vault/prepareResume', { id: session.id }) as PreparedResume
        prepared.push({ agent, session, plan })
      } catch (error) {
        failures.push(`${agent}: prepareResume failed: ${errorMessage(error)}`)
      }
    }

    for (const item of prepared) {
      const { agent, session, plan } = item
      const logPath = capturePaths.get(agent)!
      try {
        await runCopiedCommand(plan.command, { cwd: root, path: restrictedPath, home: userHome, quirkyHome: home })
        const captured = await readCapturedInvocation(logPath)
        const argument = configuredArgs.get(agent)!
        const literalEnv = configuredEnv.get(agent)!
        const requiredArgs = requiredResumeArgs(agent, session)
        if (captured.cwd !== session.cwd) failures.push(`${agent}: copied command cwd ${captured.cwd} differs from source cwd ${String(session.cwd)}`)
        if (captured.home !== userHome || captured.quirkyHome !== home || captured.path !== restrictedPath) {
          failures.push(`${agent}: copied command escaped the isolated HOME/QUIRKY_HOME/PATH`)
        }
        if (captured.literalEnv !== literalEnv || plan.env.VAULT_LITERAL_ENV !== literalEnv) {
          failures.push(`${agent}: configured environment value was not preserved`)
        }
        if (!hasSubsequence(captured.argv, ['--vault-configured', argument])) {
          failures.push(`${agent}: configured literal arguments were not preserved`)
        }
        if (requiredArgs.includes('') || !hasSubsequence(captured.argv, requiredArgs)) {
          failures.push(`${agent}: expected resume identity sequence ${JSON.stringify(requiredArgs)}, received ${JSON.stringify(captured.argv)}`)
        }
        if ((agent === 'omp' || agent === 'prime-agent') && (!session.source.filePath || !isAbsolute(session.source.filePath))) {
          failures.push(`${agent}: source transcript path is not absolute`)
        }
        if (agent === 'codex') {
          const managedCodexHome = join(sourceHome, '.codex')
          if (captured.codexHome !== managedCodexHome || plan.env.CODEX_HOME !== managedCodexHome) {
            failures.push(`codex: managed CODEX_HOME ${captured.codexHome} differs from ${managedCodexHome}`)
          }
        }
      } catch (error) {
        failures.push(`${agent}: copied command execution failed: ${errorMessage(error)}`)
      }
    }

    if (existsSync(injectionMarker)) failures.push('configured metacharacters or apostrophes executed as shell syntax')
    if (JSON.stringify(await snapshotTree(sourceHome)) !== JSON.stringify(sourceBefore)) failures.push('source transcript originals changed during prepare/copy execution')
    if (JSON.stringify(await snapshotTree(userHome)) !== JSON.stringify(agentHomeBefore)) failures.push('prepareResume wrote agent trust/configuration files')
    expect(failures).toEqual([])
  })
})
