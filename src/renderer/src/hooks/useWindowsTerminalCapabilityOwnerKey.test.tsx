// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { resolveWindowsTerminalCapabilityOwnerKey } from './useWindowsTerminalCapabilityOwnerKey'

describe('Windows terminal capability owner key', () => {
  it('changes ownership for same-id re-pair and reconnect generations', () => {
    const environment = { id: 'paired-a', createdAt: 1, pairingRevision: 2 }
    const base = {
      activeRuntimeEnvironmentId: null,
      isWebClient: true,
      runtimeEnvironments: [environment]
    }
    const first = resolveWindowsTerminalCapabilityOwnerKey({
      ...base,
      runtimeStatusByEnvironmentId: new Map([['paired-a', { connectionGeneration: 1 }]])
    })
    const repaired = resolveWindowsTerminalCapabilityOwnerKey({
      ...base,
      runtimeEnvironments: [{ ...environment, pairingRevision: 3 }],
      runtimeStatusByEnvironmentId: new Map([['paired-a', { connectionGeneration: 1 }]])
    })
    const reconnected = resolveWindowsTerminalCapabilityOwnerKey({
      ...base,
      runtimeStatusByEnvironmentId: new Map([['paired-a', { connectionGeneration: 2 }]])
    })

    expect(new Set([first, repaired, reconnected])).toHaveLength(3)
  })

  it('preserves desktop-local and desktop-remote owner keys', () => {
    const runtimeEnvironments = [{ id: 'remote-a', createdAt: 1, pairingRevision: 2 }]

    expect(
      resolveWindowsTerminalCapabilityOwnerKey({
        activeRuntimeEnvironmentId: null,
        isWebClient: false,
        runtimeEnvironments
      })
    ).toBe('local')
    expect(
      resolveWindowsTerminalCapabilityOwnerKey({
        activeRuntimeEnvironmentId: 'remote-a',
        isWebClient: false,
        runtimeEnvironments
      })
    ).toBe('runtime:remote-a')
  })
})
