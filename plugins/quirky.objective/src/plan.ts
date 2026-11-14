import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { territoryProblems } from './contract'

export interface PlannerReport { plan: { tasks: PlanTask[] }; assumptions: Assumption[] }
export interface PlanTask { taskKey: string; title: string; spec: string; deps: string[]; criteria: Criterion[]; territory: string[] }
export interface Criterion { body: string; shellCheckable: boolean; checkCommand: string | null }
export interface Assumption { claim: string; dependentTaskKeys: string[]; evidence?: { command: string; observed: string } }
export interface ImplementerReport {
  taskKey: string
  summary: string
  filesModified: string[]
  criteriaSelfAssessment: { criterionIndex: number; result: 'pass' | 'fail' | 'unknown'; note: string }[]
}

const TASK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const IMPLEMENTER_RESULTS = new Set(['pass', 'fail', 'unknown'])
const MAX_TASK_JSON_BYTES = 16_384

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  if (!isUnknownArray(value)) return false
  for (const item of value) if (typeof item !== 'string') return false
  return true
}

function validateCriterionShape(value: unknown, problems: string[], path: string): value is Criterion {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`)
    return false
  }
  let valid = true
  if (typeof value.body !== 'string') {
    problems.push(`${path}.body must be a string`)
    valid = false
  }
  if (typeof value.shellCheckable !== 'boolean') {
    problems.push(`${path}.shellCheckable must be a boolean`)
    valid = false
  }
  if (typeof value.checkCommand !== 'string' && value.checkCommand !== null) {
    problems.push(`${path}.checkCommand must be a string or null`)
    valid = false
  }
  return valid
}

function validatePlanTaskShape(value: unknown, problems: string[], path: string): value is PlanTask {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`)
    return false
  }
  let valid = true
  if (typeof value.taskKey !== 'string') {
    problems.push(`${path}.taskKey must be a string`)
    valid = false
  }
  if (typeof value.title !== 'string') {
    problems.push(`${path}.title must be a string`)
    valid = false
  }
  if (typeof value.spec !== 'string') {
    problems.push(`${path}.spec must be a string`)
    valid = false
  }
  if (!isStringArray(value.deps)) {
    problems.push(`${path}.deps must be an array of strings`)
    valid = false
  }
  const criteria = value.criteria
  if (!isUnknownArray(criteria)) {
    problems.push(`${path}.criteria must be an array`)
    valid = false
  } else {
    for (let index = 0; index < criteria.length; index++) {
      if (!validateCriterionShape(criteria[index], problems, `${path}.criteria[${index}]`)) valid = false
    }
  }
  if (!isStringArray(value.territory)) {
    problems.push(`${path}.territory must be an array of strings`)
    valid = false
  }
  return valid
}

function validateAssumptionShape(value: unknown, problems: string[], path: string): value is Assumption {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`)
    return false
  }
  let valid = true
  if (typeof value.claim !== 'string') {
    problems.push(`${path}.claim must be a string`)
    valid = false
  }
  if (!isStringArray(value.dependentTaskKeys)) {
    problems.push(`${path}.dependentTaskKeys must be an array of strings`)
    valid = false
  }
  const evidence = value.evidence
  if (evidence !== undefined) {
    if (!isRecord(evidence)) {
      problems.push(`${path}.evidence must be an object`)
      valid = false
    } else {
      if (typeof evidence.command !== 'string') {
        problems.push(`${path}.evidence.command must be a string`)
        valid = false
      }
      if (typeof evidence.observed !== 'string') {
        problems.push(`${path}.evidence.observed must be a string`)
        valid = false
      }
    }
  }
  return valid
}

function validatePlannerReportShape(value: unknown, problems: string[]): value is PlannerReport {
  if (!isRecord(value)) {
    problems.push('report must be an object')
    return false
  }
  let valid = true
  const plan = value.plan
  if (!isRecord(plan)) {
    problems.push('plan must be an object')
    valid = false
  } else {
    const tasks = plan.tasks
    if (!isUnknownArray(tasks)) {
      problems.push('plan.tasks must be an array')
      valid = false
    } else {
      for (let index = 0; index < tasks.length; index++) {
        if (!validatePlanTaskShape(tasks[index], problems, `plan.tasks[${index}]`)) valid = false
      }
    }
  }
  const assumptions = value.assumptions
  if (!isUnknownArray(assumptions)) {
    problems.push('assumptions must be an array')
    valid = false
  } else {
    for (let index = 0; index < assumptions.length; index++) {
      if (!validateAssumptionShape(assumptions[index], problems, `assumptions[${index}]`)) valid = false
    }
  }
  return valid
}

function validateAssessmentShape(
  value: unknown,
  problems: string[],
  path: string
): value is ImplementerReport['criteriaSelfAssessment'][number] {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`)
    return false
  }
  let valid = true
  if (typeof value.criterionIndex !== 'number') {
    problems.push(`${path}.criterionIndex must be a number`)
    valid = false
  }
  if (typeof value.result !== 'string' || !IMPLEMENTER_RESULTS.has(value.result)) {
    problems.push(`${path}.result must be pass, fail, or unknown`)
    valid = false
  }
  if (typeof value.note !== 'string') {
    problems.push(`${path}.note must be a string`)
    valid = false
  }
  return valid
}

function validateImplementerReportShape(value: unknown, problems: string[]): value is ImplementerReport {
  if (!isRecord(value)) {
    problems.push('report must be an object')
    return false
  }
  let valid = true
  if (typeof value.taskKey !== 'string') {
    problems.push('taskKey must be a string')
    valid = false
  }
  if (typeof value.summary !== 'string') {
    problems.push('summary must be a string')
    valid = false
  }
  if (!isStringArray(value.filesModified)) {
    problems.push('filesModified must be an array of strings')
    valid = false
  }
  const assessments = value.criteriaSelfAssessment
  if (!isUnknownArray(assessments)) {
    problems.push('criteriaSelfAssessment must be an array')
    valid = false
  } else {
    for (let index = 0; index < assessments.length; index++) {
      if (!validateAssessmentShape(assessments[index], problems, `criteriaSelfAssessment[${index}]`)) valid = false
    }
  }
  return valid
}

function findDependencyCycle(tasks: PlanTask[]): string[] | null {
  const byKey = new Map<string, PlanTask>()
  for (const task of tasks) if (!byKey.has(task.taskKey)) byKey.set(task.taskKey, task)

  const states = new Map<string, 0 | 1 | 2>()
  const path: string[] = []
  let cycle: string[] | null = null

  function visit(taskKey: string): boolean {
    states.set(taskKey, 1)
    path.push(taskKey)
    const current = byKey.get(taskKey)
    if (current) {
      for (const dependency of current.deps) {
        if (!byKey.has(dependency) || dependency === taskKey) continue
        const state = states.get(dependency)
        if (state === 1) {
          const cycleStart = path.indexOf(dependency)
          cycle = [...path.slice(cycleStart), dependency]
          return true
        }
        if (state !== 2 && visit(dependency)) return true
      }
    }
    path.pop()
    states.set(taskKey, 2)
    return false
  }

  for (const task of tasks) {
    if (states.get(task.taskKey) === undefined && visit(task.taskKey)) break
  }
  return cycle
}

export function plannerReportProblems(report: unknown): string[] {
  const problems: string[] = []
  if (!validatePlannerReportShape(report, problems)) return problems

  const tasks = report.plan.tasks
  if (tasks.length === 0 || tasks.length > 128) problems.push('plan must contain between 1 and 128 tasks')

  const taskKeys = new Set<string>()
  for (const task of tasks) {
    if (!TASK_KEY_PATTERN.test(task.taskKey) || task.taskKey.length > 128) {
      problems.push(`task key ${task.taskKey} must match the task key format and be at most 128 characters`)
    }
    if (taskKeys.has(task.taskKey)) problems.push(`duplicate task key ${task.taskKey}`)
    taskKeys.add(task.taskKey)

    if (task.title.length === 0 || task.title.length > 512) {
      problems.push(`task ${task.taskKey} title must contain 1 to 512 characters`)
    }
    if (task.spec.length > 16_384) problems.push(`task ${task.taskKey} spec exceeds 16,384 characters`)

    try {
      const serialized = JSON.stringify(task)
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') >= MAX_TASK_JSON_BYTES) {
        problems.push(`task ${task.taskKey} JSON must be smaller than 16,384 bytes`)
      }
    } catch {
      problems.push(`task ${task.taskKey} cannot be serialized as JSON`)
    }

    if (task.criteria.length === 0 || task.criteria.length > 64) {
      problems.push(`task ${task.taskKey} must contain between 1 and 64 criteria`)
    }
    for (const criterion of task.criteria) {
      if (criterion.body.length === 0 || criterion.body.length > 2_048) {
        problems.push(`task ${task.taskKey} criterion body must contain 1 to 2,048 characters`)
      }
      if (criterion.checkCommand !== null && criterion.checkCommand.length > 8_192) {
        problems.push(`task ${task.taskKey} criterion checkCommand exceeds 8,192 characters`)
      }
      if (criterion.shellCheckable && (criterion.checkCommand === null || criterion.checkCommand.length === 0)) {
        problems.push(`task ${task.taskKey} shell-checkable criterion requires a non-empty checkCommand`)
      }
      if (!criterion.shellCheckable && criterion.checkCommand !== null) {
        problems.push(`task ${task.taskKey} non-shell-checkable criterion must have a null checkCommand`)
      }
    }

    for (const problem of territoryProblems(task.territory)) {
      problems.push(`task ${task.taskKey} territory: ${problem}`)
    }
  }

  for (const task of tasks) {
    for (const dependency of task.deps) {
      if (!taskKeys.has(dependency)) {
        problems.push(`task ${task.taskKey} depends on unknown task ${dependency}`)
      } else if (dependency === task.taskKey) {
        problems.push(`task ${task.taskKey} depends on itself`)
      }
    }
  }

  const cycle = findDependencyCycle(tasks)
  if (cycle) problems.push(`dependency cycle: ${cycle.join(' -> ')}`)

  if (report.assumptions.length > 64) problems.push('assumptions must contain no more than 64 entries')
  for (let index = 0; index < report.assumptions.length; index++) {
    const assumption = report.assumptions[index]
    for (const taskKey of assumption.dependentTaskKeys) {
      if (!taskKeys.has(taskKey)) {
        problems.push(`assumption ${index} names unknown task key ${taskKey}`)
      }
    }
  }
  return problems
}

function isSafeModifiedPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return false
  const segments = path.split('/')
  if (segments.includes('..')) return false
  return segments[0] !== '.git' && segments[0] !== '.quirky'
}

export function implementerReportProblems(
  report: unknown,
  task: PlanTask,
  writeTerritory: string[]
): string[] {
  const problems: string[] = []
  const validReport = validateImplementerReportShape(report, problems)
  const validTask = validatePlanTaskShape(task, problems, 'assigned task')
  const validTerritory = isStringArray(writeTerritory)
  if (!validTerritory) problems.push('writeTerritory must be an array of strings')
  if (!validReport || !validTask || !validTerritory) return problems

  for (const problem of territoryProblems(writeTerritory)) {
    problems.push(`write territory: ${problem}`)
  }
  if (problems.length > 0) return problems

  const globs = writeTerritory.map((pattern) => new Bun.Glob(pattern))
  if (report.taskKey !== task.taskKey) {
    problems.push(`taskKey ${report.taskKey} does not match assigned task ${task.taskKey}`)
  }
  if (report.summary.length === 0 || report.summary.length > 16_384) {
    problems.push('summary must contain 1 to 16,384 characters')
  }
  if (report.filesModified.length > 1_024) problems.push('filesModified must contain no more than 1,024 entries')

  const assessed = new Set<number>()
  for (const assessment of report.criteriaSelfAssessment) {
    const index = assessment.criterionIndex
    if (!Number.isInteger(index) || index < 0 || index >= task.criteria.length) {
      problems.push(`criterion index ${index} is out of range`)
    } else if (assessed.has(index)) {
      problems.push(`criterion index ${index} is repeated`)
    } else {
      assessed.add(index)
    }
  }
  for (let index = 0; index < task.criteria.length; index++) {
    if (!assessed.has(index)) problems.push(`missing assessment for criterion ${index}`)
  }

  for (const path of report.filesModified) {
    if (!isSafeModifiedPath(path)) {
      problems.push(`modified file path ${JSON.stringify(path)} is not a safe relative path`)
    } else if (!globs.some((glob) => glob.match(path))) {
      problems.push(`modified file path ${JSON.stringify(path)} matches no write-territory glob`)
    }
  }
  return problems
}

export function reportDigest(report: unknown): string {
  const serialized = JSON.stringify(report)
  if (serialized === undefined) throw new TypeError('report cannot be serialized as JSON')
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}
