import type { MethodHandler, PluginCaller, PluginContext } from '@quirky/protocol'
import type {
  AcceptedDispatchCheckpoint,
  DispatchId,
  DispatchParams,
  DispatchRow,
  DispatchShowParams,
  JsonValue,
  MutationCheckpoint,
  MutationReceiptRow,
  OrchestrationMethod,
  RequestShowResult,
  RequestShowParams,
  ResetParams,
  ResetMode,
  RunCreateParams,
  RunId,
  RunListParams,
  RunRow,
  RunShowParams,
  RunUseParams,
  RuntimeCallerEvidence,
  TaskCreateParams,
  TaskListParams,
  TaskResult,
  TaskRow,
  TaskUpdateParams,
  UUID
} from './contracts'
import { OrchestrationCore, type ReceiptRecord } from './core'
import { fail } from './errors'
import { callerSessionId, targetIdentity, verifyCaller } from './identity'
import type { SessionIdentity, SessionPointerResult } from './runtime-contracts'
const PAGE_DEFAULT = 100
const PAGE_MAX = 100
type RunTaskMethod = Exclude<
  OrchestrationMethod,
  'send' | 'check' | 'reply' | 'inbox' | 'ask' | 'gateCreate' | 'gateResolve' | 'gateList'
>

function encodeCursor(row: RunRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id }), 'utf8').toString('base64url')
}

function decodeCursor(context: PluginContext, value: string): { createdAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string' || !decoded.id.startsWith('run_')) throw new Error('shape')
    return { createdAt: decoded.createdAt, id: decoded.id }
  } catch {
    return fail(context, 'invalid_argument', 'Run cursor is invalid', { reason: 'cursor_invalid' })
  }
}

function coordinatorResult(text: string, caller: RuntimeCallerEvidence): TaskResult {
  return {
    kind: 'coordinator_update',
    text,
    reportedBy: caller.runtimeSessionId,
    completedAt: new Date().toISOString()
  }
}

function buildDispatchPreamble(task: TaskRow, dispatchId: DispatchId, coordinatorSessionId: string | null): string {
  return [
    'You are working inside Quirky, a multi-agent IDE. You are a dispatched worker.',
    `Your coordinator's Quirky session ID is: ${coordinatorSessionId ?? 'unknown'}`,
    `Your task ID is: ${task.id}`,
    `Your Dispatch ID is: ${dispatchId}`,
    '',
    'The coordinator cannot see your terminal transcript. Use the durable orchestration mailbox for questions, progress, and your result; do not report through other channels.',
    '',
    '=== CLI COMMANDS ===',
    '```sh',
    '# Read coordinator follow-ups at natural checkpoints.',
    'quirky orchestration check',
    '# After handling a Delivery, acknowledge it with: quirky orchestration check --ack <deliveryId>',
    '# Ask the coordinator instead of opening a local prompt. If it times out, resume the same message ID.',
    'quirky orchestration ask --question "<question>" [--options "<option1,option2>"]',
    'quirky orchestration ask --resume <messageId>',
    '# Send a heartbeat every five minutes while working; skip it while blocked in check --wait or ask.',
    `quirky orchestration send --type heartbeat --subject "Heartbeat" --task-id ${task.id} --dispatch-id ${dispatchId} --phase "implementing"`,
    '# Escalations are mail only; they do not settle the Task.',
    'quirky orchestration send --type escalation --subject "<short blocker>" --body "<context and help needed>"',
    '# Report exactly once, with a three-sentence summary, and select the actual outcome.',
    `quirky orchestration send --type worker_done --subject "<short summary>" --body "<what you did. What you found. What's left.>" --task-id ${task.id} --dispatch-id ${dispatchId} --outcome succeeded|failed`,
    '# Add --files-modified or --report-path only when you have real values.',
    '```',
    '',
    'After sending worker_done, stop work and remain at the session prompt. Do not keep checking or send lifecycle messages with these settled IDs.',
    '',
    '=== TASK ===',
    task.spec
  ].join('\\n')
}

export function runTaskMethods(
  context: PluginContext,
  core: OrchestrationCore,
  afterReset?: (mode: ResetMode) => void,
  afterRunBinding?: (run: RunRow) => void
): Record<RunTaskMethod, MethodHandler> {
  const handlers: Record<RunTaskMethod, MethodHandler> = {
    async runCreate(raw, caller) {
      const params = raw as unknown as RunCreateParams
      const verified = await verifyCaller(context, caller, params)
      const result = await core.mutate('runCreate', params, verified.evidence, () => ({ run: core.createRun(params, verified.evidence) }))
      if (!result.mutation.replayed) afterRunBinding?.(result.run)
      return result
    },

    async runUse(raw, caller) {
      const params = raw as unknown as RunUseParams
      const verified = await verifyCaller(context, caller, params)
      const result = await core.mutate('runUse', params, verified.evidence, () => ({ run: core.useRun(params, verified.evidence) }))
      if (!result.mutation.replayed) afterRunBinding?.(result.run)
      return result
    },

    async runCurrent(_raw, caller) {
      const sessionId = callerSessionId(caller)
      return { run: sessionId === null ? null : core.getBoundRun(sessionId) }
    },

    async runList(raw) {
      const params = raw as unknown as RunListParams
      const limit = params.limit ?? PAGE_DEFAULT
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
        fail(context, 'invalid_argument', `Run list limit must be between 1 and ${PAGE_MAX}`)
      }
      const cursor = params.cursor === undefined ? null : decodeCursor(context, params.cursor)
      const rows = core.store.all<{
        id: string
        objective: string
        coordinator_session_id: string | null
        coordinator_history_json: string
        consumer_generation: number
        created_at: string
        updated_at: string
      }>(
        `SELECT * FROM runs WHERE id != 'run_unbound' ${cursor ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1] : [limit + 1])
      )
      const hasNext = rows.length > limit
      const visible = hasNext ? rows.slice(0, limit) : rows
      const runs = visible.map((row): RunRow => ({
        id: row.id as RunId,
        objective: row.objective,
        coordinatorSessionId: row.coordinator_session_id,
        coordinatorHistory: JSON.parse(row.coordinator_history_json) as string[],
        consumerGeneration: row.consumer_generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
      return { runs, nextCursor: hasNext && runs.length ? encodeCursor(runs[runs.length - 1]!) : null }
    },

    async runShow(raw) {
      const params = raw as unknown as RunShowParams
      return { run: core.getRun(params.runId) }
    },

    async taskCreate(raw, caller) {
      const params = raw as unknown as TaskCreateParams
      const verified = await verifyCaller(context, caller, params)
      return core.mutate('taskCreate', params, verified.evidence, () => ({ task: core.createTask(params, verified.evidence) }))
    },

    async taskList(raw, caller) {
      const params = raw as unknown as TaskListParams
      if (params.runId !== undefined) return core.taskList(params)
      const verified = await verifyCaller(context, caller, params)
      return core.taskList(params, verified.evidence)
    },

    async taskUpdate(raw, caller) {
      const params = raw as unknown as TaskUpdateParams
      const verified = await verifyCaller(context, caller, params)
      return core.mutate('taskUpdate', params, verified.evidence, () => {
        const current = core.getTask(params.taskId)
        if (params.runId !== undefined && params.runId !== current.runId) {
          fail(context, 'consumer_fenced', `Task ${params.taskId} belongs to Run ${current.runId}, not ${params.runId}`, {
            taskId: params.taskId,
            runId: params.runId
          })
        }
        core.requireCoordinator(verified.evidence, current.runId)
        if (params.result === undefined && (params.status === undefined || params.status === current.status)) {
          return { task: current, unchanged: true }
        }
        const result = params.result === undefined ? current.result : coordinatorResult(params.result, verified.evidence)
        const task = core.transitionTask({
          taskId: current.id,
          expectedState: current.status,
          nextState: params.status ?? current.status,
          ...(params.result === undefined ? {} : { result }),
          at: new Date().toISOString()
        })
        return { task, unchanged: false }
      })
    },

    async dispatch(raw, caller) {
      const params = raw as unknown as DispatchParams
      const verified = await verifyCaller(context, caller, params)
      const dispatchScope = () => {
        const task = core.getTask(params.taskId)
        const run = core.requireCoordinator(verified.evidence, params.runId ?? task.runId)
        if (task.runId !== run.id) {
          fail(context, 'dispatch_run_mismatch', `Task ${task.id} belongs to Run ${task.runId}, not ${run.id}`, {
            taskId: task.id,
            runId: run.id
          })
        }
        return { task, run }
      }
      if (params.dryRun === true) {
        const { task, run } = dispatchScope()
        const admission = core.admitDispatch(
          { taskId: task.id, runId: run.id, assigneeSessionId: params.to },
          verified.evidence
        )
        if (!admission.admitted) {
          fail(context, admission.reason, 'Task is not startable for a Dispatch', {
            taskId: task.id,
            ...(admission.attemptedDepth === undefined ? {} : { attemptedDepth: admission.attemptedDepth }),
            ...(admission.maximumDepth === undefined ? {} : { maximumDepth: admission.maximumDepth }),
            ...(admission.failureCount === undefined ? {} : { failureCount: admission.failureCount })
          })
        }
        return {
          dryRun: true as const,
          dispatch: null,
          preamble: buildDispatchPreamble(task, 'ctx_dryrun' as DispatchId, run.coordinatorSessionId)
        }
      }

      let task: TaskRow | null = null
      let run: RunRow | null = null
      let identity: SessionIdentity | null = null
      let injectionText: string | null = null
      const beforeAccept = async (): Promise<void> => {
        const scope = dispatchScope()
        task = scope.task
        run = scope.run
        identity = await targetIdentity(context, params.to)
        if (identity.sessionId === verified.evidence.runtimeSessionId) {
          fail(context, 'terminal_is_coordinator', 'a session cannot be dispatched to itself', { sessionId: identity.sessionId })
        }
        if (params.inject) {
          const sessionValue: unknown = await context.call('quirky.session/get', { session: identity.sessionId })
          if (typeof sessionValue !== 'object' || sessionValue === null || Array.isArray(sessionValue)) {
            fail(context, 'inject_rejected', `session ${identity.sessionId} is not a running agent session`, { sessionId: identity.sessionId })
          }
          const session = sessionValue as { agent?: unknown; status?: unknown }
          if (typeof session.agent !== 'string' || session.agent === 'shell' || session.status === 'exited') {
            fail(context, 'inject_rejected', `session ${identity.sessionId} is not a running agent session`, { sessionId: identity.sessionId })
          }
        }
      }
      const acceptedOptions = params.inject
        ? {
            beforeAccept,
            acceptedCheckpoint: (accepted: { dispatch: DispatchRow }): AcceptedDispatchCheckpoint => ({
              state: 'accepted',
              accepted: true,
              runId: accepted.dispatch.runId,
              taskId: accepted.dispatch.taskId,
              dispatchId: accepted.dispatch.id
            }),
            async afterCommit(accepted: { dispatch: DispatchRow }): Promise<{ dispatch: DispatchRow; dryRun: false; preamble?: string }> {
              const recipient = identity
              if (!injectionText || !recipient) fail(context, 'operation_unknown', 'Dispatch was accepted but its injection preamble or recipient was not recorded')
              const sent = (await context.call('quirky.session/pointer', {
                session: recipient.sessionId,
                expectedIncarnation: recipient.processIncarnation,
                operationId: accepted.dispatch.id,
                text: injectionText,
                purpose: 'worker_start'
              })) as SessionPointerResult
              if (sent.operationId !== accepted.dispatch.id) {
                fail(context, 'operation_unknown', `Dispatch ${accepted.dispatch.id} injection returned a mismatched operation ID`)
              }
              if (sent.result.status !== 'submitted') {
                fail(context, 'operation_unknown', `Dispatch ${accepted.dispatch.id} injection did not settle`, {
                  dispatchId: accepted.dispatch.id,
                  pointerResult: sent.result
                })
              }
              return accepted
            }
          }
        : { beforeAccept }

      return core.mutate(
        'dispatch',
        params,
        verified.evidence,
        () => {
          const acceptedTask = task
          const acceptedRun = run
          const assignee = identity
          if (!acceptedTask || !acceptedRun || !assignee) {
            fail(context, 'identity_unavailable', 'Dispatch preflight did not establish its task, Run and assignee')
          }
          const dispatch = core.createDispatch(
            { taskId: acceptedTask.id, runId: acceptedRun.id, assigneeSessionId: assignee.sessionId },
            verified.evidence,
            assignee
          )
          const preamble = params.inject || params.returnPreamble
            ? buildDispatchPreamble(acceptedTask, dispatch.id, acceptedRun.coordinatorSessionId)
            : undefined
          injectionText = params.inject ? preamble ?? null : null
          return { dryRun: false as const, dispatch, ...(params.returnPreamble && preamble ? { preamble } : {}) }
        },
        acceptedOptions
      )
    },

    async dispatchShow(raw) {
      const params = raw as unknown as DispatchShowParams
      const task = core.getTask(params.taskId)
      const latest = core.store.get<{ id: string }>(
        `SELECT id FROM dispatches WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        task.id
      )
      const dispatch = latest ? core.getDispatch(latest.id as DispatchId) : null
      const worker = dispatch ? core.workerForDispatch(dispatch.id) : null
      const preamble = params.includePreamble
        ? buildDispatchPreamble(task, dispatch?.id ?? ('ctx_preview' as DispatchId), core.getRun(task.runId).coordinatorSessionId)
        : undefined
      return { dispatch, worker, ...(preamble === undefined ? {} : { preamble }) }
    },

    async reset(raw, caller) {
      const params = raw as unknown as ResetParams
      const verified = await verifyCaller(context, caller, params)
      const result = await core.mutate('reset', params, verified.evidence, () => {
        core.resetState(params.mode, new Date().toISOString())
        return { mode: params.mode }
      })
      if (!result.mutation.replayed) {
        try {
          afterReset?.(params.mode)
        } catch {
          // Mailbox resets are committed independently of best-effort in-memory wakeups.
        }
      }
      return result
    },

    async requestShow(raw, caller) {
      const params = raw as unknown as RequestShowParams
      if (caller.role === 'plugin') {
        return { requestId: params.requestId, state: 'absent', interpretation: 'absence_does_not_prove_no_effect' } satisfies RequestShowResult
      }
      let stored: ReceiptRecord | null = null
      const sessionId = caller.sessionId
      if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
        stored = core.readReceiptForSession(sessionId, params.requestId)
      } else {
        const matches = core.readReceiptsByRequestId(params.requestId)
        if (matches.length > 1) {
          fail(context, 'request_ambiguous', `request ${params.requestId} matches multiple caller scopes; inspect it from its originating session`, {
            requestId: params.requestId
          })
        }
        stored = matches[0] ?? null
      }
      if (!stored) {
        return { requestId: params.requestId, state: 'absent', interpretation: 'absence_does_not_prove_no_effect' } satisfies RequestShowResult
      }
      const receipt: MutationReceiptRow = {
        requestId: stored.request_id as UUID,
        method: stored.method as MutatingOrchestrationMethod,
        state: stored.state,
        ...(stored.checkpoint_json === null ? {} : { checkpoint: JSON.parse(stored.checkpoint_json) as MutationCheckpoint }),
        ...(stored.result_json === null ? {} : { result: JSON.parse(stored.result_json) as JsonValue }),
        createdAt: stored.created_at,
        updatedAt: stored.updated_at
      }
      if (stored.state === 'completed') {
        return {
          requestId: params.requestId,
          state: 'completed',
          method: receipt.method,
          createdAt: stored.created_at,
          updatedAt: stored.updated_at,
          receipt,
          interpretation: 'completed_and_replayable'
        }
      }
      return {
        requestId: params.requestId,
        state: 'pending',
        method: receipt.method,
        createdAt: stored.created_at,
        updatedAt: stored.updated_at,
        receipt,
        interpretation: 'running_or_outcome_unknown'
      }
    }
  }
  return handlers
}
