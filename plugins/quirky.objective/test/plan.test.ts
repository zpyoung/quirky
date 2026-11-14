import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  applyRepairPatchToRevision,
  implementerReportProblems,
  integratorReportProblems,
  plannerReportProblems,
  repairReportProblems,
  reportDigest,
  reviewerReportProblems,
  type ImplementerReport,
  type PlanTask,
  type PlannerReport,
  type RepairPlannerReport
} from '../src/plan'
import { integratorSpec, objectivePrompt, repairPlannerSpec, reviewerSpec } from '../src/prompts'

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

function expectImplementerProblem(name: string, value: unknown, assignedTask: PlanTask, expected: string[], territory: string[] = ['src/**']): void {
  let problems: string[]
  try {
    problems = implementerReportProblems(value, assignedTask, territory)
  } catch (error) {
    throw new Error(`${name}: validator threw ${String(error)}`)
  }
  expect(problems, name).toEqual(expected)
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
  for (const prefix of ['./', '././']) {
    for (const metadata of ['.git', '.quirky']) {
      const territory = `${prefix}${metadata}/**`
      expectPlannerProblem(`aliased metadata territory ${territory}`, withTask(task({ territory: [territory] })), 'territory-invalid')
    }
  }
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
  expect(implementerReportProblems({
    ...validReport, filesModified: ['.gitignore', '.quirky-notes.md', 'src/a/b.ts']
  }, assignedTask, ['**'])).toEqual([])
  expect(implementerReportProblems(implementerReport({ summary: 'é'.repeat(16_384) }), task(), ['src/**'])).toEqual([])
  expect(implementerReportProblems(implementerReport({ filesModified: Array.from({ length: 1_024 }, () => 'src/a.ts') }), task(), ['src/**'])).toEqual([])
  expect(implementerReportProblems(implementerReport({ filesModified: [] }), task(), ['src/**'])).toEqual([])

  const malformedReports: [string, unknown, string[]][] = [
    ['non-object report', null, ['report must be an object']],
    ['missing task key', { ...validReport, taskKey: undefined }, ['taskKey must be a string']],
    ['non-string summary', { ...validReport, summary: null }, ['summary must be a string']],
    ['non-array files modified', { ...validReport, filesModified: 'src/a.ts' }, ['filesModified must be an array of strings']],
    ['non-string modified file', { ...validReport, filesModified: ['src/a.ts', null] }, ['filesModified must be an array of strings']],
    ['non-array criterion assessments', { ...validReport, criteriaSelfAssessment: null }, ['criteriaSelfAssessment must be an array']],
    ['non-object assessment', { ...validReport, criteriaSelfAssessment: [null] }, ['criteriaSelfAssessment[0] must be an object']],
    ['missing criterion index', { ...validReport, criteriaSelfAssessment: [{ result: 'pass', note: 'ok' }, validReport.criteriaSelfAssessment[0]] }, ['criteriaSelfAssessment[0].criterionIndex must be a number']],
    ['non-integer criterion index', { ...validReport, criteriaSelfAssessment: [{ criterionIndex: 0.5, result: 'pass', note: 'ok' }, validReport.criteriaSelfAssessment[0]] }, ['criterion index 0.5 is out of range', 'missing assessment for criterion 0']],
    ['missing assessment result', { ...validReport, criteriaSelfAssessment: [{ criterionIndex: 0, note: 'ok' }, validReport.criteriaSelfAssessment[0]] }, ['criteriaSelfAssessment[0].result must be pass, fail, or unknown']],
    ['non-string assessment note', { ...validReport, criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 1 }, validReport.criteriaSelfAssessment[0]] }, ['criteriaSelfAssessment[0].note must be a string']]
  ]
  for (const [name, value, expected] of malformedReports) expectImplementerProblem(name, value, assignedTask, expected)

  const invalidReports: [string, unknown, string[], string[]?][] = [
    ['wrong task key', { ...validReport, taskKey: 'other' }, ['taskKey other does not match assigned task add']],
    ['empty summary', { ...validReport, summary: '' }, ['summary must contain 1 to 16,384 characters']],
    ['summary longer than 16,384 characters', { ...validReport, summary: 'x'.repeat(16_385) }, ['summary must contain 1 to 16,384 characters']],
    ['missing criterion assessment', { ...validReport, criteriaSelfAssessment: [validReport.criteriaSelfAssessment[1]] }, ['missing assessment for criterion 1']],
    ['repeated criterion index', { ...validReport, criteriaSelfAssessment: [validReport.criteriaSelfAssessment[1], validReport.criteriaSelfAssessment[1], validReport.criteriaSelfAssessment[0]] }, ['criterion index 0 is repeated']],
    ['out-of-range criterion index', { ...validReport, criteriaSelfAssessment: [...validReport.criteriaSelfAssessment, { criterionIndex: 2, result: 'pass', note: 'extra' }] }, ['criterion index 2 is out of range']],
    ['negative criterion index', { ...validReport, criteriaSelfAssessment: [...validReport.criteriaSelfAssessment, { criterionIndex: -1, result: 'pass', note: 'extra' }] }, ['criterion index -1 is out of range']],
    ['unknown result', { ...validReport, criteriaSelfAssessment: [{ criterionIndex: 0, result: 'maybe', note: 'unsure' }, validReport.criteriaSelfAssessment[0]] }, ['criteriaSelfAssessment[0].result must be pass, fail, or unknown']],
    ['modified path outside the territory glob', { ...validReport, filesModified: ['docs/a.md'] }, ['modified file path "docs/a.md" matches no write-territory glob']],
    ['more than 1,024 modified files', { ...validReport, filesModified: Array.from({ length: 1_025 }, () => 'src/a.ts') }, ['filesModified must contain no more than 1,024 entries']]
  ]
  for (const path of [
    '.git/config', '.quirky/objective/report.json', '/workspace/src/a.ts', 'C:/workspace/src/a.ts',
    'src/../outside.ts', 'src\\a.ts', './.git/config', '././.git/config',
    './.quirky/objective/report.json', '././.quirky/objective/report.json',
    './src/a.ts', '././src/a.ts', 'src/./a.ts', 'src/././a.ts', '.'
  ]) {
    invalidReports.push([
      `unsafe modified path ${path}`, { ...validReport, filesModified: [path] },
      [`modified file path ${JSON.stringify(path)} is not a safe relative path`], ['**']
    ])
  }
  for (const [name, value, expected, territory] of invalidReports) expectImplementerProblem(name, value, assignedTask, expected, territory)
})

test('validates reviewer and integrator verdicts and requires verdict=block to match blocking criteria', () => {
  const plan = plannerReport({
    plan: {
      tasks: [
        task({ criteria: [{ ...baseCriterion }, { ...baseCriterion, body: 'A second criterion.' }] }),
        task({ taskKey: 'test', title: 'Verify the change' })
      ]
    }
  })
  const criteriaResults = [
    { taskKey: 'add', criterionIndex: 0, result: 'pass', note: 'Implemented.' },
    { taskKey: 'add', criterionIndex: 1, result: 'block', note: 'Missing behavior.' },
    { taskKey: 'test', criterionIndex: 0, result: 'pass', note: 'Checked.' }
  ]
  const blockedReview = { verdict: 'block', criteriaResults, summary: 'One criterion remains blocked.' }
  expect(reviewerReportProblems(null, plan).some((problem) => problem.includes('report must be an object'))).toBe(true)
  expect(reviewerReportProblems({
    ...blockedReview,
    criteriaResults: [{ ...criteriaResults[0], result: 'maybe' }, ...criteriaResults.slice(1)]
  }, plan).some((problem) => problem.includes('result must be pass or block'))).toBe(true)
  expect(reviewerReportProblems(blockedReview, plan)).toEqual([])
  expect(integratorReportProblems({
    ...blockedReview,
    checksRun: [{ command: 'pnpm test', exitCode: 0 }]
  }, plan)).toEqual([])

  expect(reviewerReportProblems({
    ...blockedReview,
    verdict: 'approve'
  }, plan).some((problem) => problem.includes('verdict') && problem.includes('block'))).toBe(true)
  expect(reviewerReportProblems({
    ...blockedReview,
    verdict: 'block',
    criteriaResults: criteriaResults.map((result) => ({ ...result, result: 'pass' }))
  }, plan).some((problem) => problem.includes('verdict') && problem.includes('approve'))).toBe(true)
  expect(reviewerReportProblems({
    ...blockedReview,
    criteriaResults: criteriaResults.slice(1)
  }, plan).some((problem) => problem.includes('missing criterion'))).toBe(true)
  expect(reviewerReportProblems({
    ...blockedReview,
    criteriaResults: [...criteriaResults, criteriaResults[0]]
  }, plan).some((problem) => problem.includes('repeated'))).toBe(true)
  expect(reviewerReportProblems({
    ...blockedReview,
    criteriaResults: [{ ...criteriaResults[0], taskKey: 'unknown' }, ...criteriaResults.slice(1)]
  }, plan).some((problem) => problem.includes('unknown task'))).toBe(true)

  expect(integratorReportProblems({
    ...blockedReview,
    verdict: 'approve',
    criteriaResults: criteriaResults.map((result) => ({ ...result, result: 'pass' })),
    checksRun: [{ command: 'pnpm test', exitCode: 1 }]
  }, plan).some((problem) => problem.includes('exitCode'))).toBe(true)
  expect(integratorReportProblems({
    ...blockedReview,
    checksRun: [{ command: 'pnpm test', exitCode: '0' }]
  }, plan).some((problem) => problem.includes('checksRun'))).toBe(true)
  expect(integratorReportProblems({
    ...blockedReview,
    checksRun: [{ command: 1, exitCode: 0 }]
  }, plan).some((problem) => problem.includes('command must be a string'))).toBe(true)
})

test('rejects repair patches that touch frozen tasks, break dependencies, or overflow assumptions', () => {
  const base = plannerReport({
    plan: {
      tasks: [
        task({ taskKey: 'done' }),
        task({ taskKey: 'open', deps: ['done'] }),
        task({ taskKey: 'obsolete' })
      ]
    }
  })
  const validPatch: RepairPlannerReport = {
    repair: { upsertTasks: [task({ taskKey: 'open', deps: ['done'], spec: 'Revise the open task.' })], dropTaskKeys: [] },
    assumptions: []
  }
  expect(repairReportProblems(validPatch, base, ['done'])).toEqual([])
  expect(repairReportProblems({
    ...validPatch,
    repair: { upsertTasks: [task({ taskKey: 'done' })], dropTaskKeys: [] }
  }, base, ['done']).some((problem) => problem.includes('changes-frozen-node:done'))).toBe(true)
  expect(repairReportProblems({
    ...validPatch,
    repair: { upsertTasks: [], dropTaskKeys: ['done'] }
  }, base, ['done']).some((problem) => problem.includes('changes-frozen-node:done'))).toBe(true)
  expect(repairReportProblems({
    ...validPatch,
    repair: { upsertTasks: [], dropTaskKeys: ['unknown'] }
  }, base, ['done']).some((problem) => problem.includes('unknown drop task key'))).toBe(true)
  expect(repairReportProblems({
    ...validPatch,
    repair: {
      upsertTasks: [
        task({ taskKey: 'open', deps: ['new'] }),
        task({ taskKey: 'new', deps: ['open'] })
      ],
      dropTaskKeys: []
    }
  }, base, ['done']).some((problem) => problem.includes('dependency cycle'))).toBe(true)

  const fullAssumptions = plannerReport({
    assumptions: Array.from({ length: 64 }, (_, index) => ({
      claim: `Existing assumption ${index}.`,
      dependentTaskKeys: ['add']
    }))
  })
  expect(repairReportProblems({
    repair: { upsertTasks: [], dropTaskKeys: [] },
    assumptions: [{ claim: 'One more assumption.', dependentTaskKeys: ['add'] }]
  }, fullAssumptions, []).some((problem) => problem.includes('assumptions must contain no more than 64 entries'))).toBe(true)
  expect(repairReportProblems({
    repair: { upsertTasks: [], dropTaskKeys: [] },
    assumptions: []
  }, base, []).some((problem) => problem.includes('empty-repair-patch'))).toBe(true)
  expect(repairReportProblems({
    repair: { upsertTasks: [], dropTaskKeys: [1] },
    assumptions: []
  }, base, []).some((problem) => problem.includes('dropTaskKeys must be an array of strings'))).toBe(true)
  expect(repairReportProblems({
    repair: { upsertTasks: [null], dropTaskKeys: [] },
    assumptions: []
  }, base, []).some((problem) => problem.includes('repair.upsertTasks[0] must be an object'))).toBe(true)
  expect(repairReportProblems({
    repair: { upsertTasks: [task({ taskKey: 'done' })], dropTaskKeys: [] },
    assumptions: []
  }, base, []).some((problem) => problem.includes('empty-repair-patch'))).toBe(true)

  const applied = applyRepairPatchToRevision(base, {
    repair: {
      upsertTasks: [
        task({ taskKey: 'open', deps: ['done'], spec: 'Revised open task.' }),
        task({ taskKey: 'new', deps: ['done'] })
      ],
      dropTaskKeys: ['obsolete']
    },
    assumptions: [{ claim: 'New assumption.', dependentTaskKeys: ['new'] }]
  })
  expect(applied.plan.tasks.map((item) => item.taskKey)).toEqual(['done', 'open', 'new'])
  expect(applied.plan.tasks[1].spec).toBe('Revised open task.')
  expect(applied.assumptions).toHaveLength(base.assumptions.length + 1)
})

test('builds bounded repair-planner, reviewer, and integrator prompts', () => {
  const payload = {
    objectiveText: 'Add the requested behavior.',
    tier: 'full' as const,
    landingBar: 'files-on-disk' as const,
    lanesEnabled: false,
    maxConcurrency: 1,
    writeTerritory: ['src/**'],
    roleAgents: {},
    gates: [],
    worktree: '/workspace'
  }
  const plan = plannerReport()
  const reportPath = '/workspace/.quirky/objective/watcher/attempt.json'
  const rejectedInitialPrompt = objectivePrompt(
    payload,
    'planner',
    reportPath,
    undefined,
    undefined,
    { digest: 'abc123', reason: 'Please provide a clearer plan. '.repeat(10_000) }
  )
  expect(rejectedInitialPrompt).toContain('REJECTED DRAFT:')
  expect(rejectedInitialPrompt).toContain('abc123')
  const repairPrompt = repairPlannerSpec(
    payload,
    reportPath,
    [{ taskKey: 'done', title: 'Completed', state: 'succeeded', summary: 'Implemented.', filesModified: ['src/a.ts'] }],
    [task({ taskKey: 'open' })],
    { reason: 'The acceptance check failed.', command: 'pnpm test', exitCode: 1 },
    { digest: 'abc123', reason: 'Please make the patch narrower.' }
  )
  const reviewerPrompt = reviewerSpec(payload, reportPath, plan)
  const integratorPrompt = integratorSpec(payload, reportPath, plan)

  expect(repairPrompt).toContain('FROZEN TASKS:')
  expect(repairPrompt).toContain('OPEN TASKS:')
  expect(repairPrompt).toContain('FAILURE CONTEXT:')
  expect(repairPrompt).toContain('REJECTED DRAFT:')
  expect(repairPrompt).toContain(reportPath)
  expect(reviewerPrompt).toContain('ROLE: reviewer')
  expect(reviewerPrompt).toContain('every criterion exactly once')
  expect(reviewerPrompt).toContain('Do not modify any workspace files')
  expect(integratorPrompt).toContain('ROLE: integrator')
  expect(integratorPrompt).toContain('WRITE TERRITORY:')
  expect(integratorPrompt).toContain('checksRun')
  expect(integratorPrompt).toContain('run checks')

  const largePayload = { ...payload, objectiveText: 'objective '.repeat(40_000) }
  const boundedPrompts = [
    repairPlannerSpec(largePayload, reportPath, [], [], { details: 'failure '.repeat(40_000) }),
    reviewerSpec(largePayload, reportPath, plan),
    integratorSpec(largePayload, reportPath, plan)
  ]
  for (const prompt of [...boundedPrompts, repairPrompt, reviewerPrompt, integratorPrompt, rejectedInitialPrompt]) {
    expect(byteLength(prompt)).toBeLessThanOrEqual(262_144)
    expect(prompt).toContain('REPORT PATH:')
    expect(prompt).toContain('REPORT CONTRACT:')
  }
})
