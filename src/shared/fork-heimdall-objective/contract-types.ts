import { z } from 'zod'
import { OWNER_INTERVENTION_CAPABILITY } from '../fork-heimdall/owner/owner-capability'
import { CapabilityModeSchema } from '../fork-heimdall/watcher-types'

/**
 * Zod string maxima in the objective contract use JavaScript `string.length`: UTF-16 code units,
 * not Unicode code points or UTF-8 bytes. File and transport byte caps are separate contracts.
 */
export const OBJECTIVE_TEXT_MAX_LENGTH = 16_384
export const OBJECTIVE_TASK_SPEC_MAX_LENGTH = 16_384
export const OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH = OBJECTIVE_TASK_SPEC_MAX_LENGTH
export const OBJECTIVE_CRITERION_NOTE_MAX_LENGTH = 4_096
export const OBJECTIVE_TASK_KEY_MAX_LENGTH = 128
export const OBJECTIVE_TASK_TITLE_MAX_LENGTH = 512
export const OBJECTIVE_CRITERION_BODY_MAX_LENGTH = 2_048
export const OBJECTIVE_CHECK_COMMAND_MAX_LENGTH = 8_192
export const OBJECTIVE_EXISTING_PLAN_MAX_LENGTH = 65_536
export const OBJECTIVE_TERRITORY_MAX_ENTRIES = 64
export const OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB = '**'
export const OBJECTIVE_PATH_MAX_LENGTH = 1_024
export const OBJECTIVE_AGENT_ID_MAX_LENGTH = 256
export const OBJECTIVE_ABSENT_REMOTE_REF_STATE = 'unborn'
export const OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS = 1_800
export const OBJECTIVE_GATE_MIN_TIMEOUT_SECONDS = 10
export const OBJECTIVE_GATE_MAX_TIMEOUT_SECONDS = 14_400
export const OBJECTIVE_GATES_MAX = 8
export const OBJECTIVE_GATE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u

/** Cap on a planner task's serialized JSON size, matching what a dispatch record can durably store. */
export const OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES = 16 * 1_024

/** Measures a task snapshot exactly as `ObjectiveDispatchRecordSchema`'s size check does. */
export function objectiveDispatchTaskSnapshotByteLength(task: unknown): number {
  return new TextEncoder().encode(JSON.stringify(task)).byteLength
}

const BoundedTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum)

export const ObjectiveTierSchema = z.enum(['express', 'standard', 'full'])
export type ObjectiveTier = z.infer<typeof ObjectiveTierSchema>

export const ObjectiveLandingBarSchema = z.enum([
  'files-on-disk',
  'committed-local-branch',
  'pushed-ref',
  'hosted-review',
  'merged'
])
export type ObjectiveLandingBar = z.infer<typeof ObjectiveLandingBarSchema>

export const ObjectiveWorkspaceKindSchema = z.enum(['git', 'folder'])
export type ObjectiveWorkspaceKind = z.infer<typeof ObjectiveWorkspaceKindSchema>

export const ObjectiveRoleSchema = z.enum(['planner', 'implementer', 'reviewer', 'integrator'])
export type ObjectiveRole = z.infer<typeof ObjectiveRoleSchema>

export const OBJECTIVE_ROLES = ObjectiveRoleSchema.options
export const OBJECTIVE_CAPABILITY_KEYS = ['plan', 'implement', 'review', 'check', 'land'] as const
export type ObjectiveCapabilityKey = (typeof OBJECTIVE_CAPABILITY_KEYS)[number]
export const ObjectiveCapabilitiesSchema = z
  .object({
    plan: CapabilityModeSchema,
    implement: CapabilityModeSchema,
    review: CapabilityModeSchema,
    check: CapabilityModeSchema,
    land: CapabilityModeSchema,
    // system-derived (stamped by authorizeKindEnrollment when a caller configures an owner), never
    // part of OBJECTIVE_CAPABILITY_KEYS's user-facing capability picker; absent means off
    [OWNER_INTERVENTION_CAPABILITY]: CapabilityModeSchema.optional()
  })
  .strict()
export type ObjectiveCapabilities = z.infer<typeof ObjectiveCapabilitiesSchema>

export const ObjectiveRoleAgentsSchema = z
  .object({
    planner: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional(),
    implementer: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional(),
    reviewer: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional(),
    integrator: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional()
  })
  .strict()
export type ObjectiveRoleAgents = z.infer<typeof ObjectiveRoleAgentsSchema>

export const OBJECTIVE_LAUNCH_MODEL_MAX_LENGTH = 128
export const ObjectiveLaunchEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type ObjectiveLaunchEffort = z.infer<typeof ObjectiveLaunchEffortSchema>

export const ObjectiveRoleLaunchEntrySchema = z
  .object({
    model: BoundedTextSchema(OBJECTIVE_LAUNCH_MODEL_MAX_LENGTH).optional(),
    effort: ObjectiveLaunchEffortSchema.optional()
  })
  .strict()
export type ObjectiveRoleLaunchEntry = z.infer<typeof ObjectiveRoleLaunchEntrySchema>

/** Absent means today's behavior: the agent CLI's own model/effort defaults. */
export const ObjectiveRoleLaunchSchema = z
  .object({
    planner: ObjectiveRoleLaunchEntrySchema.optional(),
    implementer: ObjectiveRoleLaunchEntrySchema.optional(),
    reviewer: ObjectiveRoleLaunchEntrySchema.optional(),
    integrator: ObjectiveRoleLaunchEntrySchema.optional()
  })
  .strict()
export type ObjectiveRoleLaunch = z.infer<typeof ObjectiveRoleLaunchSchema>

export const ObjectiveSitterOverridesSchema = z
  .object({
    updateBranch: CapabilityModeSchema.optional(),
    resolveConflicts: CapabilityModeSchema.optional(),
    fixChecks: CapabilityModeSchema.optional(),
    merge: CapabilityModeSchema.optional()
  })
  .strict()
export type ObjectiveSitterOverrides = z.infer<typeof ObjectiveSitterOverridesSchema>

function wildcardMatches(value: string, pattern: string): boolean {
  let expression = '^'
  for (const character of pattern) {
    if (character === '*') {
      expression += '.*'
    } else if (character === '?') {
      expression += '.'
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`, 'u').test(value)
}

function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) {
      return true
    }
  }
  return false
}

export function isWorkspaceRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > OBJECTIVE_PATH_MAX_LENGTH ||
    value !== value.trim() ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    hasPathControlCharacter(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false
  }
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}
export function isObjectiveConcreteWorkspacePath(value: string): boolean {
  if (!isWorkspaceRelativePath(value) || /[*?[\]{}()!]/u.test(value)) {
    return false
  }
  const root = value.split('/', 1)[0]
  return root !== '.git' && root !== '.quirky'
}

export const ObjectiveWorkspacePathSchema = z
  .string()
  .max(OBJECTIVE_PATH_MAX_LENGTH)
  .refine(isObjectiveConcreteWorkspacePath, 'Path must be a concrete workspace-relative path')

export function isAllowedObjectiveTerritoryGlob(value: string): boolean {
  if (!isWorkspaceRelativePath(value) || /[[\]{}()!]/u.test(value)) {
    return false
  }
  if (value === OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB) {
    return true
  }
  const slash = value.indexOf('/')
  const root = slash === -1 ? value : value.slice(0, slash)
  return !wildcardMatches('.git', root) && !wildcardMatches('.quirky', root)
}

export const ObjectiveTerritoryGlobSchema = z
  .string()
  .max(OBJECTIVE_PATH_MAX_LENGTH)
  .refine(
    isAllowedObjectiveTerritoryGlob,
    'Territory must be ** or a bounded workspace-relative glob that excludes .git and .quirky'
  )

export const ObjectiveGateSchema = z
  .object({
    name: z.string().regex(OBJECTIVE_GATE_NAME_PATTERN),
    command: z.string().trim().min(1).max(OBJECTIVE_CHECK_COMMAND_MAX_LENGTH),
    timeoutSeconds: z
      .number()
      .int()
      .min(OBJECTIVE_GATE_MIN_TIMEOUT_SECONDS)
      .max(OBJECTIVE_GATE_MAX_TIMEOUT_SECONDS)
  })
  .strict()
export type ObjectiveGate = z.infer<typeof ObjectiveGateSchema>

export const ObjectiveEnrollmentPayloadSchema = z
  .object({
    objectiveText: BoundedTextSchema(OBJECTIVE_TEXT_MAX_LENGTH),
    existingPlan: BoundedTextSchema(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH).optional(),
    tier: ObjectiveTierSchema,
    landingBar: ObjectiveLandingBarSchema,
    lanesEnabled: z.boolean().optional(),
    maxConcurrency: z.number().int().min(1).max(1_024),
    workspaceKind: ObjectiveWorkspaceKindSchema,
    writeTerritory: z
      .array(ObjectiveTerritoryGlobSchema)
      .min(1)
      .max(OBJECTIVE_TERRITORY_MAX_ENTRIES)
      .refine((values) => new Set(values).size === values.length, 'Territory globs must be unique'),
    roleAgents: ObjectiveRoleAgentsSchema,
    roleLaunch: ObjectiveRoleLaunchSchema.optional(),
    sitterOverrides: ObjectiveSitterOverridesSchema,
    gates: z
      .array(ObjectiveGateSchema)
      .max(OBJECTIVE_GATES_MAX)
      .refine(
        (values) => new Set(values.map((gate) => gate.name)).size === values.length,
        'Gate names must be unique'
      )
      .optional()
  })
  .strict()
export type ObjectiveEnrollmentPayload = z.infer<typeof ObjectiveEnrollmentPayloadSchema>

export const ObjectiveNewWorktreeRequestSchema = z
  .object({
    name: BoundedTextSchema(OBJECTIVE_PATH_MAX_LENGTH),
    baseBranch: BoundedTextSchema(OBJECTIVE_PATH_MAX_LENGTH).optional()
  })
  .strict()
export type ObjectiveNewWorktreeRequest = z.infer<typeof ObjectiveNewWorktreeRequestSchema>

/** newWorktree is request-only and must never be persisted in an enrollment contract. */
export const ObjectiveEnrollmentRequestSchema = ObjectiveEnrollmentPayloadSchema.extend({
  newWorktree: ObjectiveNewWorktreeRequestSchema.optional()
}).strict()
export type ObjectiveEnrollmentRequest = z.infer<typeof ObjectiveEnrollmentRequestSchema>

export function objectiveCapabilityModes(landingBar: ObjectiveLandingBar): ObjectiveCapabilities {
  return {
    plan: 'gated',
    implement: 'on',
    review: 'on',
    check: 'on',
    land: landingBar === 'files-on-disk' ? 'on' : 'gated'
  }
}
