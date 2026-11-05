import { describe, expect, test } from 'bun:test'
import type { GitUpstreamStatus } from '@quirky/protocol'
import { shouldForcePushWithLease } from '../../src/panel/ladder'

const upstream = (over: Partial<GitUpstreamStatus> = {}): GitUpstreamStatus => ({
  hasUpstream: true,
  name: 'origin/zoe/feat',
  sha: 'abc',
  ahead: 0,
  behind: 0,
  behindPatchEquivalent: null,
  ...over
})

describe('shouldForcePushWithLease', () => {
  test("is Orca's predicate: ahead, behind and every behind commit a rebased copy", () => {
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 1, behindPatchEquivalent: true }))).toBe(true)
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 1, behindPatchEquivalent: false }))).toBe(false)
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 1, behindPatchEquivalent: null }))).toBe(false)
    expect(shouldForcePushWithLease(upstream({ ahead: 0, behind: 1, behindPatchEquivalent: true }))).toBe(false)
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 0, behindPatchEquivalent: true }))).toBe(false)
    expect(
      shouldForcePushWithLease(upstream({ hasUpstream: false, ahead: 1, behind: 1, behindPatchEquivalent: true }))
    ).toBe(false)
  })
})
