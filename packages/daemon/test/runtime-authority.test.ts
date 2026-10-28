import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { PROTOCOL_VERSION, QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { startDaemon, type DaemonHandle } from '../src/daemon'
import { makeTempHome, startHarness, type Harness } from './helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './plugins/fixtures'

const pluginId = 'acme.authority'
const method = (id: string) => ({ id, params: { type: 'object', additionalProperties: true } })
const authorityPlugin = {
  manifest: {
    id: pluginId,
    contributes: {
      method: ['launch', 'lease', 'release', 'identity', 'caller'].map(method)
    }
  },
  behavior: {
    activate: `
      const envs = globalThis.__runtimeAuthorityEnvs ?? (globalThis.__runtimeAuthorityEnvs = new Map())
      const leases = globalThis.__runtimeAuthorityLeases ?? (globalThis.__runtimeAuthorityLeases = new Map())
      const launch = async (params) => {
        const sessionId = String(params.sessionId)
        if (params.replace) await context.pty.forget(sessionId)
        const env = context.launch.env({ sessionId, worktreeId: 'wt_test', agent: 'shell' })
        await context.pty.spawn(sessionId, { argv: ['/bin/sh'], cwd: '/workspace', env, cols: 80, rows: 24 })
        envs.set(sessionId, env)
        return { sessionId, identity: context.launch.sessionIdentity(sessionId) }
      }
      context.provide('method:acme.authority/launch', launch)
      context.provide('method:acme.authority/lease', (params) => {
        const sessionId = String(params.sessionId)
        const lease = context.launch.openStructuredLease({ sessionId, worktreeId: 'wt_structured', agent: 'claude' })
        envs.set(sessionId, lease.env)
        leases.set(sessionId, lease)
        return { sessionId, identity: context.launch.sessionIdentity(sessionId) }
      })
      context.provide('method:acme.authority/release', (params) => {
        const sessionId = String(params.sessionId)
        leases.get(sessionId)?.release()
        leases.delete(sessionId)
        return context.launch.sessionIdentity(sessionId)
      })
      context.provide('method:acme.authority/identity', (params) => context.launch.sessionIdentity(String(params.sessionId)))
      context.provide('method:acme.authority/caller', (_params, caller) => caller)
    `
  }
}

type GlobalState = {
  __runtimeAuthorityEnvs?: Map<string, Record<string, string>>
  __runtimeAuthorityLeases?: Map<string, { release(): void }>
}
const globalState = globalThis as unknown as GlobalState

let harness: Harness | null = null
let restarted: DaemonHandle | null = null
const extraClients: QuirkyClient[] = []
const logs: string[] = []
afterEach(async () => {
  for (const client of extraClients.splice(0)) client.close()
  await restarted?.stop()
  restarted = null
  await harness?.cleanup()
  harness = null
  delete globalState.__runtimeAuthorityEnvs
  delete globalState.__runtimeAuthorityLeases
  logs.length = 0
  removeTempDirs()
})

async function boot() {
  const home = makeTempHome('qd-authority-')
  writeModulePlugin(join(home, 'plugins'), join(makeTempDir(), 'marker.log'), authorityPlugin.manifest, authorityPlugin.behavior)
  harness = await startHarness({ home, builtinPluginsDir: null, log: (message) => logs.push(message) })
  const client = await harness.connect('cli')
  return { harness, client }
}

function childEnv(sessionId: string): Record<string, string> {
  const env = globalState.__runtimeAuthorityEnvs?.get(sessionId)
  if (!env) throw new Error(`no child environment for ${sessionId}`)
  return env
}

async function clientFor(sessionId?: string, sessionToken?: string, runtime = harness!.runtime): Promise<QuirkyClient> {
  const client = await QuirkyClient.connect(rpcUrl(runtime), {
    role: 'cli',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionToken === undefined ? {} : { sessionToken })
  })
  if (runtime === harness!.runtime) harness!.clients.push(client)
  else extraClients.push(client)
  return client
}

describe('kernel runtime session authority', () => {
  test('terminal launch injects a secret, persists only its hash, and grants authority on a valid hello', async () => {
    const { harness: running, client } = await boot()
    const sessionId = 's_terminal'
    const launched = (await client.callAny(`${pluginId}/launch`, { sessionId })) as {
      identity: { sessionId: string; runtimeEpoch: string; processIncarnation: string; source: string; live: true }
    }
    const env = childEnv(sessionId)
    const sessionToken = env.QUIRKY_SESSION_TOKEN
    expect(running.pty.sessions.get(sessionId)?.env.QUIRKY_SESSION_TOKEN).toBe(sessionToken)
    expect(sessionToken).toBeString()
    expect(sessionToken).not.toBe(sessionId)
    expect(env.QUIRKY_SESSION_ID).toBe(sessionId)
    expect(launched.identity).toMatchObject({ sessionId, source: 'terminal_launch', live: true })
    expect(launched.identity).not.toHaveProperty('sessionToken')

    const callerClient = await clientFor(sessionId, sessionToken)
    const hello = await callerClient.callAny('client.hello', {
      role: 'cli',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      sessionToken
    })
    expect(hello).toEqual({ protocolVersion: PROTOCOL_VERSION, daemonVersion: running.runtime.daemonVersion })
    expect(JSON.stringify(hello)).not.toContain(sessionToken)
    const caller = await callerClient.callAny(`${pluginId}/caller`, {})
    expect(caller).toMatchObject({
      role: 'cli',
      sessionId,
      sessionAuthority: {
        sessionId,
        runtimeEpoch: launched.identity.runtimeEpoch,
        processIncarnation: launched.identity.processIncarnation,
        source: 'terminal_launch',
        live: true
      }
    })
    expect(JSON.stringify(caller)).not.toContain(sessionToken)
    expect(logs.join('\n')).not.toContain(sessionToken)

    const db = new Database(join(running.home, 'quirky.db'), { readonly: true })
    try {
      const row = db.query('SELECT * FROM runtime_authorities WHERE session_id = ?').get(sessionId) as Record<string, unknown> | null
      expect(row?.token_hash).toBe(createHash('sha256').update(sessionToken).digest('hex'))
      expect(JSON.stringify(row)).not.toContain(sessionToken)
    } finally {
      db.close()
    }
  })

  test('forged session IDs, wrong or absent tokens, replacement, and process exit never retain authority', async () => {
    const { client } = await boot()
    const sessionId = 's_replace'
    const initial = (await client.callAny(`${pluginId}/launch`, { sessionId })) as {
      identity: { processIncarnation: string }
    }
    const oldToken = childEnv(sessionId).QUIRKY_SESSION_TOKEN
    const valid = await clientFor(sessionId, oldToken)
    expect(await valid.callAny(`${pluginId}/caller`, {})).toHaveProperty('sessionAuthority')
    await expect(client.callAny(`${pluginId}/launch`, { sessionId })).rejects.toThrow('already has live runtime authority')
    expect(childEnv(sessionId).QUIRKY_SESSION_TOKEN).toBe(oldToken)
    expect(await valid.callAny(`${pluginId}/caller`, {})).toHaveProperty('sessionAuthority')

    const forgedId = await clientFor('s_forged', oldToken)
    expect(await forgedId.callAny(`${pluginId}/caller`, {})).not.toHaveProperty('sessionAuthority')
    const wrongToken = await clientFor(sessionId, 'not-the-launch-token')
    expect(await wrongToken.callAny(`${pluginId}/caller`, {})).not.toHaveProperty('sessionAuthority')
    const legacyClient = await clientFor(sessionId)
    expect(await legacyClient.callAny(`${pluginId}/caller`, {})).not.toHaveProperty('sessionAuthority')

    const replacement = (await client.callAny(`${pluginId}/launch`, { sessionId, replace: true })) as {
      identity: { processIncarnation: string; source: string; live: true }
    }
    const newToken = childEnv(sessionId).QUIRKY_SESSION_TOKEN
    expect(newToken).not.toBe(oldToken)
    expect(replacement.identity.processIncarnation).not.toBe(initial.identity.processIncarnation)
    expect(replacement.identity).toMatchObject({ source: 'terminal_launch', live: true })
    expect(await valid.callAny(`${pluginId}/caller`, {})).not.toHaveProperty('sessionAuthority')

    const current = await clientFor(sessionId, newToken)
    expect(await current.callAny(`${pluginId}/caller`, {})).toHaveProperty('sessionAuthority')
    harness!.pty.exit(sessionId, 0)
    expect(await current.callAny(`${pluginId}/caller`, {})).not.toHaveProperty('sessionAuthority')
  })

  test('structured lease identity is live only until release', async () => {
    const { client } = await boot()
    const sessionId = 's_structured'
    const opened = (await client.callAny(`${pluginId}/lease`, { sessionId })) as {
      identity: { sessionId: string; runtimeEpoch: string; processIncarnation: string; source: string; live: true }
    }
    const sessionToken = childEnv(sessionId).QUIRKY_SESSION_TOKEN

    const child = await clientFor(sessionId, sessionToken)
    expect(await child.callAny(`${pluginId}/caller`, {})).toMatchObject({
      sessionAuthority: {
        ...opened.identity,
        source: 'structured_lease',
        live: true
      }
    })
    expect(await client.callAny(`${pluginId}/release`, { sessionId })).toBeNull()
    expect(await child.callAny(`${pluginId}/caller`, {})).not.toHaveProperty('sessionAuthority')
    expect(await client.callAny(`${pluginId}/identity`, { sessionId })).toBeNull()
  })

  test('daemon restart restores only the exact live PTY incarnation', async () => {
    const { harness: running, client } = await boot()
    const sessionId = 's_restart'
    const launched = (await client.callAny(`${pluginId}/launch`, { sessionId })) as {
      identity: { runtimeEpoch: string; processIncarnation: string }
    }
    const sessionToken = childEnv(sessionId).QUIRKY_SESSION_TOKEN
    await running.daemon.stop()
    restarted = await startDaemon({
      home: running.home,
      port: 0,
      shell: '/bin/zsh',
      notifier: () => {},
      cliEntry: '/opt/quirky/cli/main.ts',
      uiDir: join(running.home, 'no-ui'),
      builtinPluginsDir: null,
      log: (message) => logs.push(message)
    })

    const restored = await clientFor(sessionId, sessionToken, restarted.runtime)
    const identity = await restored.callAny(`${pluginId}/identity`, { sessionId }) as {
      sessionId: string
      runtimeEpoch: string
      processIncarnation: string
      source: string
      live: true
    }
    expect(identity).toMatchObject({
      sessionId,
      source: 'restored_authority',
      processIncarnation: launched.identity.processIncarnation,
      live: true
    })
    expect(identity).not.toHaveProperty('sessionToken')
    expect(identity.runtimeEpoch).not.toBe(launched.identity.runtimeEpoch)
    expect(await restored.callAny(`${pluginId}/caller`, {})).toMatchObject({
      sessionAuthority: { ...identity, source: 'restored_authority' }
    })

    const pty = running.pty.sessions.get(sessionId)!
    pty.info = { ...pty.info, pid: pty.info.pid + 1, state: 'running', alive: true }
    expect(await restored.callAny(`${pluginId}/caller`, {})).not.toHaveProperty('sessionAuthority')
    expect(await restored.callAny(`${pluginId}/identity`, { sessionId })).toBeNull()
  })
})
