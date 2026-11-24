import { describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../../../../shared/fork-heimdall/api'
import {
  HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
  heimdallEnrollmentRefusalError
} from '../../../../../shared/fork-heimdall/enrollment-refusal-error'
import type { EnrollInput, EnrollResult } from '../../../../../shared/fork-heimdall/watcher-types'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import { mapRuntimeError } from '../../errors'
import { eraseRpcMethods, isStreamingMethod, type RpcMethod } from '../../core'
import { HEIMDALL_METHODS } from './heimdall'
import { bindHeimdallKernel } from './kernel-binding'

const enrollmentInput: EnrollInput = {
  kind: 'hosted-review',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  capabilities: { write: 'on' },
  budget: { wallClockActiveMs: 100_000, turns: 10 },
  kindPayload: { label: 'Recovery' }
}

function enrollmentMethod(): RpcMethod {
  const method = eraseRpcMethods(HEIMDALL_METHODS).find(
    (candidate) => candidate.name === HEIMDALL_CHANNELS.enroll
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing Heimdall enrollment RPC method')
  }
  return method
}

describe('Heimdall enrollment refusal RPC errors', () => {
  it('preserves the duplicate watcher recovery id through the RPC error envelope', async () => {
    const refusal: EnrollResult = {
      status: 'refused',
      reason: 'duplicate-workspace',
      existingWatcherId: 'existing-1'
    }
    const runtime = new QuirkyRuntimeService(null)
    const kernel = { enroll: vi.fn(async () => refusal) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this method test binds only the enrollment implementation used by the RPC handler.
    bindHeimdallKernel(runtime, kernel as never)

    const method = enrollmentMethod()
    const params = method.params?.parse({ input: enrollmentInput, owner: null })
    let error: unknown
    try {
      await method.handler(params, { runtime, clientKind: 'runtime' })
    } catch (cause) {
      error = cause
    }

    const response = mapRuntimeError('enroll-1', { runtimeId: 'runtime-1' }, error)
    expect(response).toMatchObject({
      id: 'enroll-1',
      ok: false,
      error: {
        code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
        data: {
          status: 'refused',
          reason: 'duplicate-workspace',
          existingWatcherId: 'existing-1'
        }
      }
    })
    if (!response.ok) {
      expect(response.error.data).not.toHaveProperty('detail')
    }
  })

  it('omits refusal detail from structured RPC error data', () => {
    const error = heimdallEnrollmentRefusalError({
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'private-detail'
    })
    const response = mapRuntimeError('enroll-2', { runtimeId: 'runtime-1' }, error)
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
        data: { status: 'refused', reason: 'invalid-payload' }
      }
    })
    if (!response.ok) {
      expect(response.error.data).not.toHaveProperty('detail')
    }
  })
})
