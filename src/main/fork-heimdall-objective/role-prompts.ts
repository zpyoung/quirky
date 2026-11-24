import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../shared/orchestration-worker-start-prompt-budget'
import type {
  ObjectiveBudgetBucket,
  ObjectiveNodeState,
  ObjectiveReviewRole
} from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveFailureClass } from '../../shared/fork-heimdall/effect-certainty'
import {
  OBJECTIVE_CHECK_COMMAND_MAX_LENGTH,
  OBJECTIVE_CRITERION_BODY_MAX_LENGTH,
  OBJECTIVE_CRITERION_NOTE_MAX_LENGTH,
  OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES,
  OBJECTIVE_PATH_MAX_LENGTH,
  OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH,
  OBJECTIVE_TASK_KEY_MAX_LENGTH,
  OBJECTIVE_TASK_SPEC_MAX_LENGTH,
  OBJECTIVE_TASK_TITLE_MAX_LENGTH,
  OBJECTIVE_TERRITORY_MAX_ENTRIES,
  type ObjectiveEnrollmentPayload,
  type ObjectiveRole
} from '../../shared/fork-heimdall-objective/contract-types'
import {
  OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES,
  OBJECTIVE_PLAN_MAX_TASKS,
  OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH,
  OBJECTIVE_REPORT_MAX_FILES,
  OBJECTIVE_TASK_MAX_CRITERIA,
  type ObjectivePlan,
  type ImplementerReport,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectivePlanDiff } from '../../shared/fork-heimdall-objective/plan-diff'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { Store } from '../persistence'
import { buildPlannerPromptPolicySection } from './planner-prompt-policy'
import { fitRepairPlanContext, type RepairPlanContext } from './repair-plan-context'
import { MAX_OBJECTIVE_REPORT_BYTES } from './report-ingestion'

/**
 * Reserves room for the OMITTED line and section separators the repair-context fit pass appends
 * after budgeting the context itself; sized for a worst case of every plan task naming a full-length
 * key in up to two omission phrases (frozen tasks can be trimmed twice: summary, then key-only).
 */
const REPAIR_CONTEXT_SEPARATOR_RESERVE_BYTES =
  OBJECTIVE_PLAN_MAX_TASKS * 2 * (OBJECTIVE_TASK_KEY_MAX_LENGTH + 40)

/** A planner replan may carry a node failure, a gate failure, or both; each renders independently. */
export type ObjectiveFailureContext = {
  taskKey?: string
  failureClass?: ObjectiveFailureClass
  narrative?: string
  failingCriteria?: readonly string[]
  gateFailure?: {
    gateName: string
    command: string
    exitCode: number | null
    timedOut: boolean | null
    stdoutTail: string | null
    stderrTail: string | null
    /** Set when the gate attempt itself never completed, so there is no exit code or output to show. */
    detail?: string
  }
  /** A prior repair patch's rejection text, for a rejection other than a plan-review `revise`. */
  previousRepairRejection?: string
}

export type ObjectiveConflictContext = {
  enrolledHead: string
  paths: readonly string[]
  resolving: {
    dispatchId: string
    task: ObjectivePlanTask
    report: ImplementerReport | null
  }
  conflicting: readonly {
    dispatchId: string
    task: ObjectivePlanTask
    report: ImplementerReport | null
  }[]
}

export type ObjectiveRolePromptInput = {
  role: ObjectiveRole
  contract: ObjectiveEnrollmentPayload
  reportPath: string
  budgetBucket: ObjectiveBudgetBucket
  /** The kernel's live parallel dispatch cap, read at dispatch time so it tracks `set-concurrency`. */
  effectiveMaxConcurrency: number
  /** Whether one-to-one dependency chains ("lanes") share one warm session for this run. */
  lanesEnabled: boolean
  node?: ObjectivePlanTask
  plan?: ObjectivePlan
  reason?: 'initial' | 'replan-after-block' | 'replan-after-failure' | 'owner-directed'
  failureContext?: ObjectiveFailureContext
  conflictContext?: ObjectiveConflictContext
  planProgress?: readonly { taskKey: string; state: ObjectiveNodeState }[]
  /** Landing-ladder stage named by a `skip-stage` intervention, separate from its rationale. */
  requestedSkipStage?: string
  /** Free-text steer from an owning agent's `dispatch-planner` or `set-role-agent` intervention. */
  ownerGuidance?: string
  /** Selects the planner report contract: a full plan, or a patch against the frozen plan. */
  plannerMode?: 'full' | 'repair'
  /** Open/frozen task context for a repair planner prompt; ignored unless `plannerMode` is `'repair'`. */
  repairContext?: RepairPlanContext
  /** Prior plan-review verdict text to react to, for either report shape. */
  planReviewFindings?: string
  /** Selects the plan-critic reviewer contract in place of the normal review-the-files-on-disk mode. */
  mode?: 'plan-review'
  /** Absolute path to the plan-review input file the dispatch executor wrote beside the report path. */
  planReviewInputPath?: string
  /** Compact plan summary (task key, title, deps, territory, lint codes) inlined for mode 'plan-review'. */
  planReviewSummary?: string
  /** Set only when the plan-review target qualifies for a delta review of a revised draft. */
  planReviewDelta?: {
    priorBlockingFindings: readonly string[]
    diff: ObjectivePlanDiff
    carryEligible: readonly number[]
  }
}

const STRING_UNIT_NOTE =
  'String maxima below use JavaScript UTF-16 code units (`string.length`), not UTF-8 bytes.'

/** Task-shape limits shared by the full-plan and repair report contracts. */
function plannerTaskLimitLines(): string[] {
  return [
    `taskKey has max ${OBJECTIVE_TASK_KEY_MAX_LENGTH}; title max ${OBJECTIVE_TASK_TITLE_MAX_LENGTH}; spec max ${OBJECTIVE_TASK_SPEC_MAX_LENGTH}. Summarize context and cite existing files or artifacts instead of pasting unlimited verbatim output.`,
    `The whole task — taskKey, title, spec, deps, criteria, territory and declaredPaths together — must serialize to under ${OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES} bytes of JSON; a task over that limit can never dispatch, so split it instead of maximizing every field.`,
    `deps has max ${OBJECTIVE_PLAN_MAX_TASKS} task keys. criteria has 1-${OBJECTIVE_TASK_MAX_CRITERIA} entries.`,
    `Each criterion is {body,shellCheckable,checkCommand}; body has max ${OBJECTIVE_CRITERION_BODY_MAX_LENGTH}; checkCommand is null exactly when shellCheckable is false, otherwise non-empty with max ${OBJECTIVE_CHECK_COMMAND_MAX_LENGTH}.`,
    `territory is required on every task: 1-${OBJECTIVE_TERRITORY_MAX_ENTRIES} globs inside write territory naming what it will modify.`,
    `When known, declaredPaths contains at most ${OBJECTIVE_REPORT_MAX_FILES} concrete workspace-relative file paths, each with max ${OBJECTIVE_PATH_MAX_LENGTH}, inside write territory.`,
    'Never use globs or copy write-territory patterns into declaredPaths; omit declaredPaths when exact files are unknown.',
    `assumptions is a required array (use [] when none), max ${OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES} entries, each {claim,dependentTaskKeys,evidence?} naming the task keys whose validity depends on the claim.`,
    'When you verified an assumption yourself, set evidence:{command,observed} to the command you ran and what it showed, so the reviewer can spot-check it instead of re-running everything; omit evidence for an assumption you did not verify.'
  ]
}

function plannerFullReportContract(): string {
  return [
    STRING_UNIT_NOTE,
    'Write one strict JSON object: {"plan":[task,...],"assumptions":[assumption,...]}.',
    `plan contains 1-${OBJECTIVE_PLAN_MAX_TASKS} tasks. Each task is {taskKey,title,spec,deps,criteria,declaresDependencyChange,territory,declaredPaths?}.`,
    ...plannerTaskLimitLines(),
    'Task keys are unique, dependencies name other tasks, and the graph is acyclic.'
  ].join('\n')
}

function plannerRepairReportContract(): string {
  return [
    STRING_UNIT_NOTE,
    'Write only open tasks: one strict JSON object {"repair":{"upsertTasks":[task,...],"dropTaskKeys":[taskKey,...]},"assumptions":[assumption,...]}.',
    'Frozen tasks cannot be changed or dropped; new tasks may depend on frozen tasks by their task key.',
    `upsertTasks and dropTaskKeys each has max ${OBJECTIVE_PLAN_MAX_TASKS} entries; a task key must not appear in both.`,
    'Each upserted task is {taskKey,title,spec,deps,criteria,declaresDependencyChange,territory,declaredPaths?}, using the same limits as a full plan task.',
    ...plannerTaskLimitLines()
  ].join('\n')
}

function planReviewReportContract(): string {
  return [
    STRING_UNIT_NOTE,
    'Write one strict JSON object: {verdict:"approve"|"revise"|"escalate",assumptions,findings,summary}.',
    `assumptions has exactly one entry per declared assumption index 0..n-1, max ${OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES}: {index,status:"verified"|"unverified",evidence,basis?}; evidence is plain text with max ${OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH}.`,
    `basis is "reverified"|"planner-evidence"|"carried" and describes how you reached the status, not a claim about the planner; omit it (or use "reverified") when you verified the assumption yourself. Use "planner-evidence" only on an index where the planner's assumption carries evidence, and trust it only within the spot-check rule below.`,
    `findings has max 128 entries: {taskKey:TaskKey|null,severity:"blocking"|"advisory",body}; body is plain text with max ${OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH}.`,
    `summary is plain text with max ${OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH}; state how many assumptions you reverified, trusted on planner evidence, and carried forward.`,
    'approve requires no blocking finding and no unverified assumption any task depends on.'
  ].join('\n')
}

function reportContract(
  role: ObjectiveRole,
  plannerMode: 'full' | 'repair' | undefined,
  mode: 'plan-review' | undefined
): string {
  if (role === 'reviewer' && mode === 'plan-review') {
    return planReviewReportContract()
  }
  switch (role) {
    case 'planner':
      return plannerMode === 'repair' ? plannerRepairReportContract() : plannerFullReportContract()
    case 'implementer':
      return [
        STRING_UNIT_NOTE,
        'Write one strict JSON object: {taskKey,summary,filesModified,criteriaSelfAssessment}.',
        `taskKey has max ${OBJECTIVE_TASK_KEY_MAX_LENGTH}. summary is plain text with max ${OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH}; summarize evidence instead of pasting unlimited verbatim output. If supporting evidence does not fit, write it to a fixture or sidecar file inside write territory, list that file in filesModified, and cite its path in the summary.`,
        `filesModified has max ${OBJECTIVE_REPORT_MAX_FILES} concrete workspace-relative paths, each with max ${OBJECTIVE_PATH_MAX_LENGTH}.`,
        `Assess every criterion exactly once with {criterionIndex,result:"pass"|"fail"|"unknown",note}; criteriaSelfAssessment has max ${OBJECTIVE_TASK_MAX_CRITERIA}, criterionIndex is 0-${OBJECTIVE_TASK_MAX_CRITERIA - 1}, and note is plain text with max ${OBJECTIVE_CRITERION_NOTE_MAX_LENGTH}.`,
        'pass: the criterion is met and you verified it. fail: the criterion is genuinely not met. unknown: you could not determine it, typically because something environmental blocked verification.',
        'Never report unknown for a criterion you know has failed, and never report pass for one you could not verify; an environment-dependent criterion you cannot verify is unknown, with a note on what blocked it.',
        'Every modified path must be workspace-relative and inside write territory.'
      ].join('\n')
    case 'reviewer':
      return [
        STRING_UNIT_NOTE,
        'Write one strict JSON object: {verdict:"approve"|"block",criteriaResults,summary}.',
        `summary is plain text with max ${OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH}; summarize evidence instead of pasting unlimited verbatim output. Put per-criterion evidence in each note (plain text, max ${OBJECTIVE_CRITERION_NOTE_MAX_LENGTH}) and cite existing evidence by location when fuller detail is needed.`,
        `criteriaResults has max ${OBJECTIVE_PLAN_MAX_TASKS * OBJECTIVE_TASK_MAX_CRITERIA} entries. Cover every plan criterion exactly once with {taskKey,criterionIndex,result:"pass"|"block",note}; taskKey has max ${OBJECTIVE_TASK_KEY_MAX_LENGTH} and criterionIndex is 0-${OBJECTIVE_TASK_MAX_CRITERIA - 1}.`,
        'The verdict must be block exactly when at least one criterion blocks.'
      ].join('\n')
    case 'integrator':
      return [
        STRING_UNIT_NOTE,
        'Write one strict JSON object: {verdict:"approve"|"block",criteriaResults,summary,checksRun}.',
        `summary is plain text with max ${OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH}; summarize evidence instead of pasting unlimited verbatim output. Put per-criterion evidence in each note (plain text, max ${OBJECTIVE_CRITERION_NOTE_MAX_LENGTH}); if fuller evidence must be preserved, write it to a fixture or sidecar file inside write territory and cite its path in the summary and worker_done filesModified.`,
        `criteriaResults has max ${OBJECTIVE_PLAN_MAX_TASKS * OBJECTIVE_TASK_MAX_CRITERIA} entries. Cover every plan criterion exactly once with {taskKey,criterionIndex,result:"pass"|"block",note}; taskKey has max ${OBJECTIVE_TASK_KEY_MAX_LENGTH} and criterionIndex is 0-${OBJECTIVE_TASK_MAX_CRITERIA - 1}.`,
        `checksRun has max ${OBJECTIVE_TASK_MAX_CRITERIA} entries shaped {command,exitCode}; command has max ${OBJECTIVE_CHECK_COMMAND_MAX_LENGTH}.`,
        'The verdict must be block exactly when at least one criterion blocks.'
      ].join('\n')
  }
}

function roleInstruction(input: ObjectiveRolePromptInput): string {
  switch (input.role) {
    case 'planner':
      return `Produce the next implementable plan. Planning reason: ${input.reason ?? 'initial'}. Do not edit files. Do not assert environment facts you only observed in your own shell as guaranteed for the implementer; write environment-dependent steps so the implementer verifies them itself. Criteria and verdicts must not depend on commit messages: node checks run after every node lands, so they see history that does not belong to any one node. Record evidence on an assumption only when you actually ran the command yourself; a fabricated or guessed evidence entry is worse than none, since the reviewer may trust it.`
    case 'implementer':
      if (!input.node) {
        throw new Error('An implementer prompt requires exactly one plan node')
      }
      return input.conflictContext
        ? `Resolve this node's integration conflict in its existing dispatch worktree. Rebase the dispatch branch onto exact enrolled HEAD ${input.conflictContext.enrolledHead}, resolve only with the intent and evidence below, and re-run focused checks for both sides. Run only the checks scoped to your task — never the full test suite, a whole-tree typecheck, or whole-tree lint. Never push this dispatch branch or any child-worktree branch.`
        : 'Implement only the assigned node. You may inspect context, but modify only declared write territory. Run only the checks scoped to your task — never the full test suite, a whole-tree typecheck, or whole-tree lint. Never push this dispatch branch or any child-worktree branch. Node history is append-only: make changes as new commits, and never amend, rebase, squash or reset an existing commit, even to fix a commit message. The watcher owns the commit subject and the task trailer; do not write either yourself.'
    case 'reviewer':
      return input.mode === 'plan-review'
        ? [
            'Review the plan before it is activated. Do not modify files. Read the input file at the given path, verify every declared assumption against the repository — read code and fixtures, or run read-only commands — and mark each verified (with evidence) or unverified. Judge task sizing, whether declared dependencies are real, whether checks are properly scoped, and the declared conflict pairs and lint findings. Return verdict approve, revise, or escalate. For an assumption the planner backed with evidence, you may trust it, but always re-verify (basis:"reverified") the ones with no evidence, any evidence you judge weak, and a spot check of the rest — at least 2 of them, or a quarter, whichever is more. If a spot check contradicts the planner\'s recorded evidence, stop trusting the hand-off: re-verify every assumption from scratch and say so in summary.',
            ...(input.planReviewDelta
              ? [
                  'This is a delta review of a revised draft. Confirm each finding under PRIOR BLOCKING FINDINGS below is resolved, and fully review every task named in the diff\'s affected set (and the assumptions those tasks depend on). You may mark an assumption basis:"carried" only at an index listed under CARRY-ELIGIBLE ASSUMPTION INDICES, and only when you accept the earlier verification as still valid.'
                ]
              : [])
          ].join(' ')
        : 'Review the files on disk against every active-plan criterion. Do not modify files. Criteria and verdicts must not depend on commit messages: judge file contents and check output.'
    case 'integrator':
      return 'Integrate and repair the files on disk as needed, then evaluate every active-plan criterion.'
  }
}

function planReviewView(plan: ObjectivePlan): unknown {
  return plan.map((task) => ({
    taskKey: task.taskKey,
    title: task.title,
    deps: task.deps,
    criteria: task.criteria
  }))
}

function existingPlanContext(input: ObjectiveRolePromptInput): string[] {
  const existingPlan = input.contract.existingPlan
  if (input.role !== 'planner' || !existingPlan) {
    return []
  }

  const normalizationInstruction =
    (input.reason ?? 'initial') === 'initial'
      ? [
          'Normalize the source plan into the strict planner report contract.',
          'Preserve its scope, tasks, dependencies, and acceptance criteria; only fill in details needed to make it executable under this objective contract.',
          'Do not replace it with a newly designed plan.'
        ].join('\n')
      : [
          'Use the source plan as context for this replan, adapting it as needed for the stated replanning reason while preserving the objective.',
          'Account for work already completed; do not force completed tasks to run again.'
        ].join('\n')

  return [
    `USER-SUPPLIED EXISTING PLAN SOURCE - BEGIN\n${existingPlan}\nUSER-SUPPLIED EXISTING PLAN SOURCE - END`,
    [
      normalizationInstruction,
      'The source is not direct-execution authorization: objective capability modes and approval gates remain unchanged.'
    ].join('\n')
  ]
}

function failureContextSection(input: ObjectiveRolePromptInput): string[] {
  if (input.role !== 'planner' || !input.failureContext) {
    return []
  }
  const {
    taskKey,
    failureClass,
    narrative,
    failingCriteria,
    gateFailure,
    previousRepairRejection
  } = input.failureContext
  const sections: string[] = []
  if (taskKey !== undefined && narrative !== undefined) {
    const lines = [
      `FAILED TASK: ${taskKey}${failureClass === undefined ? '' : ` (${failureClass})`}`,
      `WORKER NARRATIVE:\n${narrative}`
    ]
    if (failingCriteria !== undefined && failingCriteria.length > 0) {
      lines.push(
        `FAILING CRITERIA:\n${failingCriteria.map((criterion) => `- ${criterion}`).join('\n')}`
      )
    }
    sections.push(lines.join('\n'))
  }
  if (gateFailure !== undefined) {
    sections.push(
      [
        `FAILED OBJECTIVE GATE: ${gateFailure.gateName}`,
        `COMMAND: ${gateFailure.command}`,
        `EXIT CODE: ${gateFailure.exitCode === null ? '(none)' : gateFailure.exitCode}`,
        `TIMED OUT: ${gateFailure.timedOut === null ? '(unknown)' : String(gateFailure.timedOut)}`,
        `STDOUT TAIL:\n${gateFailure.stdoutTail ?? '(none)'}`,
        `STDERR TAIL:\n${gateFailure.stderrTail ?? '(none)'}`,
        ...(gateFailure.detail === undefined ? [] : [`DETAIL: ${gateFailure.detail}`])
      ].join('\n')
    )
  }
  if (previousRepairRejection !== undefined) {
    sections.push(`PREVIOUS REPAIR REJECTED:\n${previousRepairRejection}`)
  }
  return sections
}

function planProgressSection(input: ObjectiveRolePromptInput): string[] {
  if (input.role !== 'planner' || !input.planProgress || input.planProgress.length === 0) {
    return []
  }
  return [
    `PLAN PROGRESS:\n${input.planProgress.map((node) => `- ${node.taskKey}: ${node.state}`).join('\n')}`
  ]
}

function planReviewFindingsSection(input: ObjectiveRolePromptInput): string[] {
  if (input.role !== 'planner' || input.planReviewFindings === undefined) {
    return []
  }
  return [`PLAN REVIEW FINDINGS:\n${input.planReviewFindings}`]
}

/** Renders a repair planner's context: the open tasks it may write, and frozen history it may not. */
function renderRepairPlanContext(context: RepairPlanContext): string {
  const frozenLines =
    context.frozenTasks.length === 0
      ? '(none)'
      : context.frozenTasks
          .map(
            (task) =>
              `${task.taskKey} | ${task.title} | ${task.state} | ${task.summary ?? ''} | ${(task.filesModified ?? []).join(', ')}`
          )
          .join('\n')
  return [
    `OPEN TASKS JSON:\n${JSON.stringify(context.openTasks)}`,
    `FROZEN TASKS:\n${frozenLines}`
  ].join('\n\n')
}

/** Prior blocking findings, the plan diff, and carry-eligible indices for a delta plan review. */
function planReviewDeltaSection(delta: {
  priorBlockingFindings: readonly string[]
  diff: ObjectivePlanDiff
  carryEligible: readonly number[]
}): string {
  const findingsText =
    delta.priorBlockingFindings.length === 0
      ? '(none)'
      : delta.priorBlockingFindings.map((finding) => `- ${finding}`).join('\n')
  const carryEligibleText =
    delta.carryEligible.length === 0 ? '(none)' : delta.carryEligible.join(', ')
  return [
    `PRIOR BLOCKING FINDINGS:\n${findingsText}`,
    `PLAN DIFF JSON:\n${JSON.stringify(delta.diff)}`,
    `CARRY-ELIGIBLE ASSUMPTION INDICES: ${carryEligibleText}`
  ].join('\n\n')
}

function roleContext(input: ObjectiveRolePromptInput): string[] {
  if (input.role === 'planner') {
    return [
      ...existingPlanContext(input),
      ...failureContextSection(input),
      ...planProgressSection(input),
      ...planReviewFindingsSection(input)
    ]
  }
  if (input.role === 'implementer') {
    return [
      `ASSIGNED NODE JSON:\n${JSON.stringify(input.node)}`,
      ...(input.conflictContext
        ? [`CONFLICT RESOLUTION CONTEXT JSON:\n${JSON.stringify(input.conflictContext)}`]
        : [])
    ]
  }
  if (input.role === 'reviewer' && input.mode === 'plan-review') {
    return [
      ...(input.planReviewInputPath === undefined
        ? []
        : [`PLAN REVIEW INPUT FILE:\n${input.planReviewInputPath}`]),
      ...(input.planReviewSummary === undefined
        ? []
        : [`PLAN SUMMARY:\n${input.planReviewSummary}`]),
      ...(input.planReviewDelta === undefined
        ? []
        : [planReviewDeltaSection(input.planReviewDelta)])
    ]
  }
  if (input.role === 'reviewer' || input.role === 'integrator') {
    if (!input.plan) {
      throw new Error(`${input.role} prompt requires the active plan`)
    }
    return [`ACTIVE PLAN REVIEW VIEW JSON:\n${JSON.stringify(planReviewView(input.plan))}`]
  }
  return []
}

function finishInstructions(reportPath: string): string {
  return [
    `Write the JSON report atomically to this exact absolute path: ${JSON.stringify(reportPath)}`,
    `The complete report file is limited to ${MAX_OBJECTIVE_REPORT_BYTES} UTF-8 bytes, independently of the JavaScript UTF-16 code-unit limits on its string fields.`,
    `This worker-start task prompt is independently limited to ${ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES} UTF-8 bytes before dispatch.`,
    'Then finish using the worker identifiers Quirky supplied in your preamble:',
    `quirky orchestration send --from <workerHandle> --type worker_done --outcome succeeded --task-id <taskId> --dispatch-id <dispatchId> --report-path ${JSON.stringify(reportPath)} [--files-modified a,b,c] --subject "<one line>" --body "<brief completion notification; do not copy the full report summary>"`,
    'Quirky validates the report before accepting worker_done.',
    'Correct this same report file and resend the same worker_done command only when lifecycle.action is "rejected" and either lifecycle.authority is "run_home", or lifecycle.code is "heimdall_report_invalid" and its local/direct preflight reason explicitly says this Dispatch is still active.',
    'A terminal or legacy receipt such as {action:"completed",authority:"worker_server_legacy"}, or any rejection without one of those active confirmations, is not corrective authorization. Do not resend or self-redispatch; await owner review and an owner-authorized fresh Dispatch after live work is ruled out.',
    'If the work itself failed, still write the most complete valid report possible and send worker_done with --outcome failed.'
  ].join('\n')
}

function buildSections(
  input: ObjectiveRolePromptInput,
  repairSection: readonly string[]
): string[] {
  return [
    `ROLE: Objective ${input.role}`,
    `OBJECTIVE:\n${input.contract.objectiveText}`,
    `TIER: ${input.contract.tier}`,
    `LANDING BAR: ${input.contract.landingBar}`,
    `BUDGET: ${input.budgetBucket}`,
    `CONCURRENCY: ${input.effectiveMaxConcurrency}`,
    `WRITE TERRITORY:\n${input.contract.writeTerritory.map((path) => `- ${path}`).join('\n')}`,
    roleInstruction(input),
    ...(input.role === 'planner'
      ? [
          buildPlannerPromptPolicySection({
            effectiveMaxConcurrency: input.effectiveMaxConcurrency,
            lanesEnabled: input.lanesEnabled,
            gates: input.contract.gates
          })
        ]
      : []),
    ...roleContext(input),
    ...repairSection,
    ...(input.requestedSkipStage === undefined
      ? []
      : [`OWNER REQUESTED SKIP STAGE:\n${input.requestedSkipStage}`]),
    ...(input.ownerGuidance === undefined ? [] : [`OWNER GUIDANCE:\n${input.ownerGuidance}`]),
    `REPORT CONTRACT:\n${reportContract(input.role, input.plannerMode, input.mode)}`,
    finishInstructions(input.reportPath)
  ]
}

export function buildObjectiveRolePrompt(input: ObjectiveRolePromptInput): string {
  let repairSection: string[] = []
  if (input.role === 'planner' && input.plannerMode === 'repair' && input.repairContext) {
    const restBytes = Buffer.byteLength(buildSections(input, []).join('\n\n'), 'utf8')
    const budget = Math.max(
      0,
      ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES -
        restBytes -
        REPAIR_CONTEXT_SEPARATOR_RESERVE_BYTES
    )
    const { context: fitted, omitted } = fitRepairPlanContext(
      input.repairContext,
      budget,
      renderRepairPlanContext
    )
    repairSection = [
      renderRepairPlanContext(fitted),
      ...(omitted.length > 0 ? [`OMITTED: ${omitted.join('; ')}`] : [])
    ]
  }
  const prompt = buildSections(input, repairSection).join('\n\n')
  const bytes = Buffer.byteLength(prompt, 'utf8')
  if (bytes > ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES) {
    throw new Error(
      `Objective ${input.role} prompt is ${bytes} bytes; maximum is ${ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES}`
    )
  }
  return prompt
}

export function resolveObjectiveRoleAgent(
  store: Pick<Store, 'getSettings'>,
  contract: ObjectiveEnrollmentPayload,
  role: ObjectiveRole | ObjectiveReviewRole,
  judgmentRecommendation?: string
): string {
  const settings = store.getSettings()
  const configuredAlternatives = Object.values(contract.roleAgents)
  if (
    judgmentRecommendation !== undefined &&
    configuredAlternatives.includes(judgmentRecommendation) &&
    isTuiAgent(judgmentRecommendation) &&
    isTuiAgentEnabled(judgmentRecommendation, settings.disabledTuiAgents)
  ) {
    return judgmentRecommendation
  }
  const selected = contract.roleAgents[role] ?? settings.defaultTuiAgent
  if (!isTuiAgent(selected) || !isTuiAgentEnabled(selected, settings.disabledTuiAgents)) {
    throw new Error(`No enabled TUI agent is configured for the objective ${role} role`)
  }
  return selected
}
