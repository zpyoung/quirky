import { afterEach, describe, expect, it } from 'vitest'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import {
  clearForcedHandoffPolicy,
  getForcedHandoffPolicy,
  installForcedHandoffPolicy
} from './forced-handoff-policy'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy only stores the runtime reference and never calls it.
const runtime = {} as QuirkyRuntimeService

describe('forced hand-off policy', () => {
  afterEach(() => clearForcedHandoffPolicy())

  it('is absent until a supervisor installs one', () => {
    expect(getForcedHandoffPolicy()).toBeNull()
  })

  it('returns the installed policy until it is cleared', () => {
    const policy = { runtime, isForcedRun: (runId: string) => runId === 'run-1' }
    installForcedHandoffPolicy(policy)

    expect(getForcedHandoffPolicy()).toBe(policy)
    clearForcedHandoffPolicy()
    expect(getForcedHandoffPolicy()).toBeNull()
  })
})
