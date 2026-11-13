import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GateOutcome } from '../../src/contracts'
import { encodeDecision } from '../../src/hooks/encode'
import { writeMarkerFile } from '../../src/hooks/install'
import { gateExtensionSource } from '../../src/hooks/pi-extension'
import { useTempAgentHome } from '../daemon-support'

const agentHome = useTempAgentHome()

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
let savedEnv: Record<string, string | undefined>
const savedTitle = process.title
const savedArgv = [...process.argv]
let counter = 0

beforeAll(() => {
  savedEnv = { ...process.env }
})

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  process.title = savedTitle
  process.argv = [...savedArgv]
  for (const key of ['QUIRKY_SESSION_ID', 'QUIRKY_HOME', 'QUIRKY_HOOK_TOKEN', 'QUIRKY_HOOK_URL', '_']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

/** The generated extension loaded against a stand-in daemon answering with `outcome`; `down` has nothing listening. */
async function loadExtension(agent: string, outcome: GateOutcome | 'down') {
  const home = mkdtempSync(join(tmpdir(), 'avatar-conf-pi-'))
  dirs.push(home)
  writeMarkerFile(home, 'sess-1', { worktreeId: 'wt-1', level: 'full' })
  const requests: string[] = []
  let port = 1
  if (outcome !== 'down') {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push(new URL(request.url).pathname)
        const decision = outcome === 'allow' || outcome === 'passthrough' ? outcome : 'deny'
        const body = { decision, reason: 'because', encoded: encodeDecision(agent, 'tool_call', { outcome, reason: 'because' }) }
        return Response.json(body, { headers: { connection: 'close' } })
      }
    })
    servers.push(server)
    port = server.port ?? 1
  }
  writeFileSync(join(home, 'runtime.json'), JSON.stringify({ port }))
  process.env.QUIRKY_HOME = home
  process.env.QUIRKY_SESSION_ID = 'sess-1'
  process.env.QUIRKY_HOOK_TOKEN = 'token'
  process.title = agent
  process.env._ = agent
  process.argv = [agent, agent]
  const file = join(home, `extension-${counter++}.ts`)
  writeFileSync(file, gateExtensionSource())
  const module = (await import(file)) as { default: (pi: { on(name: string, handler: Handler): void }) => void }
  let handler: Handler | undefined
  module.default({ on: (name, fn) => void (name === 'tool_call' && (handler = fn)) })
  return { handler: handler!, requests }
}

const call = { toolName: 'bash', input: { command: 'ls' } }

for (const agent of ['pi', 'omp']) {
  const binary = Bun.which(agent)
  const suite = binary === null ? describe.skip : describe
  suite(binary === null ? `${agent} conformance (skipped: ${agent} is not installed)` : `${agent} conformance`, () => {
    test('the installed agent runs', async () => {
      const proc = Bun.spawn([binary!, '--version'], { env: agentHome.childEnv, stdout: 'pipe', stderr: 'pipe' })
      await proc.exited
      expect(proc.exitCode).toBe(0)
    }, 60_000)

    test('a normal call reaches the gate and an allow lets it run', async () => {
      const { handler, requests } = await loadExtension(agent, 'allow')
      expect(await handler(call, { cwd: '/w' })).toBeUndefined()
      expect(requests).toEqual([`/gate/${agent}`])
    }, 60_000)

    test('a call the agent would run without asking still reaches the gate, and a refusal blocks it', async () => {
      const { handler, requests } = await loadExtension(agent, 'held')
      expect(await handler(call, { cwd: '/w' })).toEqual({ block: true, reason: 'because' })
      expect(requests).toHaveLength(1)
    }, 60_000)

    test('with the gate down the call is blocked, never run', async () => {
      const { handler } = await loadExtension(agent, 'down')
      expect(await handler(call, { cwd: '/w' })).toMatchObject({ block: true })
    }, 60_000)
  })
}
