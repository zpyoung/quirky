import { randomBytes } from 'node:crypto'
import type {
  DispatchStatus,
  DispatchId,
  GateCreateParams,
  GateId,
  GateListParams,
  GateResolveParams,
  GateRow,
  GateStatus,
  RunId,
  RuntimeCallerEvidence,
  TaskRow,
  UtcTimestamp
} from './contracts'
import { OrchestrationCore } from './core'
import { fail } from './errors'

const newGateId = (): GateId => `gate_${randomBytes(6).toString('hex')}`
const now = (): UtcTimestamp => new Date().toISOString()

type GateRecord = {
  id: string
  run_id: string
  task_id: string
  question: string
  options_json: string
  status: GateStatus
  resolution: string | null
  created_by_session_id: string
  created_at: string
  resolved_at: string | null
}

function gateRow(row: GateRecord): GateRow {
  return {
    id: row.id as GateId,
    runId: row.run_id as RunId,
    taskId: row.task_id as TaskRow['id'],
    question: row.question,
    options: JSON.parse(row.options_json) as string[],
    status: row.status,
    resolution: row.resolution,
    createdBySessionId: row.created_by_session_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

export class OrchestrationGates {
  constructor(private readonly core: OrchestrationCore) {}

  create(input: GateCreateParams, caller: RuntimeCallerEvidence): { gate: GateRow; task: TaskRow } {
    const task = this.core.getTask(input.taskId)
    const run = this.core.requireCoordinator(caller, task.runId)
    if (task.status === 'completed' || task.status === 'failed') {
      fail(this.core.context, 'task_not_startable', `cannot open a decision gate on ${task.status} Task ${task.id}`, { taskId: task.id, status: task.status })
    }
    if (this.core.hasLiveWorkerForTask(task.id)) {
      fail(this.core.context, 'task_not_startable', `cannot open a gate while a supervised Dispatch for Task ${task.id} is active`, {
        taskId: task.id,
        status: task.status
      })
    }
    const options = [...(input.options ?? [])]
    if (new Set(options).size !== options.length) fail(this.core.context, 'invalid_argument', 'gate options must not contain duplicates')
    const at = now()
    const id = newGateId()
    this.core.store.run(
      `INSERT INTO gates (id, run_id, task_id, question, options_json, status, resolution, created_by_session_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      id,
      run.id,
      task.id,
      input.question,
      JSON.stringify(options),
      caller.runtimeSessionId,
      at
    )
    const active = this.core.store.all<{ id: string; status: DispatchStatus }>(
      `SELECT * FROM dispatches WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY created_at DESC, id DESC`,
      task.id
    )
    for (const dispatch of active) {
      this.core.settleDispatchWithoutTask(
        dispatch.status === 'pending'
          ? { dispatchId: dispatch.id as DispatchId, expectedState: 'pending', nextState: 'completed', at }
          : { dispatchId: dispatch.id as DispatchId, expectedState: 'dispatched', nextState: 'completed', at }
      )
    }
    this.core.store.run(`UPDATE tasks SET status = 'blocked', completed_at = NULL WHERE id = ?`, task.id)
    const row = this.core.store.get<GateRecord>('SELECT * FROM gates WHERE id = ?', id)
    if (!row) fail(this.core.context, 'lifecycle_conflict', `gate ${id} was not stored`)
    return { gate: gateRow(row), task: this.core.getTask(task.id) }
  }

  resolve(input: GateResolveParams, caller: RuntimeCallerEvidence): { gate: GateRow; task: TaskRow } {
    const record = this.core.store.get<GateRecord>('SELECT * FROM gates WHERE id = ?', input.gateId)
    if (!record) fail(this.core.context, 'gate_not_found', `gate ${input.gateId} does not exist`, { gateId: input.gateId })
    const task = this.core.getTask(record.task_id as TaskRow['id'])
    this.core.requireCoordinator(caller, record.run_id as RunId)
    if (record.status !== 'pending') {
      fail(this.core.context, 'lifecycle_conflict', `gate ${input.gateId} is already ${record.status}`, { gateId: input.gateId, status: record.status })
    }
    const options = JSON.parse(record.options_json) as string[]
    if (options.length > 0 && !options.includes(input.resolution)) {
      fail(this.core.context, 'invalid_argument', `resolution must match one of the gate options`, { gateId: input.gateId })
    }
    const at = now()
    const update = this.core.store.run(
      `UPDATE gates SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
      input.resolution,
      at,
      input.gateId
    )
    if (update.changes !== 1) fail(this.core.context, 'lifecycle_conflict', `gate ${input.gateId} changed during resolution`, { gateId: input.gateId })
    this.core.store.run(`UPDATE tasks SET status = 'ready', completed_at = NULL WHERE id = ?`, task.id)
    const resolved = this.core.store.get<GateRecord>('SELECT * FROM gates WHERE id = ?', input.gateId)
    if (!resolved) fail(this.core.context, 'lifecycle_conflict', `gate ${input.gateId} disappeared during resolution`)
    return { gate: gateRow(resolved), task: this.core.getTask(task.id) }
  }

  list(input: GateListParams, caller?: RuntimeCallerEvidence): { runId: RunId; gates: readonly GateRow[]; count: number } {
    let runId = input.runId
    if (input.taskId !== undefined) {
      const task = this.core.getTask(input.taskId)
      if (runId !== undefined && task.runId !== runId) {
        fail(this.core.context, 'dispatch_run_mismatch', `Task ${task.id} does not belong to Run ${runId}`, { taskId: task.id, runId })
      }
      runId = task.runId
    }
    if (runId === undefined) {
      if (!caller) fail(this.core.context, 'run_required', 'a Run must be bound or explicitly named')
      runId = this.core.requireCoordinator(caller).id
    } else {
      this.core.getRun(runId)
    }
    const clauses = ['run_id = ?']
    const values: (string | number | null)[] = [runId]
    if (input.taskId !== undefined) {
      clauses.push('task_id = ?')
      values.push(input.taskId)
    }
    if (input.status !== undefined) {
      clauses.push('status = ?')
      values.push(input.status)
    }
    const rows = this.core.store.all<GateRecord>(
      `SELECT * FROM gates WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`,
      ...values
    )
    const gates = rows.map(gateRow)
    return { runId, gates, count: gates.length }
  }
}
