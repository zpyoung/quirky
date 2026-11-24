import { createHash } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import type { ZodIssue } from 'zod'
import {
  IntegratorReportSchema,
  ImplementerReportSchema,
  PlannerReportSchema,
  ReviewerReportSchema,
  type IntegratorReport,
  type ImplementerReport,
  type PlannerReport,
  type ReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  PlannerRepairReportSchema,
  type PlannerRepairReport
} from '../../shared/fork-heimdall-objective/plan-repair-schema'
import {
  PlanReviewReportSchema,
  type PlanReviewReport
} from '../../shared/fork-heimdall-objective/plan-review-schema'
import { resolveGitMetadataPath } from '../../shared/git-metadata-path'
import { localGitOptionsForTarget } from '../runtime/runtime-git-command-target'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import {
  readHardenedReportBytes,
  type HardenedReportBytes
} from '../fork-heimdall/hardened-report-file-reader'
import { objectiveGitCommandForTarget, type ObjectiveWorkspaceTarget } from './content-identity'

export const MAX_OBJECTIVE_REPORT_BYTES = 256 * 1024
const MAX_REPORT_SCHEMA_ISSUES = 5
const MAX_REPORT_SCHEMA_ISSUE_MESSAGE_CHARS = 512
const MAX_REPORT_SCHEMA_DETAIL_CHARS = 2_048

// 'plan-review' is an internal report-kind, not a wire ObjectiveRole: the plan critic is still the
// dispatched `reviewer` role, just reading a differently-shaped report file.
export type ObjectiveReportRole =
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'integrator'
  | 'plan-review'
export type ObjectiveRoleReport =
  | PlannerReport
  | PlannerRepairReport
  | ImplementerReport
  | ReviewerReport
  | IntegratorReport
  | PlanReviewReport

type ObjectiveReportByRole = {
  planner: PlannerReport | PlannerRepairReport
  implementer: ImplementerReport
  reviewer: ReviewerReport
  integrator: IntegratorReport
  'plan-review': PlanReviewReport
}

export type ObjectiveReportReadFailureReason =
  | 'path-mismatch'
  | 'missing'
  | 'oversize'
  | 'binary'
  | 'malformed'
  | 'role-mismatch'
  | 'task-mismatch'

type ObjectiveReportReadFailure = {
  ok: false
  reason: ObjectiveReportReadFailureReason
  detail?: string
  /**
   * The parsed JSON when the file read as valid JSON but failed role/schema validation, absent for
   * every other failure reason. Lets a repair-shaped report that reads but doesn't validate still
   * reach `ingestObjectivePlanRepair` and land as a stored rejected patch (X1).
   */
  rawInput?: unknown
}

type ObjectiveReportReadSuccess<R extends ObjectiveReportRole> = R extends ObjectiveReportRole
  ? {
      ok: true
      role: R
      path: string
      report: ObjectiveReportByRole[R]
      reportDigest: string
    }
  : never

export type ObjectiveRoleReportReadResult<R extends ObjectiveReportRole = ObjectiveReportRole> =
  | ObjectiveReportReadSuccess<R>
  | ObjectiveReportReadFailure

export type ObjectiveRoleReportReadRequest<R extends ObjectiveReportRole = ObjectiveReportRole> = {
  target: ObjectiveWorkspaceTarget
  attemptFingerprint: string
  mailboxReportPath: string | null | undefined
  role: R
  taskKey?: string
  /**
   * Selects the planner report contract; ignored for other roles. Omit when the originating
   * `dispatch-planner` action isn't known here — a 'planner' role then accepts either shape.
   */
  plannerMode?: 'full' | 'repair'
}

function fingerprintFileName(attemptFingerprint: string): string {
  return `${createHash('sha256').update(attemptFingerprint).digest('hex')}.json`
}

type ObjectiveReportLocation = { authorityRoot: string; directory: string }

async function resolveObjectiveReportLocation(
  target: ObjectiveWorkspaceTarget
): Promise<ObjectiveReportLocation> {
  if (target.kind === 'folder') {
    if (target.executionHostId !== 'local') {
      throw new Error('Remote objective target is not served by this host')
    }
    const pathFlavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
    return {
      authorityRoot: target.workspacePath,
      directory: pathFlavor.join(
        target.workspacePath,
        '.quirky',
        'heimdall',
        'objective',
        'reports'
      )
    }
  }

  const gitTarget = target.gitTarget
  if (!gitTarget) {
    throw new Error('Git objective target has no runtime Git target')
  }
  const rawGitDirectory = (
    await objectiveGitCommandForTarget(target)(['rev-parse', '--absolute-git-dir'])
  ).stdout.replace(/\r?\n$/u, '')
  if (!rawGitDirectory) {
    throw new Error('Git did not return an absolute git directory')
  }
  const gitDirectory = resolveGitMetadataPath(
    target.workspacePath,
    rawGitDirectory,
    localGitOptionsForTarget(gitTarget)
  )
  if (!gitDirectory) {
    throw new Error('Git returned an unusable git directory')
  }
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, gitDirectory)
  return {
    authorityRoot: gitDirectory,
    directory: pathFlavor.join(gitDirectory, 'quirky-heimdall', 'objective', 'reports')
  }
}

function reportPathForLocation(
  target: ObjectiveWorkspaceTarget,
  location: ObjectiveReportLocation,
  attemptFingerprint: string
): string {
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, location.directory)
  return pathFlavor.join(location.directory, fingerprintFileName(attemptFingerprint))
}

export async function resolveExpectedObjectiveReportPath(
  target: ObjectiveWorkspaceTarget,
  attemptFingerprint: string
): Promise<string> {
  const location = await resolveObjectiveReportLocation(target)
  return reportPathForLocation(target, location, attemptFingerprint)
}

export async function issueObjectiveReportPath(
  target: ObjectiveWorkspaceTarget,
  attemptFingerprint: string
): Promise<string> {
  const location = await resolveObjectiveReportLocation(target)
  if (target.executionHostId !== 'local') {
    throw new Error('Remote objective target is not served by this host')
  }
  await mkdir(location.directory, { recursive: true, mode: 0o700 })
  await chmod(location.directory, 0o700)
  return reportPathForLocation(target, location, attemptFingerprint)
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  let formatted = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`
      continue
    }
    const field = String(segment)
    formatted += formatted.length === 0 ? field : `.${field}`
  }
  return formatted || 'report'
}

function formatReportSchemaIssues(issues: readonly ZodIssue[]): string {
  const issueDetails = issues
    .slice(0, MAX_REPORT_SCHEMA_ISSUES)
    .map((issue) => {
      const message =
        issue.message.length <= MAX_REPORT_SCHEMA_ISSUE_MESSAGE_CHARS
          ? issue.message
          : `${issue.message.slice(0, MAX_REPORT_SCHEMA_ISSUE_MESSAGE_CHARS - 1)}…`
      return `${formatIssuePath(issue.path)}: ${message}`
    })
    .join('\n')
  const omittedIssueCount = Math.max(0, issues.length - MAX_REPORT_SCHEMA_ISSUES)
  if (omittedIssueCount > 0) {
    const omittedSummary = `+ ${omittedIssueCount} more issues`
    const availableIssueChars = MAX_REPORT_SCHEMA_DETAIL_CHARS - omittedSummary.length - 1
    const boundedIssueDetails =
      issueDetails.length <= availableIssueChars
        ? issueDetails
        : `${issueDetails.slice(0, availableIssueChars - 1)}…`
    return `${boundedIssueDetails}\n${omittedSummary}`
  }
  if (issueDetails.length <= MAX_REPORT_SCHEMA_DETAIL_CHARS) {
    return issueDetails
  }
  return `${issueDetails.slice(0, MAX_REPORT_SCHEMA_DETAIL_CHARS - 1)}…`
}

/**
 * A repair dispatch only ever accepts the repair schema, and a known full dispatch only the full
 * schema — those are today's exact behaviors. A caller with no action to check `plannerMode` against
 * passes no `plannerMode`, which tries the full schema first (preserving its error detail on a
 * total mismatch) and falls back to the repair schema, so either report shape still parses.
 */
function parsePlannerReport(
  input: unknown,
  plannerMode: 'full' | 'repair' | undefined
):
  | { success: true; data: PlannerReport | PlannerRepairReport }
  | { success: false; detail: string } {
  if (plannerMode === 'repair') {
    const repair = PlannerRepairReportSchema.safeParse(input)
    return repair.success
      ? { success: true, data: repair.data }
      : { success: false, detail: formatReportSchemaIssues(repair.error.issues) }
  }
  const full = PlannerReportSchema.safeParse(input)
  if (full.success) {
    return { success: true, data: full.data }
  }
  if (plannerMode === undefined) {
    const repair = PlannerRepairReportSchema.safeParse(input)
    if (repair.success) {
      return { success: true, data: repair.data }
    }
  }
  return { success: false, detail: formatReportSchemaIssues(full.error.issues) }
}

function parseReportForRole<R extends ObjectiveReportRole>(
  role: R,
  input: unknown,
  plannerMode: 'full' | 'repair' | undefined
): { success: true; data: ObjectiveReportByRole[R] } | { success: false; detail: string } {
  if (role === 'planner') {
    const parsed = parsePlannerReport(input, plannerMode)
    return parsed.success
      ? {
          success: true,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the `role === 'planner'` check just above ties R to 'planner', but TS cannot correlate a runtime literal check to the generic indexed-access type ObjectiveReportByRole[R].
          data: parsed.data as ObjectiveReportByRole[R]
        }
      : parsed
  }
  const result =
    role === 'implementer'
      ? ImplementerReportSchema.safeParse(input)
      : role === 'reviewer'
        ? ReviewerReportSchema.safeParse(input)
        : role === 'plan-review'
          ? PlanReviewReportSchema.safeParse(input)
          : IntegratorReportSchema.safeParse(input)
  return result.success
    ? {
        success: true,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the role branch above ties R's schema to the parsed result, but TS cannot correlate a runtime literal check to the generic indexed-access type ObjectiveReportByRole[R].
        data: result.data as ObjectiveReportByRole[R]
      }
    : { success: false, detail: formatReportSchemaIssues(result.error.issues) }
}

function matchesAnotherRole(input: unknown, expectedRole: ObjectiveReportRole): boolean {
  return (
    (expectedRole !== 'planner' &&
      (PlannerReportSchema.safeParse(input).success ||
        PlannerRepairReportSchema.safeParse(input).success)) ||
    (expectedRole !== 'implementer' && ImplementerReportSchema.safeParse(input).success) ||
    (expectedRole !== 'reviewer' && ReviewerReportSchema.safeParse(input).success) ||
    (expectedRole !== 'integrator' && IntegratorReportSchema.safeParse(input).success) ||
    (expectedRole !== 'plan-review' && PlanReviewReportSchema.safeParse(input).success)
  )
}

type ReportBytes = HardenedReportBytes

async function readReportBytes(
  target: ObjectiveWorkspaceTarget,
  reportPath: string,
  authorityRoot: string
): Promise<ReportBytes | ObjectiveReportReadFailure> {
  if (target.executionHostId !== 'local') {
    throw new Error('Remote objective target is not served by this host')
  }
  return await readHardenedReportBytes({
    executionHostId: target.executionHostId,
    reportPath,
    authorityRoot,
    maxBytes: MAX_OBJECTIVE_REPORT_BYTES
  })
}

export async function readObjectiveRoleReport<R extends ObjectiveReportRole>(
  request: ObjectiveRoleReportReadRequest<R>
): Promise<ObjectiveRoleReportReadResult<R>> {
  const location = await resolveObjectiveReportLocation(request.target)
  const expectedPath = reportPathForLocation(request.target, location, request.attemptFingerprint)
  if (request.mailboxReportPath !== expectedPath) {
    return { ok: false, reason: 'path-mismatch' }
  }
  const read = await readReportBytes(request.target, expectedPath, location.authorityRoot)
  if ('ok' in read) {
    return read
  }
  if (read.binary) {
    return { ok: false, reason: 'binary' }
  }

  let input: unknown
  try {
    input = JSON.parse(read.buffer.toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = parseReportForRole(request.role, input, request.plannerMode)
  if (!parsed.success) {
    const reason = matchesAnotherRole(input, request.role) ? 'role-mismatch' : 'malformed'
    return {
      ok: false,
      reason,
      rawInput: input,
      ...(reason === 'malformed' ? { detail: parsed.detail } : {})
    }
  }
  if (
    request.role === 'implementer' &&
    request.taskKey !== undefined &&
    'taskKey' in parsed.data &&
    parsed.data.taskKey !== request.taskKey
  ) {
    return { ok: false, reason: 'task-mismatch' }
  }
  // The parser selection and the returned role share the same generic; TypeScript cannot
  // preserve that correlation while constructing a distributive conditional type.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parseReportForRole(request.role, ...) already ties `parsed.data` to `request.role`'s report shape; TS cannot express that correlation through ObjectiveReportReadSuccess<R>'s distributive conditional type.
  const success = {
    ok: true,
    role: request.role,
    path: expectedPath,
    report: parsed.data,
    reportDigest: createHash('sha256').update(read.buffer).digest('hex')
  } as ObjectiveReportReadSuccess<R>
  return success
}
