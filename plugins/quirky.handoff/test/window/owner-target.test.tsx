import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { OwnerSessionWorkspaceRef } from '@quirky/protocol'
import { registerDom } from './register-dom'
import { afterDebounce, daemon, fakeContext, makeWorld, mountOverlay, rpcError, settle, teardown, type Handler, type Ui, type World } from './support'

let ui: Ui

beforeAll(async () => {
  registerDom()
  ui = (await import('../../src/ui')) as Ui
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(() => teardown(ui))

const remoteRef = (hostId: string, runtimeId: string, mirrorId: string, worktreeId: string): OwnerSessionWorkspaceRef => ({
  owner: {
    hostId,
    identity: { hostId, generation: `generation-${hostId}` },
    runtime: { id: runtimeId, endpoint: `http://127.0.0.1:${runtimeId === 'runtime-a' ? '41001' : '41002'}`, grantId: `grant-${hostId}` }
  },
  mirrorId,
  worktreeId,
  instanceId: `instance-${hostId}`,
  fingerprint: `fingerprint-${hostId}`
})

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

async function opened(configure: (world: World) => void = () => {}, overrides: Record<string, Handler> = {}) {
  const world = makeWorld()
  configure(world)
  const fake = fakeContext(daemon(world, overrides))
  const overlay = await mountOverlay(ui, fake)
  await fake.run('open', { session: 's_1' })
  await settle()
  return { world, fake, overlay }
}

describe('SC-45 and S5: a remote target owns its agent selection and stale responses cannot retarget the dialog', () => {
  test('switching targets ignores a late owner-agent response, and a stale Start keeps the exact remote choice for review', async () => {
    const ownerA = remoteRef('host-a', 'runtime-a', 'mirror-a', 'wt-remote-a')
    const ownerB = remoteRef('host-b', 'runtime-b', 'mirror-b', 'wt-remote-b')
    const pendingA = deferred<{ state: 'ready'; list: { id: string; label: string }[]; defaultAgent: string | null }>()
    const targetRequests = new Map<'a' | 'b', Record<string, any>>()
    const startRequests: Record<string, any>[] = []
    const { world, fake, overlay } = await opened(
      (world) => {
        world.candidates = [
          ...world.candidates,
          { id: ownerA.mirrorId, name: 'Workspace A', path: '/remote-a/W', kind: 'git', branch: 'main', remote: ownerA, hostName: 'Owner A' },
          { id: ownerB.mirrorId, name: 'Workspace B', path: '/remote-b/W', kind: 'git', branch: 'main', remote: ownerB, hostName: 'Owner B' }
        ]
      },
      {
        'quirky.handoff/targetAgents': (params) => {
          const hostId = params.target?.remote?.owner?.hostId
          if (hostId === 'host-a') {
            targetRequests.set('a', structuredClone(params))
            return pendingA.promise
          }
          if (hostId === 'host-b') {
            targetRequests.set('b', structuredClone(params))
            return { state: 'ready', list: [{ id: 'remote-bot', label: 'Remote B Bot' }], defaultAgent: 'remote-bot' }
          }
          return { state: 'ready', list: [{ id: 'local-bot', label: 'Local Bot' }], defaultAgent: 'local-bot' }
        },
        'quirky.handoff/start': (params) => {
          startRequests.push(structuredClone(params))
          throw rpcError('The selected remote workspace changed. Refresh the target and review it again.', { reason: 'target-stale' })
        }
      }
    )

    await fake.run('set', { field: 'worktree', value: ownerA.mirrorId })
    await settle()
    expect(targetRequests.get('a')).toEqual({ target: { remote: ownerA } })
    expect(overlay.last().disabled).toContain('start:agents-loading')

    await fake.run('set', { field: 'worktree', value: ownerB.mirrorId })
    await settle()
    expect(targetRequests.get('b')).toEqual({ target: { remote: ownerB } })
    expect(overlay.last().controls.target).toEqual({ remote: ownerB })
    expect(overlay.last().agents).toMatchObject({ state: 'ready', list: [{ id: 'remote-bot', label: 'Remote B Bot' }] })
    expect(overlay.view.text()).toContain('Owner B · Workspace B')

    pendingA.resolve({ state: 'ready', list: [{ id: 'remote-a-bot', label: 'Remote A Bot' }], defaultAgent: 'remote-a-bot' })
    await settle()
    await afterDebounce()
    expect(overlay.last().controls).toMatchObject({ target: { remote: ownerB }, agent: 'remote-bot' })
    expect(overlay.last().agents.list.map((agent: { id: string }) => agent.id)).toEqual(['remote-bot'])
    world.probe = { verdict: 'unverifiable', path: '/remote/private/transcript.jsonl', reason: 'path-outside-known-roots', candidate: 'reported' }
    await fake.run('set', { field: 'note', value: 'keep this remote review' })
    await afterDebounce()
    const fullContext = overlay.view.all('input[name="hf-context"]')[1] as HTMLInputElement
    expect(fullContext.disabled).toBe(true)
    expect(await fake.run('set', { field: 'context', value: 'full' })).toMatchObject({ ok: false, reason: 'full-unavailable' })

    expect((await fake.run('start')).ok).toBe(false)
    expect(startRequests).toHaveLength(1)
    expect(startRequests[0]!.controls).toMatchObject({ target: { remote: ownerB }, agent: 'remote-bot', note: 'keep this remote review' })
    expect(overlay.last()).toMatchObject({
      shown: true,
      error: 'The selected remote workspace changed. Refresh the target and review it again.',
      controls: { target: { remote: ownerB }, agent: 'remote-bot', note: 'keep this remote review' }
    })
  })

  test('an owner-qualified archived source opens the local review dialog with owner-verified, redacted details', async () => {
    const owner = remoteRef('archive-host', 'archive-runtime', 'archive-mirror', 'archive-worktree')
    const archived = {
      agent: 'claude',
      owner: owner.owner,
      vaultId: 'owner-local-opaque-vault-id',
      title: 'caller-supplied title',
      cwd: '/caller/private/worktree',
      providerSessionId: 'caller-provider-id',
      transcriptPath: '/caller/private/worktree/private.jsonl'
    }
    const world = makeWorld()
    world.source = {
      ...world.source,
      key: `archived:${owner.owner.hostId}:${archived.vaultId}`,
      session: null,
      title: 'Owner verified title',
      cwd: null,
      worktreeId: null,
      providerSessionId: 'owner-provider-id',
      transcriptPath: null,
      prompt: 'Owner verified first prompt',
      lastMessage: 'Owner verified last message',
      live: false,
      busy: false
    }
    const fake = fakeContext(daemon(world))
    const overlay = await mountOverlay(ui, fake)

    expect(await fake.run('open-archived', { source: { archived } })).toEqual({ ok: true })
    await settle()

    expect(overlay.last()).toMatchObject({
      shown: true,
      source: {
        session: null,
        title: 'Owner verified title',
        cwd: null,
        providerSessionId: 'owner-provider-id',
        transcriptPath: null,
        prompt: 'Owner verified first prompt',
        lastMessage: 'Owner verified last message',
        live: false
      }
    })
    expect(overlay.view.text()).toContain('Owner verified title')
    expect(overlay.view.text()).not.toContain('/caller/private/worktree')
  })
})

