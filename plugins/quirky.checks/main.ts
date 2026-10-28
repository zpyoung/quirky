import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { PluginCaller, PluginContext, Worktree } from '@quirky/protocol'
import { runCommand, type CommandResult } from './executor'

const DEFAULT_TIMEOUT_SECONDS = 60

type CheckResult = CommandResult & { checkId: string }
type ActiveCheck = {
  controller: AbortController
  cancelled: boolean
  completion?: Promise<CheckResult>
}
type ErrorKind = 'invalid-params' | 'not-found' | 'conflict'

function callerIdentity(caller: PluginCaller): { cwd?: string; worktreeId?: string } {
  if (caller.role === 'plugin') return {}
  return {
    ...(caller.cwd ? { cwd: caller.cwd } : {}),
    ...(caller.worktreeId ? { worktreeId: caller.worktreeId } : {})
  }
}

function pathKind(path: string): 'directory' | 'missing' | 'other' {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return 'missing'
    throw error
  }
}

function resultFor(checkId: string, result: CommandResult, cancelled: boolean): CheckResult {
  const aborted = result.aborted || cancelled
  return {
    ...result,
    checkId,
    aborted,
    pass: result.ran && result.exitCode === 0 && !result.timedOut && !aborted && result.error === undefined
  }
}

export async function activate(context: PluginContext): Promise<void> {
  const active = new Map<string, ActiveCheck>()
  let shuttingDown = false
  const fail = (kind: ErrorKind, message: string) => context.error(kind, message)

  async function run(params: Record<string, unknown>, caller: PluginCaller): Promise<CheckResult> {
    if (shuttingDown) throw fail('conflict', 'checks plugin is shutting down')
    const command = params.command
    if (typeof command !== 'string' || command.trim() === '') {
      throw fail('invalid-params', 'command must be a nonblank string')
    }
    const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
      throw fail('invalid-params', 'timeoutSeconds must be an integer from 1 to 600')
    }
    if (params.cwd !== undefined && params.worktree !== undefined) {
      throw fail('invalid-params', 'cwd and worktree are mutually exclusive')
    }
    if (params.cwd !== undefined && (typeof params.cwd !== 'string' || !isAbsolute(params.cwd))) {
      throw fail('invalid-params', 'cwd must be an absolute path')
    }
    if (params.cwd !== undefined) {
      const kind = pathKind(params.cwd as string)
      if (kind === 'missing') throw fail('not-found', `cwd does not exist: ${params.cwd}`)
      if (kind !== 'directory') throw fail('invalid-params', `cwd is not a directory: ${params.cwd}`)
    }
    if (params.worktree !== undefined && (typeof params.worktree !== 'string' || params.worktree.trim() === '')) {
      throw fail('invalid-params', 'worktree selector must not be empty')
    }

    let checkId: string
    if (params.checkId !== undefined) {
      if (typeof params.checkId !== 'string' || params.checkId.length === 0) {
        throw fail('invalid-params', 'checkId must be a nonempty string')
      }
      checkId = params.checkId
      if (active.has(checkId)) throw fail('conflict', `checkId is already active: ${checkId}`)
    } else {
      checkId = randomUUID()
    }

    const record: ActiveCheck = { controller: new AbortController(), cancelled: false }
    active.set(checkId, record)
    const completion = (async () => {
      try {
        let cwd: string
        if (typeof params.cwd === 'string') {
          cwd = params.cwd
        } else {
          const selector = typeof params.worktree === 'string' ? params.worktree : 'current'
          const identity = callerIdentity(caller)
          const worktree = await context.call('quirky.worktree/resolve', {
            selector,
            ...(identity.cwd ? { cwd: identity.cwd } : {}),
            ...(identity.worktreeId ? { worktreeId: identity.worktreeId } : {})
          }) as Worktree
          cwd = worktree.path
        }
        const result = await runCommand({ command, cwd, timeoutSeconds, signal: record.controller.signal })
        return resultFor(checkId, result, record.cancelled)
      } finally {
        if (active.get(checkId) === record) active.delete(checkId)
      }
    })()
    record.completion = completion
    return completion
  }

  function cancel(params: Record<string, unknown>): { cancelled: boolean } {
    const checkId = params.checkId
    if (typeof checkId !== 'string' || checkId.length === 0) throw fail('invalid-params', 'checkId must be a nonempty string')
    const record = active.get(checkId)
    if (!record) return { cancelled: false }
    record.cancelled = true
    record.controller.abort()
    return { cancelled: true }
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true
    const runs = [...active.values()]
    for (const run of runs) {
      run.cancelled = true
      run.controller.abort()
    }
    await Promise.allSettled(runs.map((run) => run.completion).filter((completion): completion is Promise<CheckResult> => completion !== undefined))
  }
  shutdownChecks = shutdown
  context.provide('method:quirky.checks/run', run)
  context.provide('method:quirky.checks/cancel', cancel)
}

let shutdownChecks: (() => Promise<void>) | undefined

export async function deactivate(): Promise<void> {
  const shutdown = shutdownChecks
  shutdownChecks = undefined
  await shutdown?.()
}
