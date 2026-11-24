import { readFileSync } from 'node:fs'
import { Evaluator, Lexer, Parser, data } from '@actions/expressions'
import { parse } from 'yaml'
import { PR_CHECK_JOBS } from './pr-code-change-scope.mjs'

const selectorVariable = (job) => `${job.replaceAll('-', '_').toUpperCase()}_SHOULD_RUN`

/**
 * The classifier's jobs that this workflow reports through code_paths, plus any other needed job
 * that carries a selector (preflight's is derived from static_analysis and typecheck).
 */
function checkJobsForWorkflow(classifiedJobs, workflow, shell) {
  const outputs = workflow.jobs.code_paths.outputs
  const selected = classifiedJobs.filter((job) => job in outputs)
  const unlisted = workflow.jobs.verify.needs.filter(
    (job) => job !== 'preflight' && !selected.includes(job) && selectorVariable(job) in shell.env
  )
  return [...selected, ...unlisted]
}

export const aggregateWorkflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
export const aggregateJob = aggregateWorkflow.jobs.verify
export const aggregateShell = aggregateJob.steps.find(
  (step) => step.name === 'Require successful checks'
)
export const aggregateSelectors = checkJobsForWorkflow(
  PR_CHECK_JOBS.filter((job) => job !== 'quirkyd_browser'),
  aggregateWorkflow,
  aggregateShell
)
export const aggregateRequiredJobs = aggregateJob.needs.filter((job) => job !== 'code_paths')
export const aggregateVariable = (job) => job.replaceAll('-', '_').toUpperCase()

export function compileAggregateExpression(expression, contexts = ['needs']) {
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const functions = [{ name: 'cancelled', minArgs: 0, maxArgs: 0 }]
  const ast = new Parser(new Lexer(source).lex().tokens, contexts, functions).parse()
  return (context, cancelled = false) =>
    new Evaluator(
      ast,
      JSON.parse(JSON.stringify(context), data.reviver),
      new Map([['cancelled', { ...functions[0], call: () => new data.BooleanData(cancelled) }]])
    ).evaluate()
}

export const aggregateShouldRun = compileAggregateExpression(aggregateJob.if, ['needs', 'github'])
const aggregateEnvironmentExpressions = Object.fromEntries(
  Object.entries(aggregateShell.env).map(([name, expression]) => [
    name,
    compileAggregateExpression(expression)
  ])
)

export function aggregateEnvironment(needs) {
  return Object.fromEntries(
    Object.entries(aggregateEnvironmentExpressions).map(([name, evaluate]) => [
      name,
      evaluate({ needs }).coerceString()
    ])
  )
}

export function aggregateNeeds(selected = 'true', overrides = {}) {
  const outputs = {
    should_run: 'true',
    ...Object.fromEntries(aggregateSelectors.map((job) => [job, selected])),
    ...overrides
  }
  const needs = {
    code_paths: { result: 'success', outputs },
    ...Object.fromEntries(
      aggregateRequiredJobs.map((job) => [
        job,
        { result: outputs[job] === 'true' ? 'success' : 'skipped' }
      ])
    )
  }
  needs.preflight.result =
    aggregateEnvironmentExpressions.PREFLIGHT_SHOULD_RUN({ needs }).coerceString() === 'true'
      ? 'success'
      : 'skipped'
  return needs
}
