import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve, join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { expectReason, startOrchestrationFixture, type OrchestrationFixture } from './fixture'

const fixtures: OrchestrationFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})

async function daemon(): Promise<OrchestrationFixture> {
  const fixture = await startOrchestrationFixture()
  fixtures.push(fixture)
  return fixture
}

test('paired loopback peers expose safe status and reject methods outside the method ceiling', async () => {
  const home = await daemon()
  const host = await daemon()
  const token = randomBytes(32).toString('base64url')
  const homeListener = await home.setupClient.callAny('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string; incarnation: string; capabilities: string[] }
  const hostListener = await host.setupClient.callAny('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string; incarnation: string; capabilities: string[] }
  expect(homeListener.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(homeListener.fingerprint).toBeTruthy()
  expect(homeListener.incarnation).toBeTruthy()
  expect(JSON.stringify(homeListener)).not.toContain(token)

  const homePair = await home.setupClient.callAny('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Host A', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number; fingerprint: string } }
  const bootstrapAttack = await fetch(`${hostListener.endpoint}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'quirky.orchestration/reset', params: { mode: 'all' }, requestId: crypto.randomUUID() })
  })
  expect(bootstrapAttack.status).toBe(403)
  await bootstrapAttack.body?.cancel()
  const hostPair = await host.setupClient.callAny('quirky.orchestration/peerPair', {
    peerId: 'home-a', label: 'Home A', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number; fingerprint: string } }

  const status = await home.setupClient.callAny('quirky.orchestration/peerStatus', {
    peerId: homePair.peer.id, pairingRevision: homePair.peer.pairingRevision
  }) as { fingerprint: string; incarnation: string; capabilities: string[] }
  expect(status.fingerprint).toBe(hostListener.fingerprint)
  expect(status.incarnation).toBe(hostListener.incarnation)

  const inventory = await home.setupClient.callAny('quirky.orchestration/peerList', {}) as { peers: unknown[] }
  expect(Array.isArray(inventory.peers)).toBe(true)
  expect(JSON.stringify(inventory)).not.toContain(token)
  const forbidden = await fetch(`${hostListener.endpoint}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'quirky.orchestration/reset', params: { mode: 'all' } })
  })
  expect(forbidden.status).toBe(403)
  await forbidden.body?.cancel()


  await expectReason(home.setupClient.callAny('quirky.orchestration/peerStatus', {
    peerId: homePair.peer.id,
    pairingRevision: homePair.peer.pairingRevision + 1
  }), 'peer_revision_mismatch')
  await expectReason(home.setupClient.callAny('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Bad pin', endpoint: hostListener.endpoint, token,
    fingerprint: '0'.repeat(64)
  }), 'peer_pin_mismatch')
  expect(hostPair.peer.pairingRevision).toBeGreaterThan(0)
})

test('unpair revokes saved peer credentials', async () => {
  const home = await daemon()
  const host = await daemon()
  const token = randomBytes(32).toString('base64url')
  const hostListener = await host.setupClient.callAny('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token
  }) as { endpoint: string; fingerprint: string }
  const paired = await home.setupClient.callAny('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Host A', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
  }) as { peer: { id: string; pairingRevision: number } }
  await home.setupClient.callAny('quirky.orchestration/peerUnpair', {
    peerId: paired.peer.id, pairingRevision: paired.peer.pairingRevision
  })
  await expectReason(home.setupClient.callAny('quirky.orchestration/peerStatus', { peerId: paired.peer.id }), 'peer_not_found')
})

test('peer-listen CLI reads its credential from a private file without printing it', async () => {
  const fixture = await daemon()
  const token = randomBytes(32).toString('base64url')
  const tokenFile = join(fixture.root, 'peer-token')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
  const operatorHome = join(fixture.userHome, 'unbound-operator')
  mkdirSync(operatorHome, { recursive: true, mode: 0o700 })
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, '../../../packages/cli/src/main.ts'),
    'orchestration', 'peer-listen',
    '--host', '127.0.0.1',
    '--port', '0',
    '--token-file', tokenFile,
    '--json',
  ], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: operatorHome, QUIRKY_HOME: fixture.home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).not.toContain(token)
  expect(stdout).toContain('http://127.0.0.1:')
})
