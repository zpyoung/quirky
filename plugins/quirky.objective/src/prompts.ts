import { Buffer } from 'node:buffer'
import type { ObjectivePayload } from './contract'
import type { PlanTask, PlannerReport } from './plan'

const plannerContract = `Write one JSON object with plan: {tasks: PlanTask[]} and assumptions: Assumption[].
PlanTask = {taskKey: string, title: string, spec: string, deps: string[], criteria: Criterion[], territory: string[]}.
Criterion = {body: string, shellCheckable: boolean, checkCommand: string | null}.
Assumption = {claim: string, dependentTaskKeys: string[], evidence?: {command: string, observed: string}}.
Use 1 to 128 tasks with unique task keys, acyclic dependencies naming existing tasks, and 1 to 64 criteria per task.
A shell-checkable criterion must have a nonempty checkCommand; otherwise use null. Every task territory must be a safe relative glob.
Keep each task's JSON under 16384 bytes. Include assumptions even when empty. Keep the full report at most 262144 bytes.`
const implementerContract = `Write one JSON object with taskKey: string, summary: string, filesModified: string[], and criteriaSelfAssessment: {criterionIndex: number, result: 'pass' | 'fail' | 'unknown', note: string}[].
Use the exact assigned taskKey. Assess every criterion once, using zero-based indices. Give a nonempty summary of at most 16384 characters.
List only safe relative paths within the write territory, never .git or .quirky paths. Keep the full report at most 262144 bytes.
Self-assessment is not independent verification; report failures and unknowns honestly.`

const MAX_PROMPT_BYTES = 262_144
const SECTION_SEPARATOR = '\n\n'
const TRUNCATION_MARKER = '… [truncated]'

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
  const contentBudget = Math.max(0, maxBytes - markerBytes)
  let contentBytes = 0
  let contentLength = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (contentBytes + characterBytes > contentBudget) break
    contentBytes += characterBytes
    contentLength += character.length
  }
  return value.slice(0, contentLength) + (maxBytes >= markerBytes ? TRUNCATION_MARKER : '')
}

function jsonPromptValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '[unserializable context]'
  }
}

function promptSection(label: string, value: string, maxBytes: number): string {
  const heading = `${label}:\n`
  const valueBudget = Math.max(0, maxBytes - Buffer.byteLength(heading, 'utf8'))
  return heading + truncateUtf8(value, valueBudget)
}

function jsonPromptSection(label: string, value: unknown, maxBytes: number): string {
  return promptSection(label, jsonPromptValue(value), maxBytes)
}

function boundedPrompt(contextSections: string[], finalSections: string[]): string {
  const final = finalSections.join(SECTION_SEPARATOR)
  const context = contextSections.join(SECTION_SEPARATOR)
  if (context.length === 0) return truncateUtf8(final, MAX_PROMPT_BYTES)

  const contextBudget = MAX_PROMPT_BYTES -
    Buffer.byteLength(final, 'utf8') -
    Buffer.byteLength(SECTION_SEPARATOR, 'utf8')
  if (contextBudget < 0) return truncateUtf8(final, MAX_PROMPT_BYTES)
  return `${truncateUtf8(context, contextBudget)}${SECTION_SEPARATOR}${final}`
}

function commonRoleSections(payload: ObjectivePayload, role: string): string[] {
  return [
    `ROLE: ${role}`,
    promptSection('OBJECTIVE', payload.objectiveText, 16_384),
    promptSection('TIER', payload.tier, 128),
    promptSection('LANDING BAR', payload.landingBar, 128),
    jsonPromptSection('WRITE TERRITORY', payload.writeTerritory, 8_192)
  ]
}

function workerFinish(reportPath: string, additionalInstructions: string): string {
  const prefix = additionalInstructions.length > 0 ? `${additionalInstructions} ` : ''
  return `${prefix}Write the JSON report atomically to the exact REPORT PATH: write a temporary file beside it, then rename it. Send the worker_done command from the CLI commands section with --report-path ${JSON.stringify(reportPath)} added. If the task cannot be completed, send --outcome failed without a report. Keep the full report at most 262144 bytes.`
}

function compactCriteriaSection(plan: PlannerReport): string {
  const criteria = plan.plan.tasks.map((task) => [
    task.taskKey,
    task.criteria.map((criterion) => [criterion.body, criterion.shellCheckable, criterion.checkCommand])
  ])
  return `ACTIVE PLAN AND CRITERIA:\nCompact JSON entries are [taskKey, criteria]. Each criterion is [body, shellCheckable, checkCommand], and its criterionIndex is its zero-based position in that task's criteria array.\n${JSON.stringify(criteria)}`
}

function boundedCriteriaPrompt(
  requiredSections: string[],
  objectiveSection: string,
  criteriaSection: string,
  finalSections: string[]
): string {
  const fixedSections = [...requiredSections, criteriaSection, ...finalSections]
  const fixed = fixedSections.join(SECTION_SEPARATOR)
  const fixedBytes = Buffer.byteLength(fixed, 'utf8')
  if (fixedBytes > MAX_PROMPT_BYTES) {
    throw new RangeError('Required criteria and role instructions exceed the 262144-byte prompt limit')
  }

  const objectiveBudget = MAX_PROMPT_BYTES -
    fixedBytes -
    Buffer.byteLength(SECTION_SEPARATOR, 'utf8')
  if (Buffer.byteLength(objectiveSection, 'utf8') <= objectiveBudget) {
    return [...requiredSections, objectiveSection, criteriaSection, ...finalSections].join(SECTION_SEPARATOR)
  }
  if (objectiveBudget < Buffer.byteLength('OBJECTIVE:\n', 'utf8') + Buffer.byteLength(TRUNCATION_MARKER, 'utf8')) {
    return fixed
  }
  const objective = truncateUtf8(objectiveSection, objectiveBudget)
  return [...requiredSections, objective, criteriaSection, ...finalSections].join(SECTION_SEPARATOR)
}

/** Gives a worker its bounded role and the exact report channel that can settle its dispatch. */
export function objectivePrompt(
  payload: ObjectivePayload,
  role: 'planner' | 'implementer',
  reportPath: string,
  task?: PlanTask,
  progress?: unknown,
  rejectedDraft?: unknown
): string {
  const sections = commonRoleSections(payload, role)
  if (role === 'planner') {
    if (payload.existingPlan !== undefined) sections.push(promptSection('EXISTING PLAN', payload.existingPlan, 65_536))
  } else {
    sections.push(jsonPromptSection('ASSIGNED TASK', task, 16_384), jsonPromptSection('PLAN PROGRESS', progress, 32_768))
  }
  if (rejectedDraft !== undefined) {
    sections.push(jsonPromptSection('REJECTED DRAFT', rejectedDraft, 8_192))
  }
  const finish = workerFinish(
    reportPath,
    `${role === 'planner' ? 'Change no workspace file except your report. ' : ''}Do not run checks, review, commit or land work beyond your assigned task.`
  )
  return boundedPrompt(sections, [
    `REPORT CONTRACT:\n${role === 'planner' ? plannerContract : implementerContract}`,
    `REPORT PATH: ${reportPath}`,
    `FINISH:\n${finish}`
  ])
}

const repairPlannerContract = `Write one JSON object with repair: {upsertTasks: PlanTask[], dropTaskKeys: string[]} and assumptions: Assumption[].
PlanTask = {taskKey: string, title: string, spec: string, deps: string[], criteria: Criterion[], territory: string[]}.
Criterion = {body: string, shellCheckable: boolean, checkCommand: string | null}.
Assumption = {claim: string, dependentTaskKeys: string[], evidence?: {command: string, observed: string}}.
Use valid unique task keys and acyclic dependencies across the merged plan. Upsert complete task objects to add or replace tasks; drop only existing non-frozen task keys. Include only new assumptions to merge with existing assumptions.
Do not return a full replacement plan. Produce a non-empty repair patch and keep each task JSON under 16384 bytes. Keep the full report at most 262144 bytes.`

const reviewerContract = `Write one JSON object with verdict: 'approve' | 'block', criteriaResults: {taskKey: string, criterionIndex: number, result: 'pass' | 'block', note: string}[], and summary: string.
Assess every criterion exactly once across every active task using its taskKey and zero-based criterionIndex. verdict must be 'block' if and only if at least one criterion result is 'block'. Explain the review in a concise summary.`

const integratorContract = `Write one JSON object with verdict: 'approve' | 'block', criteriaResults: {taskKey: string, criterionIndex: number, result: 'pass' | 'block', note: string}[], summary: string, and checksRun: {command: string, exitCode: number}[].
Assess every criterion exactly once across every active task using its taskKey and zero-based criterionIndex. verdict must be 'block' if and only if at least one criterion result is 'block'. Before reporting, run checks and enrollment gates, then list each command and exit code in checksRun. An 'approve' verdict requires every checksRun exitCode to be 0.`

export function repairPlannerSpec(
  payload: ObjectivePayload,
  reportPath: string,
  frozenTasks: unknown[],
  openTasks: PlanTask[],
  failureContext: unknown,
  rejectedDraft?: unknown
): string {
  const sections = [
    ...commonRoleSections(payload, 'planner (repair)'),
    'REPAIR MODE:\nKeep every frozen task unchanged. Frozen task evidence includes its key, title, state, summary, and filesModified. Patch only open tasks and retain all valid existing work.',
    jsonPromptSection('FROZEN TASKS', frozenTasks, 32_768),
    jsonPromptSection('OPEN TASKS', openTasks, 131_072),
    jsonPromptSection('FAILURE CONTEXT', failureContext, 32_768)
  ]
  if (rejectedDraft !== undefined) {
    sections.push(jsonPromptSection('REJECTED DRAFT', rejectedDraft, 8_192))
  }
  return boundedPrompt(sections, [
    `REPORT CONTRACT:\n${repairPlannerContract}`,
    `REPORT PATH: ${reportPath}`,
    `FINISH:\n${workerFinish(reportPath, 'Change no workspace file except your report.')}`
  ])
}

export function reviewerSpec(payload: ObjectivePayload, reportPath: string, plan: PlannerReport): string {
  const sections = [
    `ROLE: reviewer`,
    promptSection('TIER', payload.tier, 128),
    promptSection('LANDING BAR', payload.landingBar, 128),
    `WRITE TERRITORY:\n${jsonPromptValue(payload.writeTerritory)}`
  ]
  return boundedCriteriaPrompt(
    sections,
    promptSection('OBJECTIVE', payload.objectiveText, 16_384),
    compactCriteriaSection(plan),
    [
      `REPORT CONTRACT:\n${reviewerContract}`,
      `REPORT PATH: ${reportPath}`,
      `FINISH:\n${workerFinish(reportPath, 'Do not modify any workspace files. Do not commit or land changes.')}`
    ]
  )
}

export function integratorSpec(payload: ObjectivePayload, reportPath: string, plan: PlannerReport): string {
  const sections = [
    `ROLE: integrator`,
    promptSection('TIER', payload.tier, 128),
    promptSection('LANDING BAR', payload.landingBar, 128),
    `WRITE TERRITORY:\n${jsonPromptValue(payload.writeTerritory)}`,
    `ENROLLMENT GATES:\n${jsonPromptValue(payload.gates)}`
  ]
  return boundedCriteriaPrompt(
    sections,
    promptSection('OBJECTIVE', payload.objectiveText, 16_384),
    compactCriteriaSection(plan),
    [
      `REPORT CONTRACT:\n${integratorContract}`,
      `REPORT PATH: ${reportPath}`,
      `FINISH:\n${workerFinish(reportPath, 'Edit only files inside WRITE TERRITORY. Do not commit or land changes.')}`
    ]
  )
}
