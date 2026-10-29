import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { startAgentsE2E, type E2E } from '../../quirky.agents/test/support/e2e'

const fixtures: E2E[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})

async function expectReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ data: { reason } })
}

async function daemon(): Promise<E2E> {
  const fixture = await startAgentsE2E()
  fixtures.push(fixture)
  return fixture
}

test('paired loopback peers expose safe status and reject methods outside the method ceiling', async () => {
  const home = await daemon()
  const host = await daemon()
  const token = randomBytes(32).toString('base64url')
  const homeListener = await home.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string; incarnation: string; capabilities: string[] }
  const hostListener = await host.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string; incarnation: string; capabilities: string[] }
  expect(homeListener.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(JSON.stringify(homeListener)).not.toContain(token)

  const homePair = await home.call('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Host A', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number; fingerprint: string } }
  const bootstrapAttack = await fetch(`${hostListener.endpoint}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'quirky.orchestration/reset', params: { mode: 'all' }, requestId: crypto.randomUUID() })
  })
  expect(bootstrapAttack.status).toBe(403)
  await bootstrapAttack.body?.cancel()
  const hostPair = await host.call('quirky.orchestration/peerPair', {
    peerId: 'home-a', label: 'Home A', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number; fingerprint: string } }

  const status = await home.call('quirky.orchestration/peerStatus', {
    peerId: homePair.peer.id, pairingRevision: homePair.peer.pairingRevision
  }) as { fingerprint: string; incarnation: string; capabilities: string[] }
  expect(status.fingerprint).toBe(hostListener.fingerprint)
  expect(status.incarnation).toBe(hostListener.incarnation)
  const spoofedSource = await fetch(`${hostListener.endpoint}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-quirky-peer-incarnation': randomUUID(),
    },
    body: JSON.stringify({
      method: 'quirky.orchestration/federationShow',
      params: { bindingId: 'binding_missing', expectedIncarnation: hostListener.incarnation },
    }),
  })
  expect(spoofedSource.status).toBe(409)
  expect((await spoofedSource.json() as { error: { code: string } }).error.code).toBe('peer_incarnation_changed')

  const inventory = await home.call('quirky.orchestration/peerList', {}) as { peers: unknown[] }
  expect(Array.isArray(inventory.peers)).toBe(true)
  expect(JSON.stringify(inventory)).not.toContain(token)
  const forbidden = await fetch(`${hostListener.endpoint}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'quirky.orchestration/reset', params: { mode: 'all' } })
  })
  expect(forbidden.status).toBe(403)
  await forbidden.body?.cancel()


  await expectReason(home.call('quirky.orchestration/peerStatus', {
    peerId: homePair.peer.id,
    pairingRevision: homePair.peer.pairingRevision + 1
  }), 'peer_revision_mismatch')
  await expectReason(home.call('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Bad pin', endpoint: hostListener.endpoint, token,
    fingerprint: '0'.repeat(64)
  }), 'peer_pin_mismatch')
  expect(hostPair.peer.pairingRevision).toBeGreaterThan(0)
}, 120_000)

test('remote status and hook-status reads retain exact peer identity without copying remote rows', async () => {
  const home = await daemon()
  const host = await daemon()
  const token = randomBytes(32).toString('base64url')
  const homeListener = await home.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string }
  const hostListener = await host.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string; incarnation: string }
  const paired = await home.call('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Host A', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number; fingerprint: string } }
  await host.call('quirky.orchestration/peerPair', {
    peerId: 'home-a', label: 'Home A', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint
  })
  const hostHooks = await host.call('quirky.agent-status/hooksStatus', {}) as {
    agent: string
    status: string
    files: string[]
    message?: string
  }[]

  const hooks = await home.call('quirky.agent-status/hooksStatusOnHost', { host: 'host-a' }) as {
    host: { kind: string; id: string; fingerprint: string; pairingRevision: number; incarnation: string }
    result: typeof hostHooks
  }
  expect(hooks.host).toMatchObject({
    kind: 'paired',
    id: 'host-a',
    fingerprint: paired.peer.fingerprint.replaceAll(':', '').toLowerCase(),
    pairingRevision: paired.peer.pairingRevision,
    incarnation: hostListener.incarnation
  })
  expect(hooks.result).toEqual(hostHooks)
  expect(JSON.stringify(hooks)).not.toContain(token)

  const remoteRow = await home.call('quirky.agent-status/getOnHost', {
    host: 'host-a',
    session: 'remote-only-status-row'
  }) as { host: { kind: string; id: string }; result: unknown }
  expect(remoteRow).toMatchObject({ host: { kind: 'paired', id: 'host-a' }, result: null })
  expect(await home.call('quirky.agent-status/get', { session: 'remote-only-status-row' })).toBeNull()
  expect(await home.call('quirky.agent-status/hooksStatusOnHost', { host: 'local' }))
    .toMatchObject({ host: { kind: 'local', id: 'local' } })

  const cliHooks = await home.cli(['agent-status', 'hooks', 'status', '--host', 'host-a', '--json'])
  expect(cliHooks.code, cliHooks.stderr || cliHooks.stdout).toBe(0)
  expect(cliHooks.stderr).toBe('')
  const cliHookResult = JSON.parse(cliHooks.stdout) as {
    host: { kind: string; id: string; pairingRevision: number }
    result: typeof hostHooks
  }
  expect(cliHookResult.host).toMatchObject({ kind: 'paired', id: 'host-a', pairingRevision: paired.peer.pairingRevision })
  expect(Array.isArray(cliHookResult.result)).toBe(true)
  expect(cliHookResult.result).toEqual(hostHooks)
  const cliGet = await home.cli([
    'agent-status', 'get', 'remote-only-status-row', '--host', 'host-a', '--json'
  ])
  expect(cliGet.code, cliGet.stderr || cliGet.stdout).toBe(0)
  expect(JSON.parse(cliGet.stdout)).toMatchObject({ host: { kind: 'paired', id: 'host-a' }, result: null })
  await home.call('quirky.orchestration/peerUnpair', {
    peerId: 'host-a',
    pairingRevision: paired.peer.pairingRevision
  })
  await expect(home.call('quirky.agent-status/hooksStatusOnHost', { host: 'host-a' }))
    .rejects.toThrow('No exact paired host matches host-a.')
  await expect(home.call('quirky.agent-status/getOnHost', {
    host: 'not-paired',
    session: 'remote-only-status-row'
  })).rejects.toThrow('No exact paired host matches not-paired.')
}, 120_000)

test('provider model discovery executes on the exact authenticated peer without local fallback', async () => {
  const home = await daemon()
  const host = await daemon()
  for (const [fixture, modelId] of [[home, 'local-model'], [host, 'remote-model']] as const) {
    mkdirSync(join(fixture.userHome, '.codex'), { recursive: true })
    writeFileSync(join(fixture.userHome, '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fixture-codex-token' }
    }))
    writeFileSync(join(fixture.userHome, 'codex-models.json'), JSON.stringify({
      data: [{ id: modelId, displayName: modelId, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
      nextCursor: null
    }))
    writeFileSync(join(fixture.fakebin, 'codex'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  for (;;) {
    const end = input.indexOf('\\n')
    if (end < 0) break
    const line = input.slice(0, end)
    input = input.slice(end + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n')
    else if (request.method === 'model/list') {
      const result = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'codex-models.json'), 'utf8'))
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
    }
  }
})
`)
    chmodSync(join(fixture.fakebin, 'codex'), 0o700)
  }
  for (const fixture of [home, host]) {
    await fixture.call('quirky.agents/refresh', {})
  }
  const localDiscovery = await home.call('quirky.agents/discoverModels', {
    agent: 'codex', host: 'local'
  }) as { authoritative: boolean; models: { id: string }[] }
  expect(localDiscovery).toMatchObject({ authoritative: true, models: [{ id: 'local-model' }] })

  const token = randomBytes(32).toString('base64url')
  const homeListener = await home.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string }
  const hostListener = await host.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string }
  const paired = await home.call('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Host A', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number } }
  await host.call('quirky.orchestration/peerPair', {
    peerId: 'home-a', label: 'Home A', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint
  })

  const discovered = await home.call('quirky.agents/discoverModels', {
    agent: 'codex', host: 'host-a'
  }) as { agent: string; host: string; authoritative: boolean; models: { id: string }[] }
  expect(discovered).toMatchObject({ agent: 'codex', host: 'host-a', authoritative: true, models: [{ id: 'remote-model' }] })
  expect(await home.call('quirky.agents/options', { agent: 'codex', host: 'host-a' }))
    .toMatchObject({ models: [{ id: 'remote-model' }] })
  expect(await home.call('quirky.agents/resolveLaunch', {
    agent: 'codex',
    host: 'host-a',
    model: 'remote-model',
    options: { effort: 'high' }
  })).toMatchObject({ structured: { model: 'remote-model', effort: 'high' } })
  expect(await home.call('quirky.agents/options', { agent: 'codex', host: 'local' }))
    .toMatchObject({ models: [{ id: 'local-model' }] })

  const unknown = await home.call('quirky.agents/discoverModels', {
    agent: 'codex', host: 'not-paired'
  }) as { authoritative: boolean; models: { id: string }[] }
  expect(unknown).toMatchObject({ authoritative: false, models: [] })
  await home.call('quirky.orchestration/peerUnpair', {
    peerId: 'host-a', pairingRevision: paired.peer.pairingRevision
  })
  const revoked = await home.call('quirky.agents/discoverModels', {
    agent: 'codex', host: 'host-a'
  }) as { authoritative: boolean; models: { id: string }[] }
  expect(revoked).toMatchObject({ authoritative: false, models: [] })
}, 120_000)

test('unpair revokes saved peer credentials', async () => {
  const home = await daemon()
  const host = await daemon()
  const token = randomBytes(32).toString('base64url')
  const hostListener = await host.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string }
  const paired = await home.call('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Host A', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number } }
  await home.call('quirky.orchestration/peerUnpair', {
    peerId: paired.peer.id, pairingRevision: paired.peer.pairingRevision
  })
  await expectReason(home.call('quirky.orchestration/peerStatus', { peerId: paired.peer.id }), 'peer_not_found')
}, 120_000)

test('peer-listen CLI reads its credential from a private file without printing it', async () => {
  const fixture = await daemon()
  const token = randomBytes(32).toString('base64url')
  const tokenFile = join(fixture.userHome, 'peer-token')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
  const result = await fixture.cli([
    'orchestration', 'peer-listen',
    '--host', '127.0.0.1',
    '--port', '0',
    '--token-file', tokenFile,
    '--json',
  ])
  expect(result.code, result.stderr || result.stdout).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).not.toContain(token)
  expect(result.stdout).toContain('http://127.0.0.1:')
}, 120_000)
