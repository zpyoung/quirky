import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  create: vi.fn(),
  resume: vi.fn(),
  list: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../ssh/quirkyd-ssh-provisioning', () => ({
  createQuirkydSshHost: mocks.create,
  resumeQuirkydSshHost: mocks.resume,
  listPendingQuirkydSshProvisioning: mocks.list
}))
import { registerQuirkydSshProvisioningHandlers } from './quirkyd-ssh-provisioning-handlers'

describe('managed SSH provisioning IPC', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers typed create, resume and pending discovery without changing legacy SSH channels', async () => {
    registerQuirkydSshProvisioningHandlers(() => '/active-profile')
    const handlers = new Map(mocks.handle.mock.calls.map(([name, handler]) => [name, handler]))
    expect([...handlers.keys()]).toEqual([
      'runtimeEnvironments:createQuirkydSshHost',
      'runtimeEnvironments:resumeQuirkydSshHost',
      'runtimeEnvironments:listPendingQuirkydSshProvisioning'
    ])
    const request = { requestId: 'request-1', name: 'host', target: { host: 'builder' } }
    const pending = { result: { outcome: 'pending', reason: 'unverifiable' } }
    mocks.create.mockResolvedValue(pending)
    expect(await handlers.get('runtimeEnvironments:createQuirkydSshHost')!(null, request)).toBe(
      pending
    )
    expect(mocks.create).toHaveBeenCalledWith('/active-profile', request)
    await handlers.get('runtimeEnvironments:resumeQuirkydSshHost')!(null, {
      requestId: 'request-1'
    })
    expect(mocks.resume).toHaveBeenCalledWith('/active-profile', 'request-1')
    handlers.get('runtimeEnvironments:listPendingQuirkydSshProvisioning')!()
    expect(mocks.list).toHaveBeenCalledWith('/active-profile')
  })
})
