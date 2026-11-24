import { describe, expect, it } from 'vitest'
import {
  getLegacyManagedQuirkydOwnerEnvironmentId,
  getManagedQuirkydFenceEnvironmentId,
  isEphemeralRuntimeSshOwner,
  managedQuirkydServerName
} from './managed-quirkyd-ssh-owner'

describe('managed quirkyd SSH fence', () => {
  it('reads the fence from quirkydFence, never from owner', () => {
    expect(getManagedQuirkydFenceEnvironmentId({ quirkydFence: { environmentId: 'env-1' } })).toBe(
      'env-1'
    )
    expect(getManagedQuirkydFenceEnvironmentId({})).toBeNull()
    expect(getManagedQuirkydFenceEnvironmentId(undefined)).toBeNull()
  })

  it('recognises the legacy owner fence only so loading can migrate it', () => {
    const legacy = { type: 'on-demand-runtime' as const, runtimeId: 'managed-quirkyd:env-1' }
    expect(getLegacyManagedQuirkydOwnerEnvironmentId(legacy)).toBe('env-1')
    expect(isEphemeralRuntimeSshOwner(legacy)).toBe(false)
  })

  it('keeps ordinary on-demand runtime targets ephemeral', () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-1' }
    expect(getLegacyManagedQuirkydOwnerEnvironmentId(owner)).toBeNull()
    expect(isEphemeralRuntimeSshOwner(owner)).toBe(true)
  })

  it("names a recipe VM's server after its runtime, so two VMs of one recipe never collide", () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-0123456789abcdef' }
    expect(managedQuirkydServerName({ label: 'Docker root', owner })).toBe(
      'Docker root VM 89abcdef'
    )
    expect(managedQuirkydServerName({ label: 'Builder' })).toBe('Builder')
  })
})
