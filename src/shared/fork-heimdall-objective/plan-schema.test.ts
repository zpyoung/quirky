import { describe, expect, it } from 'vitest'
import {
  OBJECTIVE_CHECK_COMMAND_MAX_LENGTH,
  OBJECTIVE_CRITERION_BODY_MAX_LENGTH,
  OBJECTIVE_CRITERION_NOTE_MAX_LENGTH,
  OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES,
  OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH,
  OBJECTIVE_TASK_KEY_MAX_LENGTH,
  OBJECTIVE_TASK_SPEC_MAX_LENGTH,
  OBJECTIVE_TASK_TITLE_MAX_LENGTH
} from './contract-types'
import {
  CriterionSelfAssessmentSchema,
  ImplementerReportSchema,
  IntegratorReportSchema,
  ObjectivePlanAssumptionSchema,
  ObjectivePlanSchema,
  OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH,
  PlannerReportSchema,
  ReviewerReportSchema,
  objectivePathMatchesTerritory,
  parseAndValidateImplementerReport,
  parseAndValidatePlannerReport,
  parseAndValidateReviewerReport,
  type ObjectivePlanTask
} from './plan-schema'
import { checkableTask as task } from './decision-test-harness'

describe('objective plan schema', () => {
  it('accepts a bounded acyclic task graph', () => {
    const report = PlannerReportSchema.parse({
      plan: [task('core'), task('ui', { deps: ['core'], declaredPaths: ['src/ui.ts'] })]
    })
    expect(report.plan.map((item) => item.taskKey)).toEqual(['core', 'ui'])
  })

  it('rejects duplicate, unknown, self and cyclic dependencies', () => {
    const invalidPlans: ObjectivePlanTask[][] = [
      [task('same'), task('same')],
      [task('a', { deps: ['missing'] })],
      [task('a', { deps: ['a'] })],
      [task('a', { deps: ['b'] }), task('b', { deps: ['a'] })]
    ]
    for (const plan of invalidPlans) {
      expect(ObjectivePlanSchema.safeParse(plan).success).toBe(false)
    }
  })

  it('rejects malformed and missing acceptance criteria', () => {
    expect(ObjectivePlanSchema.safeParse([task('a', { criteria: [] })]).success).toBe(false)
    expect(
      ObjectivePlanSchema.safeParse([
        task('a', {
          criteria: [{ body: 'broken pair', shellCheckable: true, checkCommand: null }]
        })
      ]).success
    ).toBe(false)
  })

  it('enforces the published planner string maxima at the exact boundary', () => {
    const taskKey = 'k'.repeat(OBJECTIVE_TASK_KEY_MAX_LENGTH)
    expect(ObjectivePlanSchema.safeParse([task(taskKey)]).success).toBe(true)
    expect(ObjectivePlanSchema.safeParse([task(`${taskKey}k`)]).success).toBe(false)

    const title = 't'.repeat(OBJECTIVE_TASK_TITLE_MAX_LENGTH)
    expect(ObjectivePlanSchema.safeParse([task('title-at-cap', { title })]).success).toBe(true)
    expect(
      ObjectivePlanSchema.safeParse([task('title-over-cap', { title: `${title}t` })]).success
    ).toBe(false)

    const body = 'b'.repeat(OBJECTIVE_CRITERION_BODY_MAX_LENGTH)
    const command = 'c'.repeat(OBJECTIVE_CHECK_COMMAND_MAX_LENGTH)
    expect(
      ObjectivePlanSchema.safeParse([
        task('criterion-at-cap', {
          criteria: [{ body, shellCheckable: true, checkCommand: command }]
        })
      ]).success
    ).toBe(true)
    expect(
      ObjectivePlanSchema.safeParse([
        task('criterion-body-over-cap', {
          criteria: [{ body: `${body}b`, shellCheckable: true, checkCommand: command }]
        })
      ]).success
    ).toBe(false)
    expect(
      ObjectivePlanSchema.safeParse([
        task('check-command-over-cap', {
          criteria: [{ body, shellCheckable: true, checkCommand: `${command}c` }]
        })
      ]).success
    ).toBe(false)
  })

  it('enforces territory and preserves every previously dispatched task key', () => {
    expect(() =>
      parseAndValidatePlannerReport(
        {
          plan: [task('kept', { declaredPaths: ['src/a.ts'], territory: ['src/**'] })],
          assumptions: []
        },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: ['kept'] }
      )
    ).not.toThrow()
    expect(() =>
      parseAndValidatePlannerReport(
        {
          plan: [task('kept', { declaredPaths: ['docs/a.txt'], territory: ['src/**'] })],
          assumptions: []
        },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: ['kept'] }
      )
    ).toThrow('outside write territory')
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [task('replacement')], assumptions: [] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: ['already-dispatched'] }
      )
    ).toThrow('cannot be removed')
  })

  it('requires every write-path task to declare territory outside the objective territory being an error', () => {
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [task('a')], assumptions: [] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: [] }
      )
    ).toThrow('Planner task a must declare territory')
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [task('a', { territory: ['docs/**'] })], assumptions: [] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: [] }
      )
    ).not.toThrow()
  })

  it('requires assumptions to be present, even when empty, on the write path', () => {
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [task('a', { territory: ['src/**'] })] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: [] }
      )
    ).toThrow('Planner report must declare assumptions (use [] when none)')
  })

  it('rejects an assumption that names a task outside the plan', () => {
    expect(() =>
      parseAndValidatePlannerReport(
        {
          plan: [task('a', { territory: ['src/**'] })],
          assumptions: [{ claim: 'no migration is needed', dependentTaskKeys: ['missing'] }]
        },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: [] }
      )
    ).toThrow('Assumption 0 names unknown task missing')
  })

  it('rejects a task whose dispatch snapshot exceeds the byte cap, naming the task and the limit', () => {
    const oversized = task('too-big', {
      spec: 's'.repeat(OBJECTIVE_TASK_SPEC_MAX_LENGTH),
      territory: ['src/**']
    })
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [oversized], assumptions: [] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: [] }
      )
    ).toThrow(
      new RegExp(
        `Task too-big dispatch snapshot is \\d+ bytes, exceeding the ${OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES}-byte limit`
      )
    )
  })

  it('parses stored plans that predate territory and assumptions', () => {
    expect(PlannerReportSchema.safeParse({ plan: [task('legacy')] }).success).toBe(true)
  })
})

describe('ObjectivePlanAssumptionSchema evidence', () => {
  it('is optional', () => {
    expect(
      ObjectivePlanAssumptionSchema.safeParse({ claim: 'ok', dependentTaskKeys: [] }).success
    ).toBe(true)
  })

  it('accepts a bounded command and observed pair', () => {
    expect(
      ObjectivePlanAssumptionSchema.safeParse({
        claim: 'ok',
        dependentTaskKeys: [],
        evidence: { command: 'pnpm test', observed: 'all green' }
      }).success
    ).toBe(true)
  })

  it('rejects evidence text over the max length', () => {
    expect(
      ObjectivePlanAssumptionSchema.safeParse({
        claim: 'ok',
        dependentTaskKeys: [],
        evidence: { command: 'x'.repeat(OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH + 1), observed: 'ok' }
      }).success
    ).toBe(false)
  })

  it('rejects an empty command or observed string', () => {
    expect(
      ObjectivePlanAssumptionSchema.safeParse({
        claim: 'ok',
        dependentTaskKeys: [],
        evidence: { command: '', observed: 'ok' }
      }).success
    ).toBe(false)
    expect(
      ObjectivePlanAssumptionSchema.safeParse({
        claim: 'ok',
        dependentTaskKeys: [],
        evidence: { command: 'ok', observed: '' }
      }).success
    ).toBe(false)
  })

  it('rejects unknown evidence fields under strict mode', () => {
    expect(
      ObjectivePlanAssumptionSchema.safeParse({
        claim: 'ok',
        dependentTaskKeys: [],
        evidence: { command: 'pnpm test', observed: 'ok', extra: true }
      }).success
    ).toBe(false)
  })
})

describe('criterion self-assessment results', () => {
  it('accepts fail alongside the existing pass and unknown results', () => {
    for (const result of ['pass', 'fail', 'unknown'] as const) {
      expect(
        CriterionSelfAssessmentSchema.safeParse({ criterionIndex: 0, result, note: 'checked' })
          .success
      ).toBe(true)
    }
    expect(
      CriterionSelfAssessmentSchema.safeParse({ criterionIndex: 0, result: 'blocked', note: 'x' })
        .success
    ).toBe(false)
  })
})

describe('objective write territory matching', () => {
  it('matches root and nested workspace paths without admitting protected state', () => {
    expect(objectivePathMatchesTerritory('README.md', ['**'])).toBe(true)
    expect(objectivePathMatchesTerritory('src/nested/file.ts', ['**'])).toBe(true)
    expect(objectivePathMatchesTerritory('.git/config', ['**'])).toBe(false)
    expect(objectivePathMatchesTerritory('.quirky/runtime/state.json', ['**'])).toBe(false)
  })
})

describe('objective role report schemas', () => {
  it('requires implementer coverage and modified files inside territory', () => {
    const planned = task('core', {
      criteria: [
        { body: 'first', shellCheckable: false, checkCommand: null },
        { body: 'second', shellCheckable: true, checkCommand: 'pnpm check' }
      ]
    })
    expect(() =>
      parseAndValidateImplementerReport(
        {
          taskKey: 'core',
          summary: 'Implemented',
          filesModified: ['src/core.ts'],
          criteriaSelfAssessment: [
            { criterionIndex: 0, result: 'pass', note: 'Inspected' },
            { criterionIndex: 1, result: 'pass', note: 'Check passed' }
          ]
        },
        planned,
        ['src/**']
      )
    ).not.toThrow()
    expect(() =>
      parseAndValidateImplementerReport(
        {
          taskKey: 'core',
          summary: 'Incomplete',
          filesModified: ['docs/outside.md'],
          criteriaSelfAssessment: [{ criterionIndex: 0, result: 'unknown', note: 'Not checked' }]
        },
        planned,
        ['src/**']
      )
    ).toThrow()
  })

  it('rejects incomplete reviewer criterion coverage rather than treating omission as approval', () => {
    const plan = [
      task('core', {
        criteria: [
          { body: 'first', shellCheckable: false, checkCommand: null },
          { body: 'second', shellCheckable: false, checkCommand: null }
        ]
      })
    ]
    expect(() =>
      parseAndValidateReviewerReport(
        {
          verdict: 'approve',
          criteriaResults: [
            { taskKey: 'core', criterionIndex: 0, result: 'pass', note: 'Only one reviewed' }
          ],
          summary: 'Incomplete'
        },
        plan
      )
    ).toThrow('every plan criterion')
  })

  it('requires verdicts to agree with criterion results for reviewer and integrator reports', () => {
    const inconsistent = {
      verdict: 'approve',
      criteriaResults: [{ taskKey: 'core', criterionIndex: 0, result: 'block', note: 'Broken' }],
      summary: 'Blocked'
    }
    expect(ReviewerReportSchema.safeParse(inconsistent).success).toBe(false)
    expect(IntegratorReportSchema.safeParse({ ...inconsistent, checksRun: [] }).success).toBe(false)
  })

  it('enforces the canonical report text boundaries in UTF-16 code units', () => {
    const summary = 's'.repeat(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH)
    const reports = [
      [
        ImplementerReportSchema,
        { taskKey: 'core', summary, filesModified: [], criteriaSelfAssessment: [] }
      ],
      [ReviewerReportSchema, { verdict: 'approve', criteriaResults: [], summary }],
      [IntegratorReportSchema, { verdict: 'approve', criteriaResults: [], summary, checksRun: [] }]
    ] as const

    for (const [schema, report] of reports) {
      expect(schema.safeParse(report).success).toBe(true)
      expect(schema.safeParse({ ...report, summary: `${summary}x` }).success).toBe(false)
    }
    expect(
      ObjectivePlanSchema.safeParse([
        task('task-spec-at-cap', { spec: 's'.repeat(OBJECTIVE_TASK_SPEC_MAX_LENGTH) })
      ]).success
    ).toBe(true)
    expect(
      ObjectivePlanSchema.safeParse([
        task('task-spec-over-cap', { spec: 's'.repeat(OBJECTIVE_TASK_SPEC_MAX_LENGTH + 1) })
      ]).success
    ).toBe(false)

    const multibyteNote = '界'.repeat(OBJECTIVE_CRITERION_NOTE_MAX_LENGTH)
    expect(Buffer.byteLength(multibyteNote, 'utf8')).toBeGreaterThan(multibyteNote.length)
    expect(
      CriterionSelfAssessmentSchema.safeParse({
        criterionIndex: 0,
        result: 'pass',
        note: multibyteNote
      }).success
    ).toBe(true)
    expect(
      CriterionSelfAssessmentSchema.safeParse({
        criterionIndex: 0,
        result: 'pass',
        note: `${multibyteNote}界`
      }).success
    ).toBe(false)
  })

  it('keeps report objects strict and bounded', () => {
    expect(
      ImplementerReportSchema.safeParse({
        taskKey: 'core',
        summary: 'Done',
        filesModified: [],
        criteriaSelfAssessment: [],
        extra: true
      }).success
    ).toBe(false)
  })
})
