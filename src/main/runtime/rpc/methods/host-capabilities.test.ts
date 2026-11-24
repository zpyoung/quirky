import '../unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { QuirkyRuntimeService } from '../../quirky-runtime'

const { isGitBashAvailable } = vi.hoisted(() => ({
  isGitBashAvailable: vi.fn()
}))

vi.mock('../../../git-bash', () => ({ isGitBashAvailable }))

import { HOST_CAPABILITY_METHODS } from './host-capabilities'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('host capability RPC methods', () => {
  beforeEach(() => {
    isGitBashAvailable.mockReset()
  })

  it('reports shell capability probes through explicit methods', async () => {
    isGitBashAvailable.mockReturnValue(true)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as QuirkyRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOST_CAPABILITY_METHODS })

    await expect(
      dispatcher.dispatch(makeRequest('host.gitBash.isAvailable'))
    ).resolves.toMatchObject({
      ok: true,
      result: true
    })
  })
})
