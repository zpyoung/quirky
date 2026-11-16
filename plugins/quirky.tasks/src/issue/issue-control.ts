import type { UiPluginContext } from '@quirky/protocol'

export const ISSUE_CONTROL_COMMAND = 'command:quirky.tasks/issue-control'
export const ISSUE_CONTROL_ACTIONS = ['edit-description', 'cancel-description', 'cancel-duplicate'] as const
export type IssueControlAction = typeof ISSUE_CONTROL_ACTIONS[number]
export type IssueControlRequest = { worktree: string; number: number; action: IssueControlAction }
export type IssueControlResult = { delivered: number }
/** Returns true when the mounted issue page shows the named issue and applied the action. */
export type IssueControlHandler = (request: IssueControlRequest) => boolean

type IssueControlDescriptor = { command: typeof ISSUE_CONTROL_COMMAND; args: IssueControlRequest }

const registries = new WeakMap<UiPluginContext, Set<IssueControlHandler>>()
const connections = new WeakMap<UiPluginContext, number>()

function issueControlDescriptor(args: IssueControlRequest): IssueControlDescriptor {
  return { command: ISSUE_CONTROL_COMMAND, args }
}

/** Validates command input; throws one fixed message for any malformed request. */
export function parseIssueControlRequest(input: unknown): IssueControlRequest {
  const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null
  const action = value?.action
  if (!value || typeof value.worktree !== 'string' || value.worktree === '' || typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number < 1
    || typeof action !== 'string' || !(ISSUE_CONTROL_ACTIONS as readonly string[]).includes(action)) {
    throw new Error('issue-control needs a worktree, a positive integer number, and an action of edit-description, cancel-description or cancel-duplicate.')
  }
  return { worktree: value.worktree, number: value.number, action: action as IssueControlAction }
}

/** Adds one mounted issue page to this window's dispatch set; the returned function removes it. */
export function registerIssueControl(context: UiPluginContext, handler: IssueControlHandler): () => void {
  let registry = registries.get(context)
  if (!registry) {
    registry = new Set()
    registries.set(context, registry)
  }
  registry.add(handler)
  return () => { registry.delete(handler) }
}

/** Runs the command against every issue page mounted in this window and counts the pages that acted. */
export function runIssueControl(context: UiPluginContext, input: unknown): IssueControlResult {
  const request = parseIssueControlRequest(input)
  let delivered = 0
  for (const handler of [...(registries.get(context) ?? [])]) if (handler(request)) delivered += 1
  return { delivered }
}

/**
 * Sends the command to this window's own UI connection, so a popped-out Tasks view reaches its own
 * mount rather than the owner window's. Rejects when the daemon can't name the connection or the run fails.
 */
export async function dispatchIssueControl(context: UiPluginContext, request: IssueControlRequest): Promise<void> {
  let connId = connections.get(context)
  if (connId === undefined) {
    const self = await context.call('ui.window.self', {})
    const value = typeof self === 'object' && self !== null && 'connId' in self ? self.connId : undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('The daemon did not identify this UI connection.')
    connId = value
    connections.set(context, connId)
  }
  const descriptor = issueControlDescriptor(request)
  await context.call('ui.window.command.run', { connId, id: descriptor.command, args: descriptor.args })
}
