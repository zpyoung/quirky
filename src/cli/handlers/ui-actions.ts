import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { waitForEvent } from '../public-cli/wait-for-event'
import { RuntimeClientError } from '../runtime/types'
import { getOptionalWorktreeSelector } from '../selectors'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { readCallerHintFromEnv, type CallerHint } from '../../shared/public-rpc/caller-hint'
import type { PublicEvent } from '../../shared/public-rpc/public-events'

const ACTION_WAIT_TIMEOUT_MS = 2000

type UiStateResult = {
  worktreeId: string | null
  view: string
  tab: { id: string; type: string; title: string } | null
  paneId: string | null
  panels: {
    leftSidebar: boolean
    rightSidebar: { open: boolean; tab: string | null }
    floatingTerminal: boolean
  }
  editorFile: string | null
}

type ActionEntry = {
  id: string
  description: string
  available: boolean
  reason?: string
  destructive?: unknown
}

type ActionListResult = { actions: ActionEntry[] }

type ActionRunResult = { claimed: true }

type ActionRunWaitResult = ActionRunResult & { event?: PublicEvent; state?: UiStateResult }

/** The options every public-contract call carries: the server gates and attributes only requests that set them. */
export function publicCallOptions(confirm = false): {
  publicContract: true
  confirm: boolean
  caller: CallerHint | undefined
} {
  const hint = readCallerHintFromEnv(process.env)
  return {
    publicContract: true,
    confirm,
    caller: Object.keys(hint).length > 0 ? hint : undefined
  }
}

/** A remote request cannot carry the server-side confirm gate, so the CLI refuses an unconfirmed change itself. */
export function throwConfirmationRequired(ctx: HandlerContext, what: string): never {
  const command = [...(ctx.rawArgs ?? []), '--yes'].map(quoteCliCommandArgument).join(' ')
  throw new RuntimeClientError(
    'needs_confirmation',
    `${what} changes state and needs confirmation.`,
    {
      reason: 'confirmation_required',
      next: [{ command: `quirky ${command}`, why: 'run again with --yes to confirm' }]
    }
  )
}

function formatUiState(state: UiStateResult): string {
  const tab = state.tab ? `${state.tab.type} ${state.tab.id} ${state.tab.title}` : 'none'
  const rightSidebar = state.panels.rightSidebar.open
    ? `open${state.panels.rightSidebar.tab ? ` (${state.panels.rightSidebar.tab})` : ''}`
    : 'closed'
  return [
    `worktree: ${state.worktreeId ?? 'none'}`,
    `view: ${state.view}`,
    `tab: ${tab}`,
    `pane: ${state.paneId ?? 'none'}`,
    `left sidebar: ${state.panels.leftSidebar ? 'open' : 'closed'}`,
    `right sidebar: ${rightSidebar}`,
    `floating terminal: ${state.panels.floatingTerminal ? 'open' : 'closed'}`,
    `editor file: ${state.editorFile ?? 'none'}`
  ].join('\n')
}

function formatActionList(result: ActionListResult): string {
  if (result.actions.length === 0) {
    return 'No actions.'
  }
  return result.actions
    .map((action) => {
      const flags = [
        action.available ? null : `unavailable${action.reason ? `: ${action.reason}` : ''}`,
        action.destructive ? 'destructive' : null
      ].filter((flag) => flag !== null)
      return `${action.id}  ${action.description}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`
    })
    .join('\n')
}

function formatActionRun(actionId: string, result: ActionRunWaitResult): string {
  if (result.event) {
    return `Ran ${actionId}; ui event ${result.event.type}`
  }
  if (result.state) {
    return `Ran ${actionId}; no ui event within ${ACTION_WAIT_TIMEOUT_MS}ms, current state:\n${formatUiState(result.state)}`
  }
  return `Ran ${actionId}`
}

function isWaitTimeout(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === 'timeout'
}

async function runAction(ctx: HandlerContext): Promise<void> {
  const { flags, client, cwd, json } = ctx
  const actionId = getRequiredStringFlag(flags, 'id')
  const workspace = await getOptionalWorktreeSelector(flags, 'workspace', cwd, client)
  const yes = flags.has('yes')
  const params = { actionId, ...(workspace ? { workspace } : {}) }
  const run = () => client.call<ActionRunResult>('ui.runAction', params, publicCallOptions(yes))

  if (!flags.has('wait')) {
    const response = await run()
    printResult(response, json, (result) => formatActionRun(actionId, result))
    return
  }

  const started: { call?: ReturnType<typeof run> } = {}
  try {
    const { result: response, event } = await waitForEvent(
      client,
      { topics: ['ui'], match: () => true, timeoutMs: ACTION_WAIT_TIMEOUT_MS },
      () => {
        started.call = run()
        return started.call
      }
    )
    printResult({ ...response, result: { ...response.result, event } }, json, (result) =>
      formatActionRun(actionId, result)
    )
  } catch (error) {
    if (!isWaitTimeout(error) || started.call === undefined) {
      throw error
    }
    const response = await started.call
    const state = await client.call<UiStateResult>('ui.state', undefined, publicCallOptions())
    printResult(
      { ...response, result: { ...response.result, state: state.result } },
      json,
      (result) => formatActionRun(actionId, result)
    )
  }
}

async function firstLayoutFrame(ctx: HandlerContext): Promise<unknown> {
  const stop = new AbortController()
  let first: { frame: unknown } | undefined
  await ctx.client.stream(
    'layout.subscribe',
    {},
    (frame) => {
      if (!first) {
        first = { frame }
        stop.abort()
      }
    },
    { signal: stop.signal }
  )
  if (!first) {
    throw new RuntimeClientError('unavailable', 'The layout stream ended before sending a frame.')
  }
  return first.frame
}

export const UI_ACTION_HANDLERS: Record<string, CommandHandler> = {
  'ui state': async ({ client, json }) => {
    const response = await client.call<UiStateResult>('ui.state', undefined, publicCallOptions())
    printResult(response, json, formatUiState)
  },
  'action list': async ({ flags, client, cwd, json }) => {
    const workspace = await getOptionalWorktreeSelector(flags, 'workspace', cwd, client)
    const params = {
      ...(flags.has('available') ? { available: true } : {}),
      ...(workspace ? { workspace } : {})
    }
    const response = await client.call<ActionListResult>(
      'ui.listActions',
      params,
      publicCallOptions()
    )
    printResult(response, json, formatActionList)
  },
  'action run': runAction,
  'layout get': async (ctx) => {
    console.log(JSON.stringify(await firstLayoutFrame(ctx), null, 2))
  }
}
