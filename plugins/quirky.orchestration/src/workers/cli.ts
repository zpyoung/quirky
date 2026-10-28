import { randomUUID } from 'node:crypto'
import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { MutationResult } from '../contracts'
import type { WorkerControlResult, WorkerListResult, WorkerReadResult, WorkerShowResult, WorkerStartReceipt } from '../worker-contracts'

const START_FLAGS: Record<string, string> = {
  task: 'taskId', spec: 'spec', worktree: 'worktree', on: 'on', agent: 'agent', terminal: 'terminal', mode: 'mode',
  'task-title': 'taskTitle', parent: 'parentTaskId', model: 'model', effort: 'effort', name: 'name', repo: 'repo',
  'base-branch': 'baseBranch', 'display-name': 'displayName', comment: 'comment', setup: 'setup',
  'retry-of': 'retryOfDispatchId', 'timeout-ms': 'timeoutMs', run: 'runId', from: 'from',
}
const CONTROL_METHODS = { 'worker-stop': 'workerStop', 'worker-abandon': 'workerAbandon', 'worker-release': 'workerRelease', 'worker-retain': 'workerRetain' } as const

function startText(receipt: WorkerStartReceipt): string {
  const lines = [`Worker ${receipt.dispatchId} [${receipt.state}] for ${receipt.taskId}`, `Stage: ${receipt.stage}`, `Mode: ${receipt.mode.mode} (${receipt.mode.reason})`, receipt.mode.detail]
  if (receipt.lastError) lines.push(`Error: ${receipt.lastError}`)
  if (receipt.warning) lines.push(`Warning: ${receipt.warning}`)
  if (receipt.recovery) lines.push(receipt.recovery)
  for (const effect of receipt.effects) lines.push(`${effect.kind} ${effect.role} ${effect.action}: ${effect.id}`)
  for (const command of receipt.nextCommands ?? []) lines.push(`Next command: quirky ${command.join(' ')}`)
  return lines.join('\n')
}
function controlText(receipt: WorkerControlResult): string {
  const lines = [`Worker ${receipt.dispatchId} [${receipt.state}] process=${receipt.processAction}`]
  if (receipt.archive) lines.push(`Archive ${receipt.archive.source} [${receipt.archive.status}]`)
  if (receipt.warning) lines.push(`Warning: ${receipt.warning}`)
  if (receipt.lastError) lines.push(`Error: ${receipt.lastError}`)
  return lines.join('\n')
}
function readText(result: WorkerReadResult): string {
  const lines = [`Source: ${result.source}`, `Worker: ${result.dispatchId}`, `Archived: ${result.archived}`, `Terminal liveness: ${result.terminalLiveness}`, `Agent liveness: ${result.agentLiveness.status}${result.agentLiveness.reason ? ` (${result.agentLiveness.reason})` : ''}`, `Source exact: ${result.sourceExact}`, `Fallback reason: ${result.fallbackReason ?? 'none'}`, `Content complete: ${result.contentComplete}`, `Clipping: ${result.clipping.clipped ? `clipped at ${result.clipping.maxBytes} bytes` : 'none'}`]
  if (result.nextCursor) lines.push(`Continuation cursor: ${result.nextCursor}`)
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`)
  lines.push('', result.content)
  return lines.join('\n')
}

/** Worker verbs compose into the feature's existing schema-declared CLI module. */
export const workerCommands: CliModule['commands'] = {
  async 'worker-start'(args, ctx) {
    const params: Record<string, unknown> = { requestId: ctx.requestBase, contractVersion: 1 }
    for (const [flag, property] of Object.entries(START_FLAGS)) if (args.flags[flag] !== undefined) params[property] = args.flags[flag]
    if (args.flags.deps !== undefined) {
      let dependencies: unknown
      try { dependencies = JSON.parse(String(args.flags.deps)) } catch { throw ctx.usage('--deps must be a JSON array of Task IDs') }
      if (!Array.isArray(dependencies) || dependencies.some((value) => typeof value !== 'string')) throw ctx.usage('--deps must be a JSON array of Task IDs')
      params.dependencyTaskIds = dependencies
    }
    const receipt = await ctx.call('quirky.orchestration/workerStart', params, { requestId: randomUUID() }) as MutationResult<WorkerStartReceipt>
    ctx.out.result(receipt, () => startText(receipt))
    if (receipt.state !== 'ready') throw ctx.fail(`Worker ${receipt.dispatchId} did not reach ready; inspect the printed receipt.`)
  },
  async 'worker-show'(args, ctx) {
    const shown = await ctx.call('quirky.orchestration/workerShow', { dispatchId: args.flags.dispatch }) as WorkerShowResult
    ctx.out.result(shown, () => {
      const wait = shown.observation.agentWait
      const lines = [`Worker ${shown.dispatch.id} [${shown.worker?.state ?? 'unsupervised'}]`, `Stage: ${shown.worker?.stage ?? shown.dispatch.status}`, `Agent liveness: ${shown.projection.liveness.status}${shown.projection.liveness.reason ? ` (${shown.projection.liveness.reason})` : ''}`, `Next action: ${shown.projection.nextAction.argv.join(' ') || 'none'}`]
      lines.push(wait === undefined ? 'Interactive wait: unknown (not evaluated)' : wait.waiting ? `Waiting on a human: ${wait.reason ?? 'input required'} (via ${wait.source})` : 'Interactive wait: none')
      return lines.join('\n')
    })
  },
  async 'worker-read'(args, ctx) {
    const params: Record<string, unknown> = { dispatchId: args.flags.dispatch }
    for (const key of ['source', 'cursor', 'limit']) if (args.flags[key] !== undefined) params[key] = args.flags[key]
    const result = await ctx.call('quirky.orchestration/workerRead', params) as WorkerReadResult
    ctx.out.result(result, () => readText(result))
  },
  async 'worker-list'(args, ctx) {
    const params: Record<string, unknown> = {}
    for (const [flag, property] of Object.entries({ run: 'runId', 'terminal-state': 'terminalState', 'include-remote': 'includeRemote', cursor: 'cursor', limit: 'limit' })) if (args.flags[flag] !== undefined) params[property] = args.flags[flag]
    const result = await ctx.call('quirky.orchestration/workerList', params) as WorkerListResult
    ctx.out.result(result, () => {
      const table = ctx.format.table(['Dispatch', 'Task', 'Worker', 'Terminal', 'Liveness', 'Attention', 'Next action'], result.workers.map((worker) => [worker.dispatchId, worker.taskId, worker.workerState ?? 'unsupervised', worker.terminalState, worker.projection.liveness.status, worker.projection.attention.categories.join(','), worker.projection.nextAction.argv.join(' ') || 'none']))
      return [table, ...(result.page.nextCursor ? [`Continuation cursor: ${result.page.nextCursor}`] : []), ...result.partialHostErrors.map((error) => `Warning: ${error.host}: ${error.reason}`)].join('\n')
    })
  },
  ...Object.fromEntries(Object.entries(CONTROL_METHODS).map(([verb, method]) => [verb, async (args: CliArgs, ctx: CliContext) => {
    const params: Record<string, unknown> = { requestId: ctx.requestBase, contractVersion: 1, dispatchId: args.flags.dispatch }
    if (args.flags.from !== undefined) params.from = args.flags.from
    const result = await ctx.call(`quirky.orchestration/${method}`, params, { requestId: randomUUID() }) as MutationResult<WorkerControlResult>
    ctx.out.result(result, () => controlText(result))
    if (result.state === 'stop_unknown' || result.state === 'release_unknown') throw ctx.fail(`Worker ${result.dispatchId} outcome is uncertain; inspect the printed receipt.`)
  }]))
}
