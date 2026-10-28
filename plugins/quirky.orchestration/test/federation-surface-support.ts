import { randomBytes, randomUUID } from 'node:crypto'
import type { MutationResult, RunRow } from '../src/contracts'
import type { WorkerStartReceipt } from '../src/worker-contracts'
import { startWorkerAcceptance, type WorkerAcceptance } from './workers/acceptance-support'

export type FederationAcceptance = { home: WorkerAcceptance; host: WorkerAcceptance; peerId: string; cleanup(): Promise<void> }

export async function pairDaemons(): Promise<FederationAcceptance> {
  const home = await startWorkerAcceptance()
  let host: WorkerAcceptance | undefined
  try {
    host = await startWorkerAcceptance()
    const token = randomBytes(32).toString('base64url')
    const peerId = `host-${randomUUID()}`
    const homeListener = await home.fixture.call('quirky.orchestration/peerListen', { host: '127.0.0.1', port: 0, token }) as { endpoint: string; fingerprint: string; incarnation: string }
    const hostListener = await host.fixture.call('quirky.orchestration/peerListen', { host: '127.0.0.1', port: 0, token }) as { endpoint: string; fingerprint: string; incarnation: string }
    await home.fixture.call('quirky.orchestration/peerPair', {
      peerId, label: 'Federation test host', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
    })
    await host.fixture.call('quirky.orchestration/peerPair', {
      peerId: `home-${peerId}`, label: 'Federation test home', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint
    })
    return {
      home, host, peerId,
      async cleanup() { await host!.cleanup(); await home.cleanup() }
    }
  } catch (error) {
    await host?.cleanup()
    await home.cleanup()
    throw error
  }
}

export async function createHomeRun(h: FederationAcceptance): Promise<RunRow> {
  const accepted = await h.home.callAs<MutationResult<{ run: RunRow }>>(h.home.coordinator.id, 'run-create', ['--objective', 'Federated worker surface acceptance'])
  return accepted.run
}

export async function startRemote(h: FederationAcceptance, spec: string): Promise<WorkerStartReceipt> {
  const receipt = await h.home.callAs<MutationResult<WorkerStartReceipt>>(h.home.coordinator.id, 'worker-start', [
    '--on', h.peerId,
    '--spec', spec,
    '--agent', 'claude',
    '--worktree', h.host.coordinator.worktreeId,
    '--timeout-ms', '5000'
  ])
  if (receipt.state !== 'ready') throw new Error(`remote worker did not reach ready: ${receipt.stage}`)
  return receipt
}
