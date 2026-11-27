import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime/types'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'
import { publicCallOptions } from './ui-actions'

export const TAB_TYPES = ['all', 'terminal', 'editor', 'markdown', 'chat', 'browser'] as const

export type TabTypeFilter = (typeof TAB_TYPES)[number]

type TabType = Exclude<TabTypeFilter, 'all'>

type TabRow = {
  id: string
  type: TabType
  title: string
  active: boolean
  pinned: boolean
  worktree: string
  groupId: string | null
}

type SessionTabsListAllResult = { snapshots: RuntimeMobileSessionTabsResult[] }

const TAB_TYPE_BY_RUNTIME_TYPE: Record<RuntimeMobileSessionClientTab['type'], TabType> = {
  terminal: 'terminal',
  markdown: 'markdown',
  file: 'editor',
  browser: 'browser',
  'agent-session': 'chat'
}

/** `undefined` when `--type` is absent, so a caller can tell "unset" from "all". */
export function readTabTypeFlag(flags: Map<string, string | boolean>): TabTypeFilter | undefined {
  const value = getOptionalStringFlag(flags, 'type')
  if (value === undefined) {
    return undefined
  }
  const type = TAB_TYPES.find((candidate) => candidate === value)
  if (!type) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--type must be one of: ${TAB_TYPES.join(', ')}`
    )
  }
  return type
}

function usesAllTypesRoute(flags: Map<string, string | boolean>): boolean {
  const type = readTabTypeFlag(flags)
  return type !== undefined && type !== 'browser'
}

function rowsOf(snapshot: RuntimeMobileSessionTabsResult): TabRow[] {
  const groupOf = new Map<string, string>()
  for (const group of snapshot.tabGroups ?? []) {
    for (const tabId of group.tabOrder) {
      groupOf.set(tabId, group.id)
    }
  }
  return snapshot.tabs.map((tab) => ({
    id: tab.id,
    type: TAB_TYPE_BY_RUNTIME_TYPE[tab.type],
    title: tab.title,
    active: tab.isActive,
    pinned: tab.isPinned === true,
    worktree: snapshot.worktree,
    groupId: groupOf.get(tab.id) ?? null
  }))
}

function matchesType(row: TabRow, type: TabTypeFilter): boolean {
  return type === 'all' || row.type === type
}

function formatRow(row: TabRow): string {
  const marker = row.active ? '* ' : '  '
  const pin = row.pinned ? ' [pinned]' : ''
  return `${marker}[${row.type}] ${row.id}  ${row.title}${pin}  (${row.worktree})`
}

function formatRows(result: { tabs: TabRow[] }): string {
  return result.tabs.length === 0 ? 'No tabs open.' : result.tabs.map(formatRow).join('\n')
}

async function explicitWorktree(ctx: HandlerContext): Promise<string | undefined> {
  if (getOptionalStringFlag(ctx.flags, 'worktree') === 'all') {
    return undefined
  }
  return await getOptionalWorktreeSelector(ctx.flags, 'worktree', ctx.cwd, ctx.client)
}

async function listRows(
  ctx: HandlerContext,
  worktree: string | undefined
): Promise<{ rows: TabRow[]; response: RuntimeRpcSuccess<unknown> }> {
  if (worktree) {
    const response = await ctx.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree
    })
    return { rows: rowsOf(response.result), response }
  }
  const response = await ctx.client.call<SessionTabsListAllResult>(
    'session.tabs.listAll',
    undefined,
    publicCallOptions()
  )
  return { rows: response.result.snapshots.flatMap(rowsOf), response }
}

/** A worktree selector for a command that has no workspace-wide listing: explicit, else the cwd's workspace. */
async function requireWorktree(ctx: HandlerContext): Promise<string> {
  const explicit = await explicitWorktree(ctx)
  if (explicit) {
    return explicit
  }
  if (ctx.client.isRemote) {
    throw new RuntimeClientError('invalid_argument', 'Remote tab commands require --worktree.')
  }
  return await resolveCurrentWorktreeSelector(ctx.cwd, ctx.client)
}

async function findTab(
  ctx: HandlerContext,
  tabId: string,
  type: TabTypeFilter
): Promise<{ row: TabRow; response: RuntimeRpcSuccess<unknown>; explicit: string | undefined }> {
  const explicit = await explicitWorktree(ctx)
  const { rows, response } = await listRows(ctx, explicit)
  const found = rows.filter((row) => row.id === tabId && matchesType(row, type))
  if (found.length === 0) {
    throw new RuntimeClientError(
      'not_found',
      `No ${type === 'all' ? '' : `${type} `}tab with id ${tabId}.`,
      { next: [{ command: 'quirky tab list --type all', why: 'list every open tab' }] }
    )
  }
  if (found.length > 1 && !explicit) {
    throw new RuntimeClientError(
      'conflict',
      `Tab id ${tabId} is open in more than one workspace; pass --worktree.`
    )
  }
  return { row: found[0], response, explicit }
}

/**
 * The workspace that holds tab `tabId`. An explicit `--worktree` skips the lookup unless a type must
 * be checked, because the id alone does not say which type the tab is.
 */
async function resolveWorktreeOfTab(
  ctx: HandlerContext,
  tabId: string,
  type: TabTypeFilter
): Promise<string> {
  const explicit = await explicitWorktree(ctx)
  if (explicit && type === 'all') {
    return explicit
  }
  const found = await findTab(ctx, tabId, type)
  return found.explicit ?? found.row.worktree
}

/** The tab a `--page <id>` or `--index <n>` flag names; an index counts the matching tabs of one workspace. */
async function resolveTabFromFlags(
  ctx: HandlerContext,
  type: TabTypeFilter
): Promise<{ worktree: string; tabId: string }> {
  const page = getOptionalStringFlag(ctx.flags, 'page')
  const index = getOptionalNonNegativeIntegerFlag(ctx.flags, 'index')
  if (page) {
    return { worktree: await resolveWorktreeOfTab(ctx, page, type), tabId: page }
  }
  if (index === undefined) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --index or --page')
  }
  const worktree = await requireWorktree(ctx)
  const { rows } = await listRows(ctx, worktree)
  const row = rows.filter((candidate) => matchesType(candidate, type))[index]
  if (!row) {
    throw new RuntimeClientError('not_found', `No tab at index ${index}.`)
  }
  return { worktree, tabId: row.id }
}

async function listTabs(ctx: HandlerContext): Promise<void> {
  const type = readTabTypeFlag(ctx.flags) ?? 'all'
  const { rows, response } = await listRows(ctx, await explicitWorktree(ctx))
  printResult(
    { ...response, result: { tabs: rows.filter((row) => matchesType(row, type)) } },
    ctx.json,
    formatRows
  )
}

async function showTab(ctx: HandlerContext): Promise<void> {
  const type = readTabTypeFlag(ctx.flags) ?? 'all'
  const page = getRequiredStringFlag(ctx.flags, 'page')
  const { row, response } = await findTab(ctx, page, type)
  printResult({ ...response, result: { tab: row } }, ctx.json, (result) => formatRow(result.tab))
}

async function currentTab(ctx: HandlerContext): Promise<void> {
  const type = readTabTypeFlag(ctx.flags) ?? 'all'
  const worktree = await requireWorktree(ctx)
  const { rows, response } = await listRows(ctx, worktree)
  const row = rows.find((candidate) => candidate.active)
  if (!row || !matchesType(row, type)) {
    throw new RuntimeClientError(
      'not_found',
      row ? `The active tab is a ${row.type} tab, not ${type}.` : 'No active tab.'
    )
  }
  printResult({ ...response, result: { tab: row } }, ctx.json, (result) => formatRow(result.tab))
}

async function activateTab(
  ctx: HandlerContext,
  target: { worktree: string; tabId: string }
): Promise<void> {
  const response = await ctx.client.call<unknown>(
    'session.tabs.activate',
    { worktree: target.worktree, tabId: target.tabId },
    publicCallOptions()
  )
  printResult(response, ctx.json, () => `Focused tab ${target.tabId}`)
}

async function switchTab(ctx: HandlerContext): Promise<void> {
  const type = readTabTypeFlag(ctx.flags) ?? 'all'
  await activateTab(ctx, await resolveTabFromFlags(ctx, type))
}

async function createTab(ctx: HandlerContext): Promise<void> {
  const type = readTabTypeFlag(ctx.flags)
  throw new RuntimeClientError(
    'invalid_argument',
    `tab create does not create ${type} tabs; it opens browser tabs only.`,
    {
      next: [
        { command: 'quirky terminal create', why: 'open a terminal tab' },
        { command: 'quirky file open <path>', why: 'open a file in an editor tab' }
      ]
    }
  )
}

async function closeTab(ctx: HandlerContext): Promise<void> {
  const type = readTabTypeFlag(ctx.flags) ?? 'all'
  const target = await resolveTabFromFlags(ctx, type)
  const response = await ctx.client.call<unknown>(
    'session.tabs.close',
    { worktree: target.worktree, tabId: target.tabId, reason: 'user' },
    publicCallOptions()
  )
  printResult(response, ctx.json, () => `Closed tab ${target.tabId}`)
}

async function focusTab(ctx: HandlerContext): Promise<void> {
  const tabId = getRequiredStringFlag(ctx.flags, 'id')
  const type = readTabTypeFlag(ctx.flags) ?? 'all'
  const worktree = await resolveWorktreeOfTab(ctx, tabId, type)
  await activateTab(ctx, { worktree, tabId })
}

async function moveTab(ctx: HandlerContext): Promise<void> {
  const tabId = getRequiredStringFlag(ctx.flags, 'id')
  const targetGroupId = getRequiredStringFlag(ctx.flags, 'to-group')
  const index = getOptionalNonNegativeIntegerFlag(ctx.flags, 'index')
  const worktree = await resolveWorktreeOfTab(ctx, tabId, readTabTypeFlag(ctx.flags) ?? 'all')
  const response = await ctx.client.call<unknown>(
    'session.tabs.move',
    {
      worktree,
      tabId,
      targetGroupId,
      kind: 'move-to-group',
      ...(index === undefined ? {} : { index })
    },
    publicCallOptions()
  )
  printResult(response, ctx.json, () => `Moved tab ${tabId} to group ${targetGroupId}`)
}

function setPinned(isPinned: boolean): CommandHandler {
  return async (ctx) => {
    const tabId = getRequiredStringFlag(ctx.flags, 'id')
    const worktree = await resolveWorktreeOfTab(ctx, tabId, readTabTypeFlag(ctx.flags) ?? 'all')
    const response = await ctx.client.call<unknown>(
      'session.tabs.setTabProps',
      { worktree, tabId, isPinned },
      publicCallOptions()
    )
    printResult(response, ctx.json, () => `${isPinned ? 'Pinned' : 'Unpinned'} tab ${tabId}`)
  }
}

export const TAB_ALL_TYPES_HANDLERS: Record<string, CommandHandler> = {
  'tab focus': focusTab,
  'tab move': moveTab,
  'tab pin': setPinned(true),
  'tab unpin': setPinned(false)
}

const NON_BROWSER_TAB_ROUTES: Record<string, CommandHandler> = {
  'tab list': listTabs,
  'tab show': showTab,
  'tab current': currentTab,
  'tab switch': switchTab,
  'tab create': createTab,
  'tab close': closeTab
}

/**
 * Wraps the browser tab handlers so a non-browser `--type` is served from the session tab list. With
 * `--type` absent or `browser`, the browser handler runs untouched.
 */
export function withNonBrowserTabTypes(
  browserHandlers: Record<string, CommandHandler>
): Record<string, CommandHandler> {
  const routed = { ...browserHandlers }
  for (const [key, browser] of Object.entries(browserHandlers)) {
    const nonBrowser = NON_BROWSER_TAB_ROUTES[key]
    if (nonBrowser) {
      routed[key] = async (ctx) => {
        await (usesAllTypesRoute(ctx.flags) ? nonBrowser(ctx) : browser(ctx))
      }
    }
  }
  return routed
}
