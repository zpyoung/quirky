import type { ObjectivePayload } from './contract'
import type { PlanTask } from './plan'

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

/** Gives a worker its bounded role and the exact report channel that can settle its dispatch. */
export function objectivePrompt(payload: ObjectivePayload, role: 'planner' | 'implementer', reportPath: string,
  task?: PlanTask, progress?: unknown): string {
  const sections = [
    `ROLE: ${role}`,
    `OBJECTIVE:\n${payload.objectiveText}`,
    `TIER: ${payload.tier}`,
    `LANDING BAR: ${payload.landingBar}`,
    `WRITE TERRITORY:\n${JSON.stringify(payload.writeTerritory)}`
  ]
  if (role === 'planner') {
    if (payload.existingPlan !== undefined) sections.push(`EXISTING PLAN:\n${payload.existingPlan}`)
  } else {
    sections.push(`ASSIGNED TASK:\n${JSON.stringify(task)}`, `PLAN PROGRESS:\n${JSON.stringify(progress)}`)
  }
  sections.push(
    `REPORT CONTRACT:\n${role === 'planner' ? plannerContract : implementerContract}`,
    `REPORT PATH: ${reportPath}`,
    `FINISH:\n${role === 'planner' ? 'Change no workspace file except your report. ' : ''}Write the JSON report atomically to the exact REPORT PATH: write a temporary file beside it, then rename it. Send the worker_done command from the CLI commands section with --report-path ${JSON.stringify(reportPath)} added. If the task cannot be completed, send --outcome failed without a report. Do not run checks, review, commit or land work beyond your assigned task.`
  )
  return sections.join('\n\n')
}
