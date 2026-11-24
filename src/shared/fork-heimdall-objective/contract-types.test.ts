import { describe, expect, it } from 'vitest'
import {
  OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB,
  OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES,
  OBJECTIVE_EXISTING_PLAN_MAX_LENGTH,
  OBJECTIVE_GATES_MAX,
  OBJECTIVE_LAUNCH_MODEL_MAX_LENGTH,
  OBJECTIVE_PATH_MAX_LENGTH,
  OBJECTIVE_TEXT_MAX_LENGTH,
  ObjectiveCapabilitiesSchema,
  ObjectiveEnrollmentPayloadSchema,
  ObjectiveEnrollmentRequestSchema,
  ObjectiveGateSchema,
  ObjectiveRoleLaunchSchema,
  objectiveCapabilityModes,
  objectiveDispatchTaskSnapshotByteLength,
  type ObjectiveEnrollmentPayload,
  type ObjectiveGate
} from './contract-types'

function gate(overrides: Partial<ObjectiveGate> = {}): ObjectiveGate {
  return {
    name: 'lint',
    command: 'pnpm lint',
    timeoutSeconds: 1_800,
    ...overrides
  }
}

function payload(overrides: Partial<ObjectiveEnrollmentPayload> = {}): ObjectiveEnrollmentPayload {
  return {
    objectiveText: 'Implement the objective',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: 'git',
    writeTerritory: ['src/**'],
    roleAgents: {},
    sitterOverrides: {},
    ...overrides
  }
}

describe('objective enrollment request', () => {
  it('accepts an optional new worktree and trims its bounded name and base branch', () => {
    expect(ObjectiveEnrollmentRequestSchema.parse(payload())).toEqual(payload())
    expect(
      ObjectiveEnrollmentRequestSchema.parse({
        ...payload(),
        newWorktree: { name: '  objective-worktree  ', baseBranch: '  main  ' }
      }).newWorktree
    ).toEqual({ name: 'objective-worktree', baseBranch: 'main' })
  })

  it('rejects empty or overlong worktree fields and unknown request keys', () => {
    expect(
      ObjectiveEnrollmentRequestSchema.safeParse({ ...payload(), newWorktree: { name: '  ' } })
        .success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentRequestSchema.safeParse({
        ...payload(),
        newWorktree: { name: 'worktree', baseBranch: '  ' }
      }).success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentRequestSchema.safeParse({
        ...payload(),
        newWorktree: { name: 'x'.repeat(OBJECTIVE_PATH_MAX_LENGTH + 1) }
      }).success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentRequestSchema.safeParse({
        ...payload(),
        newWorktree: { name: 'worktree', unknown: true }
      }).success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentRequestSchema.safeParse({ ...payload(), unknown: true }).success
    ).toBe(false)
  })

  it('does not permit a request-only newWorktree in the persisted payload', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse({
        ...payload(),
        newWorktree: { name: 'objective-worktree' }
      }).success
    ).toBe(false)
  })
})

describe('objectiveDispatchTaskSnapshotByteLength', () => {
  it('measures the exact UTF-8 byte length of the serialized snapshot', () => {
    const snapshot = { taskKey: 'a', spec: '界'.repeat(4) }
    expect(objectiveDispatchTaskSnapshotByteLength(snapshot)).toBe(
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
    )
    expect(objectiveDispatchTaskSnapshotByteLength(snapshot)).toBeGreaterThan(
      JSON.stringify(snapshot).length
    )
  })

  it('is 16 KiB, matching the durable dispatch record cap', () => {
    expect(OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES).toBe(16 * 1_024)
  })
})

describe('objective enrollment payload', () => {
  it('accepts the three review tiers and keeps the complete landing ladder', () => {
    for (const tier of ['express', 'standard', 'full'] as const) {
      expect(ObjectiveEnrollmentPayloadSchema.parse(payload({ tier })).tier).toBe(tier)
    }
    for (const landingBar of [
      'files-on-disk',
      'committed-local-branch',
      'pushed-ref',
      'hosted-review',
      'merged'
    ] as const) {
      expect(ObjectiveEnrollmentPayloadSchema.parse(payload({ landingBar })).landingBar).toBe(
        landingBar
      )
    }
  })

  it('keeps lane enrollment optional for older payloads and preserves an explicit opt-out', () => {
    expect(ObjectiveEnrollmentPayloadSchema.parse(payload()).lanesEnabled).toBeUndefined()
    expect(
      ObjectiveEnrollmentPayloadSchema.parse(payload({ lanesEnabled: false })).lanesEnabled
    ).toBe(false)
  })

  it('accepts the canonical whole-workspace territory', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.parse(
        payload({ writeTerritory: [OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB] })
      ).writeTerritory
    ).toEqual([OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB])
  })

  it('canonicalizes and bounds the optional existing plan', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.parse(
        payload({ existingPlan: ' \n# Existing plan\n\n- Keep this task. \n' })
      ).existingPlan
    ).toBe('# Existing plan\n\n- Keep this task.')
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ existingPlan: ' \n\t ' })).success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(
        payload({ existingPlan: 'x'.repeat(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH + 1) })
      ).success
    ).toBe(false)
  })

  it('rejects unknown fields and enforces objective text in UTF-16 code units', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse({ ...payload(), ignored: true }).success
    ).toBe(false)

    const multibyteObjective = '界'.repeat(OBJECTIVE_TEXT_MAX_LENGTH)
    expect(Buffer.byteLength(multibyteObjective, 'utf8')).toBeGreaterThan(OBJECTIVE_TEXT_MAX_LENGTH)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ objectiveText: multibyteObjective }))
        .success
    ).toBe(true)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(
        payload({ objectiveText: `${multibyteObjective}界` })
      ).success
    ).toBe(false)
  })

  it.each([
    '../src/**',
    '/tmp/**',
    'C:/repo/**',
    '.git/**',
    '.quirky/**',
    '*/**',
    'src/../secrets/**',
    'src\\**'
  ])('rejects territory that can escape or address protected state: %s', (territory) => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ writeTerritory: [territory] })).success
    ).toBe(false)
  })

  it('rejects duplicate or excessive territory entries', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ writeTerritory: ['src/**', 'src/**'] }))
        .success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(
        payload({ writeTerritory: Array.from({ length: 65 }, (_, index) => `src/${index}/**`) })
      ).success
    ).toBe(false)
  })

  it('derives the exact default capability modes from the landing bar', () => {
    expect(objectiveCapabilityModes('files-on-disk')).toEqual({
      plan: 'gated',
      implement: 'on',
      review: 'on',
      check: 'on',
      land: 'on'
    })
    expect(objectiveCapabilityModes('merged').land).toBe('gated')
  })

  it('requires exactly the five objective capability keys', () => {
    const capabilities = objectiveCapabilityModes('files-on-disk')
    expect(ObjectiveCapabilitiesSchema.safeParse(capabilities).success).toBe(true)
    expect(
      ObjectiveCapabilitiesSchema.safeParse({
        plan: 'gated',
        implement: 'on',
        review: 'on',
        check: 'on'
      }).success
    ).toBe(false)
    expect(
      ObjectiveCapabilitiesSchema.safeParse({ ...capabilities, unexpected: 'on' }).success
    ).toBe(false)
  })

  it('parses an enrollment with no owner-intervention key exactly as it did before that key existed', () => {
    const capabilities = objectiveCapabilityModes('files-on-disk')
    const parsed = ObjectiveCapabilitiesSchema.parse(capabilities)
    expect(parsed).toEqual(capabilities)
    expect('owner-intervention' in parsed).toBe(false)
  })

  it('parses an owner-intervention key the kernel stamps onto an owner-configured enrollment', () => {
    const capabilities = {
      ...objectiveCapabilityModes('files-on-disk'),
      'owner-intervention': 'on' as const
    }
    const parsed = ObjectiveCapabilitiesSchema.safeParse(capabilities)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data['owner-intervention']).toBe('on')
  })

  it('accepts a valid gate list and parses a payload without gates', () => {
    const gates = [gate({ name: 'lint' }), gate({ name: 'typecheck-node', timeoutSeconds: 600 })]
    expect(ObjectiveEnrollmentPayloadSchema.parse(payload({ gates })).gates).toEqual(gates)
    expect(ObjectiveEnrollmentPayloadSchema.parse(payload()).gates).toBeUndefined()
  })

  it.each(['Lint', '-x', 'a'.repeat(41)])('rejects an invalid gate name: %s', (name) => {
    expect(ObjectiveGateSchema.safeParse(gate({ name })).success).toBe(false)
  })

  it('rejects an empty gate command', () => {
    expect(ObjectiveGateSchema.safeParse(gate({ command: '' })).success).toBe(false)
  })

  it.each([9, 14_401, 1.5])(
    'rejects an out-of-range or non-integer gate timeout: %s',
    (timeoutSeconds) => {
      expect(ObjectiveGateSchema.safeParse(gate({ timeoutSeconds })).success).toBe(false)
    }
  )

  it('rejects duplicate gate names', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(
        payload({ gates: [gate({ name: 'lint' }), gate({ name: 'lint' })] })
      ).success
    ).toBe(false)
  })

  it('rejects more than the maximum number of declared gates', () => {
    const gates = Array.from({ length: OBJECTIVE_GATES_MAX + 1 }, (_, index) =>
      gate({ name: `gate-${index}` })
    )
    expect(ObjectiveEnrollmentPayloadSchema.safeParse(payload({ gates })).success).toBe(false)
  })

  it('keeps roleLaunch optional and parses a per-role model/effort override', () => {
    expect(ObjectiveEnrollmentPayloadSchema.parse(payload()).roleLaunch).toBeUndefined()
    const roleLaunch = {
      planner: { model: 'opus' },
      reviewer: { effort: 'low' as const }
    }
    expect(ObjectiveEnrollmentPayloadSchema.parse(payload({ roleLaunch })).roleLaunch).toEqual(
      roleLaunch
    )
  })

  it('rejects an out-of-bounds model or an invalid effort', () => {
    expect(ObjectiveRoleLaunchSchema.safeParse({ planner: { model: '' } }).success).toBe(false)
    expect(
      ObjectiveRoleLaunchSchema.safeParse({
        planner: { model: 'x'.repeat(OBJECTIVE_LAUNCH_MODEL_MAX_LENGTH + 1) }
      }).success
    ).toBe(false)
    expect(ObjectiveRoleLaunchSchema.safeParse({ planner: { effort: 'extreme' } }).success).toBe(
      false
    )
  })

  it('rejects a role key outside the objective role set and unknown fields on an entry', () => {
    expect(ObjectiveRoleLaunchSchema.safeParse({ owner: { model: 'opus' } }).success).toBe(false)
    expect(
      ObjectiveRoleLaunchSchema.safeParse({ planner: { model: 'opus', temperature: 0.2 } }).success
    ).toBe(false)
  })
})
