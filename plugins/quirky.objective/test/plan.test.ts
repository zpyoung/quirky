import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  implementerReportProblems,
  plannerReportProblems,
  reportDigest,
  type ImplementerReport,
  type PlanTask,
  type PlannerReport
} from '../src/plan'

const baseCriterion = {
  body: 'The task result is correct.',
  shellCheckable: false,
  checkCommand: null
}

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    taskKey: 'add',
    title: 'Add the feature',
    spec: 'Implement the requested change.',
    deps: [],
    criteria: [{ ...baseCriterion }],
    territory: ['src/**'],
    ...overrides
  }
}

function plannerReport(overrides: Partial<PlannerReport> = {}): PlannerReport {
  return {
    plan: { tasks: [task()] },
    assumptions: [],
    ...overrides
  }
}

function withTask(candidate: unknown): unknown {
  return { plan: { tasks: [candidate] }, assumptions: [] }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function taskAtJsonByteLength(length: number): PlanTask {
  const value = task({ spec: '' })
  const fixedLength = byteLength(JSON.stringify(value))
  value.spec = 'x'.repeat(length - fixedLength)
  if (byteLength(JSON.stringify(value)) !== length) {
    throw new Error(`could not construct a task with ${length} JSON bytes`)
  }
  return value
}

function expectPlannerProblem(name: string, value: unknown, includes?: string): void {
  let problems: string[]
  try {
    problems = plannerReportProblems(value)
  } catch (error) {
    throw new Error(`${name}: validator threw ${String(error)}`)
  }
  if (problems.length === 0) throw new Error(`${name}: expected a planner report problem`)
  if (includes && !problems.some((problem) => problem.includes(includes))) {
    throw new Error(`${name}: expected a problem containing ${JSON.stringify(includes)}, got ${problems.join('; ')}`)
  }
}

function expectImplementerProblem(name: string, value: unknown, assignedTask: PlanTask, territory: string[] = ['src/**']): void {
  let problems: string[]
  try {
    problems = implementerReportProblems(value, assignedTask, territory)
  } catch (error) {
    throw new Error(`${name}: validator threw ${String(error)}`)
  }
  if (problems.length === 0) throw new Error(`${name}: expected an implementer report problem`)
}

function implementerReport(overrides: Partial<ImplementerReport> = {}): ImplementerReport {
  return {
    taskKey: 'add',
    summary: 'Implemented the feature.',
    filesModified: ['src/a/b.ts'],
    criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified.' }],
    ...overrides
  }
}

test('accepts a valid planner report and returns a stable digest', () => {
  const report = plannerReport({
    assumptions: [{
      claim: 'Unicode evidence: café.',
      dependentTaskKeys: ['add'],
      evidence: { command: 'printf café', observed: 'café' }
    }]
  })
  expect(plannerReportProblems(report)).toEqual([])

  const expected = createHash('sha256').update(JSON.stringify(report)).digest('hex')
  expect(reportDigest(report)).toBe(expected)
  expect(reportDigest(report)).toBe(reportDigest(report))

  const boundaryTasks = Array.from({ length: 128 }, (_, index) => task({ taskKey: `task-${index}` }))
  const validBoundaries = [
    plannerReport({ plan: { tasks: [task({ taskKey: 'a'.repeat(128), title: 'é'.repeat(512) })] } }),
    plannerReport({ plan: { tasks: [taskAtJsonByteLength(16_383)] } }),
    plannerReport({ plan: { tasks: boundaryTasks } }),
    plannerReport({ plan: { tasks: [task({ criteria: Array.from({ length: 64 }, () => ({ ...baseCriterion })) })] } }),
    plannerReport({ plan: { tasks: [task({ criteria: [{ ...baseCriterion, body: 'é'.repeat(2_048) }] })] } }),
    plannerReport({ plan: { tasks: [task({ criteria: [{ body: 'check', shellCheckable: true, checkCommand: 'x'.repeat(8_192) }] })] } }),
    plannerReport({
      assumptions: Array.from({ length: 64 }, () => ({ claim: 'assumption', dependentTaskKeys: ['add'] }))
    })
  ]
  for (const [index, boundary] of validBoundaries.entries()) {
    expect(plannerReportProblems(boundary), `valid planner boundary ${index}`).toEqual([])
  }

  const maxTerritory = Array.from({ length: 64 }, (_, index) => `src/file-${index}.ts`)
  expect(plannerReportProblems(plannerReport({ plan: { tasks: [task({ territory: maxTerritory })] } }))).toEqual([])
  expect(plannerReportProblems(plannerReport({ plan: { tasks: [task({ territory: ['**'] })] } }))).toEqual([])

  const multiByteTask = task({ spec: 'é'.repeat(8_200) })
  const serializedMultiByteTask = JSON.stringify(multiByteTask)
  expect(serializedMultiByteTask.length).toBeLessThan(16_384)
  expect(byteLength(serializedMultiByteTask)).toBeGreaterThanOrEqual(16_384)
  expectPlannerProblem('task size is measured in UTF-8 bytes, not JavaScript characters', withTask(multiByteTask))
})

test('refuses planner reports that break the graph or limits', () => {
  const tooManyTasks = Array.from({ length: 129 }, (_, index) => task({ taskKey: `task-${index}` }))
  const brokenStructure: [string, unknown][] = [
    ['null report', null],
    ['primitive report', 'not a report'],
    ['missing plan', { assumptions: [] }],
    ['non-object plan', { plan: null, assumptions: [] }],
    ['non-array tasks', { plan: { tasks: {} }, assumptions: [] }],
    ['missing assumptions', { plan: { tasks: [task()] } }],
    ['non-array assumptions', { plan: { tasks: [task()] }, assumptions: {} }],
    ['non-object task', withTask(null)],
    ['missing task key', withTask({ ...task(), taskKey: undefined })],
    ['non-string task key', withTask({ ...task(), taskKey: 42 })],
    ['missing title', withTask({ ...task(), title: undefined })],
    ['non-string title', withTask({ ...task(), title: null })],
    ['missing spec', withTask({ ...task(), spec: undefined })],
    ['non-string spec', withTask({ ...task(), spec: [] })],
    ['non-array dependencies', withTask({ ...task(), deps: null })],
    ['non-string dependency', withTask({ ...task(), deps: [1] })],
    ['non-array criteria', withTask({ ...task(), criteria: null })],
    ['non-object criterion', withTask({ ...task(), criteria: [null] })],
    ['missing criterion body', withTask({ ...task(), criteria: [{ ...baseCriterion, body: undefined }] })],
    ['non-string criterion body', withTask({ ...task(), criteria: [{ ...baseCriterion, body: 1 }] })],
    ['non-boolean shell flag', withTask({ ...task(), criteria: [{ ...baseCriterion, shellCheckable: 'false' }] })],
    ['missing check command', withTask({ ...task(), criteria: [{ body: 'body', shellCheckable: false }] })],
    ['non-string check command', withTask({ ...task(), criteria: [{ ...baseCriterion, checkCommand: 1 }] })],
    ['non-array territory', withTask({ ...task(), territory: null })],
    ['non-string territory member', withTask({ ...task(), territory: [null] })],
    ['non-object assumption', { plan: { tasks: [task()] }, assumptions: [null] }],
    ['non-string assumption claim', { plan: { tasks: [task()] }, assumptions: [{ claim: 1, dependentTaskKeys: [] }] }],
    ['missing assumption dependencies', { plan: { tasks: [task()] }, assumptions: [{ claim: 'claim' }] }],
    ['non-string assumption dependency', { plan: { tasks: [task()] }, assumptions: [{ claim: 'claim', dependentTaskKeys: [1] }] }],
    ['non-object evidence', { plan: { tasks: [task()] }, assumptions: [{ claim: 'claim', dependentTaskKeys: [], evidence: 'proof' }] }],
    ['missing evidence command', { plan: { tasks: [task()] }, assumptions: [{ claim: 'claim', dependentTaskKeys: [], evidence: { observed: 'output' } }] }],
    ['non-string evidence observed value', { plan: { tasks: [task()] }, assumptions: [{ claim: 'claim', dependentTaskKeys: [], evidence: { command: 'check', observed: null } }] }]
  ]
  for (const [name, value] of brokenStructure) expectPlannerProblem(name, value)

  const limitCases: [string, unknown, string?][] = [
    ['no tasks', plannerReport({ plan: { tasks: [] } }), 'task'],
    ['more than 128 tasks', plannerReport({ plan: { tasks: tooManyTasks } }), '128'],
    ['invalid task key', withTask(task({ taskKey: 'bad/key' })), 'task key'],
    ['task key longer than 128 characters', withTask(task({ taskKey: 'a'.repeat(129) })), '128'],
    ['duplicate task key', { plan: { tasks: [task({ taskKey: 'a' }), task({ taskKey: 'a' })] }, assumptions: [] }, 'duplicate task key a'],
    ['empty title', withTask(task({ title: '' })), 'title'],
    ['title longer than 512 characters', withTask(task({ title: 'x'.repeat(513) })), '512'],
    ['spec longer than 16,384 characters', withTask(task({ spec: 'x'.repeat(16_385) })), '16,384'],
    ['task JSON exactly 16,384 bytes', withTask(taskAtJsonByteLength(16_384)), '16,384'],
    ['unknown dependency', { plan: { tasks: [task({ taskKey: 'b', deps: ['z'] })] }, assumptions: [] }, 'task b depends on unknown task z'],
    ['self dependency', { plan: { tasks: [task({ taskKey: 'self', deps: ['self'] })] }, assumptions: [] }, 'self'],
    ['dependency cycle', { plan: { tasks: [task({ taskKey: 'a', deps: ['b'] }), task({ taskKey: 'b', deps: ['a'] })] }, assumptions: [] }, 'dependency cycle: a -> b -> a'],
    ['no criteria', withTask(task({ criteria: [] })), 'criteria'],
    ['more than 64 criteria', withTask(task({ criteria: Array.from({ length: 65 }, () => ({ ...baseCriterion })) })), '64'],
    ['empty criterion body', withTask(task({ criteria: [{ ...baseCriterion, body: '' }] })), 'body'],
    ['criterion body longer than 2,048 characters', withTask(task({ criteria: [{ ...baseCriterion, body: 'x'.repeat(2_049) }] })), '2,048'],
    ['checkable criterion without a command', withTask(task({ criteria: [{ body: 'body', shellCheckable: true, checkCommand: null }] })), 'checkCommand'],
    ['checkable criterion with an empty command', withTask(task({ criteria: [{ body: 'body', shellCheckable: true, checkCommand: '' }] })), 'checkCommand'],
    ['non-checkable criterion with a command', withTask(task({ criteria: [{ body: 'body', shellCheckable: false, checkCommand: 'echo ok' }] })), 'checkCommand'],
    ['command longer than 8,192 characters', withTask(task({ criteria: [{ body: 'body', shellCheckable: true, checkCommand: 'x'.repeat(8_193) }] })), '8,192'],
    ['empty territory', withTask(task({ territory: [] })), 'territory'],
    ['more than 64 territory entries', withTask(task({ territory: Array.from({ length: 65 }, (_, index) => `src/${index}.ts`) })), '64'],
    ['duplicate territory entry', withTask(task({ territory: ['src/a.ts', 'src/a.ts'] })), 'duplicate'],
    ['empty territory entry', withTask(task({ territory: [''] })), 'territory'],
    ['absolute territory path', withTask(task({ territory: ['/src/a.ts'] })), 'territory'],
    ['home-relative territory path', withTask(task({ territory: ['~/src/a.ts'] })), 'territory'],
    ['Windows drive territory path', withTask(task({ territory: ['C:/src/a.ts'] })), 'territory'],
    ['backslash in territory path', withTask(task({ territory: ['src\\a.ts'] })), 'territory'],
    ['parent segment in territory path', withTask(task({ territory: ['src/../outside.ts'] })), 'territory'],
    ['control character in territory path', withTask(task({ territory: ['src/\u0007a.ts'] })), 'territory'],
    ['DEL control character in territory path', withTask(task({ territory: ['src/\u007fa.ts'] })), 'territory'],
    ['forbidden territory glob character [', withTask(task({ territory: ['src/[a].ts'] })), 'territory'],
    ['forbidden territory glob character ]', withTask(task({ territory: ['src/a].ts'] })), 'territory'],
    ['forbidden territory glob character {', withTask(task({ territory: ['src/{a}.ts'] })), 'territory'],
    ['forbidden territory glob character }', withTask(task({ territory: ['src/a}.ts'] })), 'territory'],
    ['forbidden territory glob character (', withTask(task({ territory: ['src/(a).ts'] })), 'territory'],
    ['forbidden territory glob character )', withTask(task({ territory: ['src/a).ts'] })), 'territory'],
    ['forbidden territory glob character !', withTask(task({ territory: ['src/!a.ts'] })), 'territory'],
    ['git metadata territory', withTask(task({ territory: ['.git/config'] })), 'territory'],
    ['quirky metadata territory', withTask(task({ territory: ['.quirky/report.json'] })), 'territory'],
    ['more than 64 assumptions', plannerReport({ assumptions: Array.from({ length: 65 }, () => ({ claim: 'claim', dependentTaskKeys: [] })) }), '64'],
    ['assumption names unknown task', plannerReport({ assumptions: [{ claim: 'claim', dependentTaskKeys: ['unknown'] }] }), 'unknown']
  ]
  for (const [name, value, includes] of limitCases) expectPlannerProblem(name, value, includes)
})

test('accepts an implementer report only for its task with every criterion assessed once and files inside the territory', () => {
  const assignedTask = task({ criteria: [{ ...baseCriterion }, { ...baseCriterion, body: 'The second check passes.' }] })
  const validReport = implementerReport({
    criteriaSelfAssessment: [
      { criterionIndex: 1, result: 'unknown', note: 'Needs an unavailable check.' },
      { criterionIndex: 0, result: 'pass', note: 'Implemented.' }
    ]
  })
  expect(implementerReportProblems(validReport, assignedTask, ['src/**'])).toEqual([])
  expect(implementerReportProblems(implementerReport({ summary: 'é'.repeat(16_384) }), task(), ['src/**'])).toEqual([])
  expect(implementerReportProblems(implementerReport({ filesModified: Array.from({ length: 1_024 }, () => 'src/a.ts') }), task(), ['src/**'])).toEqual([])
  expect(implementerReportProblems(implementerReport({ filesModified: [] }), task(), ['src/**'])).toEqual([])

  const malformedReports: [string, unknown][] = [
    ['non-object report', null],
    ['missing task key', { ...validReport, taskKey: undefined }],
    ['non-string summary', { ...validReport, summary: null }],
    ['non-array files modified', { ...validReport, filesModified: 'src/a.ts' }],
    ['non-string modified file', { ...validReport, filesModified: ['src/a.ts', null] }],
    ['non-array criterion assessments', { ...validReport, criteriaSelfAssessment: null }],
    ['non-object assessment', { ...validReport, criteriaSelfAssessment: [null] }],
    ['missing criterion index', { ...validReport, criteriaSelfAssessment: [{ result: 'pass', note: 'ok' }, { criterionIndex: 1, result: 'pass', note: 'ok' }] }],
    ['non-integer criterion index', { ...validReport, criteriaSelfAssessment: [{ criterionIndex: 0.5, result: 'pass', note: 'ok' }, { criterionIndex: 1, result: 'pass', note: 'ok' }] }],
    ['missing assessment result', { ...validReport, criteriaSelfAssessment: [{ criterionIndex: 0, note: 'ok' }, { criterionIndex: 1, result: 'pass', note: 'ok' }] }],
    ['non-string assessment note', { ...validReport, criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 1 }, { criterionIndex: 1, result: 'pass', note: 'ok' }] }]
  ]
  for (const [name, value] of malformedReports) expectImplementerProblem(name, value, assignedTask)

  const invalidReports: [string, unknown][] = [
    ['wrong task key', implementerReport({ taskKey: 'other' })],
    ['empty summary', implementerReport({ summary: '' })],
    ['summary longer than 16,384 characters', implementerReport({ summary: 'x'.repeat(16_385) })],
    ['missing criterion assessment', implementerReport({ criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'ok' }] })],
    ['repeated criterion index', implementerReport({ criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'first' }, { criterionIndex: 0, result: 'fail', note: 'second' }] })],
    ['out-of-range criterion index', implementerReport({ criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'ok' }, { criterionIndex: 2, result: 'pass', note: 'extra' }] })],
    ['negative criterion index', implementerReport({ criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'ok' }, { criterionIndex: -1, result: 'pass', note: 'extra' }] })],
    ['unknown result', implementerReport({ criteriaSelfAssessment: [{ criterionIndex: 0, result: 'maybe' as 'pass', note: 'unsure' }, { criterionIndex: 1, result: 'pass', note: 'ok' }] })],
    ['absolute modified path', implementerReport({ filesModified: ['/workspace/src/a.ts'] })],
    ['Windows absolute modified path', implementerReport({ filesModified: ['C:/workspace/src/a.ts'] })],
    ['parent segment modified path', implementerReport({ filesModified: ['src/../outside.ts'] })],
    ['git metadata modified path', implementerReport({ filesModified: ['.git/config'] })],
    ['quirky metadata modified path', implementerReport({ filesModified: ['.quirky/objective/report.json'] })],
    ['backslash modified path', implementerReport({ filesModified: ['src\\a.ts'] })],
    ['modified path outside the territory glob', implementerReport({ filesModified: ['docs/a.md'] })],
    ['more than 1,024 modified files', implementerReport({ filesModified: Array.from({ length: 1_025 }, () => 'src/a.ts') })]
  ]
  for (const [name, value] of invalidReports) expectImplementerProblem(name, value, assignedTask)
})
