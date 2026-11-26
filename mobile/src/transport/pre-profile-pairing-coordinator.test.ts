import { describe, expect, it, vi } from 'vitest'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'
import type { HostProfile, PairingOffer, RpcResponse } from './types'
import type { connect, RpcClient } from './rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED' }))

const now = Date.UTC(2026, 6, 13)
const directOffer: PairingOffer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
}

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function failure(code: string): RpcResponse {
  return {
    id: 'rpc-1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function fakeClient(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn().mockImplementation(async () => responses.shift()!),
    close: vi.fn()
  } as unknown as RpcClient
}

function dependencies(client: RpcClient, events: string[]) {
  return {
    connectDirect: vi.fn(
      (..._args: Parameters<typeof connect>) => (events.push('connect'), client)
    ),
    resolveHostIdentity: vi.fn(async (_publicKeyB64: string, hostId: string) => ({
      id: hostId,
      name: 'Blue Whale'
    })),
    savePairedHost: vi.fn(async (_host: HostProfile) => {
      events.push('save-host')
    }),
    recordDescriptorFromStatus: vi.fn(() => {
      events.push('record-descriptor')
    }),
    now: () => now
  }
}

describe('pre-profile pairing coordinator', () => {
  it('pairs over the direct endpoint and saves the host', async () => {
    const events: string[] = []
    const client = fakeClient([success({ version: '1.0.0' })])
    const deps = dependencies(client, events)

    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })
    expect(deps.savePairedHost).toHaveBeenCalledWith({
      id: `host-${now}`,
      name: 'Blue Whale',
      endpoint: directOffer.endpoint,
      deviceToken: directOffer.deviceToken,
      publicKeyB64: directOffer.publicKeyB64,
      lastConnected: now
    })
    expect(events).toEqual(['connect', 'save-host', 'record-descriptor'])
  })

  it('reuses the existing host id and name when re-pairing the same desktop key (no duplicate)', async () => {
    // STA-1840: re-pairing a desktop already stored under a different id must
    // merge into that card, not mint a new host-${now} and duplicate the row.
    const events: string[] = []
    const client = fakeClient([success({ version: '1.0.0' })])
    const deps = dependencies(client, events)
    deps.resolveHostIdentity = vi.fn(async (publicKeyB64: string, newHostId: string) => {
      expect(publicKeyB64).toBe(directOffer.publicKeyB64)
      expect(newHostId).toBe(`host-${now}`)
      return { id: 'host-existing', name: 'Studio Mac' }
    })

    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: 'host-existing' })
    expect(deps.savePairedHost).toHaveBeenCalledWith({
      id: 'host-existing',
      name: 'Studio Mac',
      endpoint: directOffer.endpoint,
      deviceToken: directOffer.deviceToken,
      publicKeyB64: directOffer.publicKeyB64,
      lastConnected: now
    })
  })

  it('hands the winning status to the descriptor recorder only after the host is saved', async () => {
    const events: string[] = []
    const client = fakeClient([success({ machineName: 'm4airs-Air', hostPlatform: 'darwin' })])
    const deps = dependencies(client, events)
    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })
    expect(events).toEqual(['connect', 'save-host', 'record-descriptor'])
    expect(deps.recordDescriptorFromStatus).toHaveBeenCalledWith(
      `host-${now}`,
      expect.objectContaining({ machineName: 'm4airs-Air', hostPlatform: 'darwin' })
    )
  })

  it('pairs a desktop whose status reply is unreadable, recording no descriptor', async () => {
    const deps = dependencies(fakeClient([success(null)]), [])
    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })
    expect(deps.savePairedHost).toHaveBeenCalledOnce()
    expect(deps.recordDescriptorFromStatus).not.toHaveBeenCalled()
  })

  it('still resolves a saved pairing when descriptor recording throws', async () => {
    const events: string[] = []
    const client = fakeClient([success({ machineName: 'm4airs-Air', hostPlatform: 'darwin' })])
    const deps = dependencies(client, events)
    deps.recordDescriptorFromStatus.mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })

    await expect(attempt.result).resolves.toEqual({ hostId: `host-${now}` })
    expect(deps.savePairedHost).toHaveBeenCalledOnce()
  })

  it('ignores relay material in an offer from an older desktop and pairs directly', async () => {
    const events: string[] = []
    const deps = dependencies(fakeClient([success({ version: '1.0.0' })]), events)
    const offer: PairingOffer = {
      ...directOffer,
      relay: {
        v: 1,
        directorUrl: 'https://relay.example',
        cellUrl: 'https://relay-c1.example',
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
        inviteExpiresAt: now + 300_000,
        e2eeFraming: 2
      }
    }

    await expect(
      startPreProfilePairing({ offer, timeoutMs: 5_000, dependencies: deps }).result
    ).resolves.toEqual({ hostId: `host-${now}` })

    expect(deps.connectDirect).toHaveBeenCalledOnce()
    expect(deps.savePairedHost).toHaveBeenCalledWith(
      expect.not.objectContaining({ relay: expect.anything() })
    )
  })

  it('saves nothing when the desktop refuses the status probe', async () => {
    const deps = dependencies(fakeClient([failure('unauthorized')]), [])

    await expect(
      startPreProfilePairing({ offer: directOffer, timeoutMs: 5_000, dependencies: deps }).result
    ).rejects.toThrow()

    expect(deps.savePairedHost).not.toHaveBeenCalled()
  })

  it('cancels the disposable physical client without publishing a host', async () => {
    let resolveStatus!: (response: RpcResponse) => void
    const status = new Promise<RpcResponse>((resolve) => {
      resolveStatus = resolve
    })
    const client = fakeClient([])
    ;(client.sendRequest as ReturnType<typeof vi.fn>).mockReturnValue(status)
    const deps = dependencies(client, [])
    const attempt = startPreProfilePairing({
      offer: directOffer,
      timeoutMs: 5_000,
      dependencies: deps
    })
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledWith('status.get'))
    attempt.dispose()
    resolveStatus(success({ version: '1.0.0' }))

    await expect(attempt.result).rejects.toThrow(/cancelled/)
    expect(client.close).toHaveBeenCalledOnce()
    expect(deps.savePairedHost).not.toHaveBeenCalled()
  })
})
