import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { DispatchRow, RunRow, TaskRow } from '../src/contracts'
import type { SessionIdentity } from '../src/runtime-contracts'
import { buildWorkerPreamble } from '../src/workers/preamble'
import { startOrchestrationFixture, mutation, type CliResult, type OrchestrationFixture, type OrchestrationParty } from './fixture'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'

const CLI_MAIN = resolve(import.meta.dir, '../../../packages/cli/src/main.ts')
const TARGET_OVERRIDE_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'GROK_HOME',
  'HERMES_HOME',
  'VIBE_HOME',
  'AUTOHAND_HOME',
  'GEMINI_CLI_HOME',
  'AGENTS_HOME',
  'APPDATA',
  'FLATPAK_XDG_CONFIG_HOME',
  'OPENCODE_CONFIG_DIR',
  'MIMOCODE_HOME',
  'PI_CODING_AGENT_DIR',
  'PRIME_AGENT_CODING_AGENT_DIR',
]
let fixture: OrchestrationFixture
let previousTargetOverrides = new Map<string, string | undefined>()

function restoreTargetOverrides(): void {
  for (const [key, value] of previousTargetOverrides) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  previousTargetOverrides.clear()
}

beforeEach(async () => {
  previousTargetOverrides = new Map<string, string | undefined>(TARGET_OVERRIDE_KEYS.map((key) => [key, process.env[key]] as const))
  for (const key of TARGET_OVERRIDE_KEYS) delete process.env[key]
  try {
    fixture = await startOrchestrationFixture()
    process.env.XDG_CONFIG_HOME = join(fixture.userHome, '.config')
  } catch (error) {
    restoreTargetOverrides()
    throw error
  }
})
afterEach(async () => {
  try {
    await fixture?.cleanup()
  } finally {
    restoreTargetOverrides()
    fixture = undefined!
  }
})

async function unboundCli(args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
    cwd: fixture.root,
    stdin: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: fixture.userHome,
      QUIRKY_HOME: fixture.home
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  // Bound a hung CLI child so fixture cleanup can always stop its private daemon and homes.
  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM') } catch {}
  }, 30_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
    try { child.kill('SIGTERM') } catch {}
    await child.exited.catch(() => undefined)
  }
}

function cliJson<T>(result: CliResult): T {
  if (result.code !== 0) throw new Error(`quirky exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

async function api<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return fixture.setupClient.callAny(method, params) as Promise<T>
}
function assertPrivateTargets(status: { agents: { id: string; path: string | null }[] }): void {
  const homePrefix = `${resolve(fixture.userHome)}${sep}`
  for (const agent of status.agents) {
    if (agent.path === null) continue
    expect(resolve(agent.path).startsWith(homePrefix), `${agent.id} target escaped the private HOME: ${agent.path}`).toBe(true)
  }
}


function agentState(status: { agents: { id: string; state: string }[] }, id: string) {
  const agent = status.agents.find((entry) => entry.id === id)
  if (!agent) throw new Error(`detected agent ${id} missing from skill status`)
  return agent
}

async function makeRun(party: OrchestrationParty, objective: string): Promise<RunRow> {
  const result = await party.client.callAny('quirky.orchestration/runCreate', { ...mutation(), objective }) as { run: RunRow }
  return result.run
}

async function makeTask(party: OrchestrationParty, runId: string, spec: string): Promise<TaskRow> {
  const result = await party.client.callAny('quirky.orchestration/taskCreate', { ...mutation(), runId, spec }) as { task: TaskRow }
  return result.task
}

async function dispatch(party: OrchestrationParty, runId: string, taskId: string, to: string): Promise<DispatchRow> {
  const result = await party.client.callAny('quirky.orchestration/dispatch', { ...mutation(), runId, taskId, to }) as { dispatch: DispatchRow }
  return result.dispatch
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  let error: unknown
  try { await promise } catch (cause) { error = cause }
  expect(error).toBeDefined()
  return error
}

describe('orchestration setup acceptance', () => {
  test('AC1–2: public skill API and CLI install/update/recheck actual private skill files and preserve siblings', async () => {
    const claudePath = join(fixture.userHome, '.claude', 'skills', 'orchestration', 'SKILL.md')
    const unrelated = join(fixture.userHome, '.claude', 'skills', 'another-skill', 'SKILL.md')
    mkdirSync(join(unrelated, '..'), { recursive: true })
    writeFileSync(unrelated, 'unrelated content\n')

    const initial = await api<{ state: string; agents: { id: string; state: string; path: string | null }[]; installCommand: string }>('quirky.orchestration/skillStatus')
    assertPrivateTargets(initial)
    expect(initial.installCommand).toBe('quirky orchestration skill-install')
    expect(agentState(initial, 'claude').state).toBe('missing')
    expect(existsSync(claudePath)).toBe(false)

    const shown = await api<{ skill: string }>('quirky.orchestration/skillShow')
    expect(shown.skill).toContain('name: orchestration')
    expect(shown.skill).toContain('/orchestration')

    const installWords = initial.installCommand.trim().split(/\s+/)
    expect(installWords[0]).toBe('quirky')
    const installed = cliJson<{ state: string; agents: { id: string; state: string }[] }>(await unboundCli([...installWords.slice(1), '--json']))
    expect(agentState(installed, 'claude').state).toBe('ready')
    expect(readFileSync(claudePath, 'utf8')).toBe(shown.skill)
    expect(readFileSync(unrelated, 'utf8')).toBe('unrelated content\n')
    expect(readdirSync(join(fixture.userHome, '.claude', 'skills', 'orchestration'))).toEqual(['SKILL.md'])

    const cliStatus = cliJson<{ agents: { id: string; state: string }[] }>(await unboundCli(['orchestration', 'skill-status', '--json']))
    expect(agentState(cliStatus, 'claude').state).toBe('ready')
    expect((await api<{ skill: string }>('quirky.orchestration/skillShow')).skill).toBe(readFileSync(claudePath, 'utf8'))

    const fakeBin = process.env.PATH?.split(':')[0]
    if (!fakeBin) throw new Error('private test PATH is missing its fake executable directory')
    const fakeCodex = join(fakeBin, 'codex')
    writeFileSync(fakeCodex, `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o700 })
    chmodSync(fakeCodex, 0o700)
    await api('quirky.agents/refresh')
    const codexPath = join(fixture.userHome, '.agents', 'skills', 'orchestration', 'SKILL.md')
    mkdirSync(join(codexPath, '..'), { recursive: true })
    mkdirSync(codexPath)
    writeFileSync(claudePath, 'previous generated version\n')

    const stale = await api<{ state: string; agents: { id: string; state: string; path: string | null }[] }>('quirky.orchestration/skillStatus')
    assertPrivateTargets(stale)
    expect(agentState(stale, 'claude').state).toBe('stale')
    expect(agentState(stale, 'codex').state).toBe('error')
    const partial = await api<{ state: string; agents: { id: string; state: string }[] }>('quirky.orchestration/skillInstall')
    expect(partial.state).toBe('partial')
    expect(agentState(partial, 'claude').state).toBe('ready')
    expect(agentState(partial, 'codex').state).toBe('error')
    expect(readFileSync(claudePath, 'utf8')).toBe(shown.skill)

    rmSync(codexPath, { recursive: true, force: true })
    const retried = await api<{ state: string; agents: { id: string; state: string }[] }>('quirky.orchestration/skillInstall', { agents: ['codex'] })
    expect(agentState(retried, 'claude').state).toBe('ready')
    expect(agentState(retried, 'codex').state).toBe('ready')
    expect(readFileSync(codexPath, 'utf8')).toBe(shown.skill)
    expect(readFileSync(unrelated, 'utf8')).toBe('unrelated content\n')
  }, 60_000)

  test('AC5: unbound policy changes persist across restart, deny session callers, and gate future nested dispatches', async () => {
    const defaultPolicy = await api<{ nestedWorkerMaxDepth: number; canChange: boolean }>('quirky.orchestration/policyShow')
    expect(defaultPolicy).toEqual({ nestedWorkerMaxDepth: 1, canChange: true })
    await rejected(api('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 1.5 }))
    await rejected(api('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 0 }))

    const boundWorker = await fixture.createParty('bound-policy-caller')
    await rejected(boundWorker.client.callAny('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 9 }))
    const uiCaller = await QuirkyClient.connect(rpcUrl(fixture.harness.runtime), {
      role: 'ui',
      name: 'spoofed unbound settings role',
      sessionId: boundWorker.id,
      worktreeId: boundWorker.worktreeId,
      sessionToken: boundWorker.sessionToken
    })
    try {
      await rejected(uiCaller.callAny('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 9 }))
    } finally {
      await uiCaller.close()
    }

    const changed = await api<{ nestedWorkerMaxDepth: number; canChange: boolean }>('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 2 })
    expect(changed).toEqual({ nestedWorkerMaxDepth: 2, canChange: true })
    await fixture.restart()
    expect(await api('quirky.orchestration/policyShow')).toEqual({ nestedWorkerMaxDepth: 2, canChange: true })

    await api('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 1 })
    const coordinator = await fixture.createParty('coordinator')
    const worker1 = await fixture.createParty('worker-one')
    const worker2 = await fixture.createParty('worker-two')
    const worker3 = await fixture.createParty('worker-three')
    const rootRun = await makeRun(coordinator, 'depth root')
    const rootTask = await makeTask(coordinator, rootRun.id, 'depth one worker')
    const depth1 = await dispatch(coordinator, rootRun.id, rootTask.id, worker1.id)
    expect(depth1.depth).toBe(1)

    const worker1Run = await makeRun(worker1, 'nested run does not reset depth')
    const worker1Task = await makeTask(worker1, worker1Run.id, 'depth two worker')
    await rejected(worker1.client.callAny('quirky.orchestration/dispatch', {
      ...mutation(), runId: worker1Run.id, taskId: worker1Task.id, to: worker2.id
    }))
    await api('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 2 })
    const depth1Preamble = buildWorkerPreamble(
      rootTask,
      depth1,
      { sessionId: worker1.id, worktreeId: worker1.worktreeId, kind: 'terminal' } as SessionIdentity,
      rootRun.coordinatorSessionId!,
      (await api<{ nestedWorkerMaxDepth: number }>('quirky.orchestration/policyShow')).nestedWorkerMaxDepth
    )
    expect(depth1Preamble).toContain('=== SUB-DISPATCH ===')

    const depth2 = await dispatch(worker1, worker1Run.id, worker1Task.id, worker2.id)
    expect(depth2.depth).toBe(2)
    const worker2Run = await makeRun(worker2, 'second nested run does not reset depth')
    const worker2Task = await makeTask(worker2, worker2Run.id, 'depth three worker')
    await rejected(worker2.client.callAny('quirky.orchestration/dispatch', {
      ...mutation(), runId: worker2Run.id, taskId: worker2Task.id, to: worker3.id
    }))
    const depth2Preamble = buildWorkerPreamble(
      worker1Task,
      depth2,
      { sessionId: worker2.id, worktreeId: worker2.worktreeId, kind: 'terminal' } as SessionIdentity,
      worker1.id,
      (await api<{ nestedWorkerMaxDepth: number }>('quirky.orchestration/policyShow')).nestedWorkerMaxDepth
    )
    expect(depth2Preamble).not.toContain('=== SUB-DISPATCH ===')

    await api('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 1 })
    expect(await api('quirky.orchestration/policyShow')).toMatchObject({ nestedWorkerMaxDepth: 1 })
    const settledView = await api<{ dispatch: DispatchRow | null }>('quirky.orchestration/dispatchShow', { taskId: worker1Task.id })
    expect(settledView.dispatch?.id).toBe(depth2.id)
    expect(settledView.dispatch?.status).toBe('dispatched')
    const loweredPreamble = buildWorkerPreamble(
      rootTask,
      depth1,
      { sessionId: worker1.id, worktreeId: worker1.worktreeId, kind: 'terminal' } as SessionIdentity,
      rootRun.coordinatorSessionId!,
      (await api<{ nestedWorkerMaxDepth: number }>('quirky.orchestration/policyShow')).nestedWorkerMaxDepth
    )
    expect(loweredPreamble).not.toContain('=== SUB-DISPATCH ===')
  }, 60_000)
})
