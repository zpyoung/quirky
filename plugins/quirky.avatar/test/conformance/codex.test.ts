import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUIRKY_GATE_SCRIPT } from '../../../../packages/daemon/src/launch'
import type { GateOutcome } from '../../src/contracts'
import { encodeDecision } from '../../src/hooks/encode'
import { codexHooksInstalled, installCodexHooks, writeMarkerFile } from '../../src/hooks/install'
import { runGateShim, useTempAgentHome } from '../daemon-support'

const agent = useTempAgentHome()

const binary = Bun.which('codex')
const suite = binary === null ? describe.skip : describe
const title = binary === null ? 'codex conformance (skipped: codex is not installed)' : 'codex conformance'

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A Quirky home with the real shim, a marker for `sess-1` and a stand-in daemon answering with `outcome`; `down` has nothing listening. */
function rig(outcome: GateOutcome | 'down') {
  const home = mkdtempSync(join(tmpdir(), 'avatar-conf-codex-'))
  dirs.push(home)
  mkdirSync(join(home, 'bin'))
  writeFileSync(join(home, 'bin', 'quirky-gate'), QUIRKY_GATE_SCRIPT)
  chmodSync(join(home, 'bin', 'quirky-gate'), 0o755)
  writeMarkerFile(home, 'sess-1', { worktreeId: 'wt-1', level: 'full' })
  const requests: { url: string; body: string }[] = []
  let port = 1
  if (outcome !== 'down') {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.text()
        requests.push({ url: request.url, body })
        const event = (new URL(request.url).searchParams.get('event') ?? JSON.parse(body).hook_event_name) as 'PreToolUse' | 'PermissionRequest'
        const decision = outcome === 'allow' || outcome === 'passthrough' ? outcome : 'deny'
        return Response.json({ decision, reason: 'because', encoded: encodeDecision('codex', event, { outcome, reason: 'because' }), exitCode: 0 })
      }
    })
    servers.push(server)
    port = server.port ?? 1
  }
  writeFileSync(join(home, 'runtime.json'), JSON.stringify({ port }))
  async function hook(payload: Record<string, unknown>) {
    return runGateShim(home, ['codex', '5000'], {
      ...agent.childEnv,
      QUIRKY_HOME: home,
      QUIRKY_SESSION_ID: 'sess-1',
      QUIRKY_HOOK_TOKEN: 'token'
    }, payload)
  }
  return { hook, requests }
}

const pre = { hook_event_name: 'PreToolUse', tool_name: 'shell_command', tool_input: { command: 'ls' }, cwd: '/w' }

suite(title, () => {
  test('the installed Codex runs, and the avatar writes its entries into a hooks.json beside the user\'s', async () => {
    const proc = Bun.spawn([binary!, '--version'], { env: agent.childEnv, stdout: 'pipe', stderr: 'ignore' })
    expect(await new Response(proc.stdout).text()).toMatch(/\d+\.\d+\.\d+/)
    const codexHome = mkdtempSync(join(tmpdir(), 'avatar-conf-codex-home-'))
    dirs.push(codexHome)
    const env = { home: codexHome, env: { CODEX_HOME: codexHome } }
    installCodexHooks(env, 55)
    expect(codexHooksInstalled(env)).toBe(true)
  }, 60_000)

  test('a normal call reaches the gate; an allow at PreToolUse prints an empty object because the allow is completed at PermissionRequest', async () => {
    const r = rig('allow')
    const result = await r.hook(pre)
    expect(result).toMatchObject({ stdout: '{}', code: 0 })
    expect(r.requests).toHaveLength(1)
    expect(new URL(r.requests[0]!.url).pathname).toBe('/gate/codex')
    const permission = await r.hook({ ...pre, hook_event_name: 'PermissionRequest' })
    expect(JSON.parse(permission.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  }, 60_000)

  test('a call Codex would approve on its own still reaches the gate, and a refusal is printed as a PreToolUse deny', async () => {
    const r = rig('held')
    const result = await r.hook({ ...pre, permission_mode: 'bypassPermissions' })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(r.requests).toHaveLength(1)
  }, 60_000)

  test('with the gate down the shim exits 2 with a retry reason, the code Codex treats as blocking', async () => {
    const r = rig('down')
    const result = await r.hook(pre)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("Quirky's avatar gate is unavailable; try again shortly.")
  }, 60_000)
})
