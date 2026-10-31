import type { UiPluginContext } from '@quirky/protocol'
import { DIFF_VIEW_ID, SESSIONS_VIEW_ID, diffViewKey, type DiffViewInput } from '../shared/view-input'
import { setActiveHostedView } from './registry'
import { messageOf } from './data'

type PublicViewTab = {
  kind: 'view'
  id: string
  viewId: string
  key: string
  input?: Record<string, unknown>
  title: string
  pinned: boolean
  preview: boolean
  closeParams?: Record<string, unknown>
}
type PublicGroup = { kind: 'group'; id: string; tabs: unknown[]; activeTab?: string | null }
type PublicWorkspace = { id: string; revision: number; activeGroup: string; root: unknown }
type TabLocation = { tab: PublicViewTab; group: PublicGroup }

const subscribed = new WeakSet<UiPluginContext>()
const DIFF_TAB_ICON = { kind: 'tool', name: 'git-diff', hue: 'azure' } as const

function workspaceFrom(value: unknown): PublicWorkspace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Terminal returned an invalid workspace.')
  const response = value as Record<string, unknown>
  const workspace = response.workspace
  if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) throw new Error('Terminal returned an invalid workspace.')
  const result = workspace as Record<string, unknown>
  if (typeof result.id !== 'string' || !Number.isSafeInteger(result.revision) || typeof result.activeGroup !== 'string' || result.root === undefined) {
    throw new Error('Terminal returned an incomplete workspace.')
  }
  return result as unknown as PublicWorkspace
}

async function readWorkspace(context: UiPluginContext, worktree: string): Promise<PublicWorkspace> {
  return workspaceFrom(await context.call('quirky.terminal/workspace', { workspace: `id:${worktree}` }))
}

function groupsIn(node: unknown): PublicGroup[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return []
  const value = node as Record<string, unknown>
  if (value.kind === 'group' && typeof value.id === 'string' && Array.isArray(value.tabs)) {
    return [value as unknown as PublicGroup]
  }
  if (value.kind !== 'split') return []
  return [...groupsIn(value.first), ...groupsIn(value.second)]
}

function viewTab(value: unknown): PublicViewTab | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const tab = value as Record<string, unknown>
  if (tab.kind !== 'view' || typeof tab.id !== 'string' || typeof tab.viewId !== 'string' ||
    typeof tab.key !== 'string' || typeof tab.title !== 'string' || typeof tab.pinned !== 'boolean' || typeof tab.preview !== 'boolean') return null
  if (tab.input !== undefined && (typeof tab.input !== 'object' || tab.input === null || Array.isArray(tab.input))) return null
  if (tab.closeParams !== undefined && (typeof tab.closeParams !== 'object' || tab.closeParams === null || Array.isArray(tab.closeParams))) return null
  return {
    kind: 'view',
    id: tab.id,
    viewId: tab.viewId,
    key: tab.key,
    ...(tab.input === undefined ? {} : { input: tab.input as Record<string, unknown> }),
    title: tab.title,
    pinned: tab.pinned,
    preview: tab.preview,
    ...(tab.closeParams === undefined ? {} : { closeParams: tab.closeParams as Record<string, unknown> })
  }
}

function tabLocations(workspace: PublicWorkspace): TabLocation[] {
  const result: TabLocation[] = []
  for (const group of groupsIn(workspace.root)) {
    for (const raw of group.tabs) {
      const tab = viewTab(raw)
      if (tab) result.push({ tab, group })
    }
  }
  return result
}


function titleOf(input: DiffViewInput): string {
  const title = input.mode === 'file'
    ? input.path ? `${input.path} (Diff)` : 'Diff'
    : input.mode === 'combined'
      ? input.commit ? `Commit ${input.commit.slice(0, 8)}` : `${input.area ?? 'Changes'} Diff`
      : input.mode === 'conflicts'
        ? 'Conflicts'
        : input.path ?? 'Conflict'
  return title.length <= 200 ? title : `…${title.slice(-199)}`
}

function withHostedIdentity(input: DiffViewInput, fields: { tabId?: string; groupId: string; preview: boolean; split: boolean }): DiffViewInput {
  return {
    ...input,
    groupId: fields.groupId,
    preview: fields.preview,
    split: fields.split,
    ...(fields.tabId === undefined ? {} : { tabId: fields.tabId })
  }
}

function tabById(workspace: PublicWorkspace, id: string): TabLocation | undefined {
  return tabLocations(workspace).find(({ tab }) => tab.id === id)
}

export async function openHostedDiff(context: UiPluginContext, requested: DiffViewInput): Promise<DiffViewInput> {
  const workspace = await readWorkspace(context, requested.worktree)
  const groups = groupsIn(workspace.root)
  const groupId = requested.groupId ?? workspace.activeGroup
  const group = groups.find((candidate) => candidate.id === groupId)
  if (!group) throw new Error(`Terminal group ${groupId} is unavailable.`)

  const key = diffViewKey(requested)
  const sameView = tabLocations(workspace).find(({ tab }) => tab.viewId === DIFF_VIEW_ID && tab.key === key)
  let preview = requested.split === true ? false : requested.preview === true
  let replace: string | undefined
  if (preview) {
    if (sameView) {
      preview = sameView.tab.preview && !sameView.tab.pinned
    } else {
      const candidate = tabLocations(workspace).find(({ tab, group: owner }) =>
        owner.id === groupId && tab.preview && !tab.pinned
      )?.tab
      if (candidate?.closeParams?.dirty === true) preview = false
      else if (candidate) replace = candidate.id
    }
  }

  const split = requested.split === true
  const input = withHostedIdentity(requested, { groupId, preview, split })
  const apiInput = input as unknown as Record<string, unknown>
  const params = {
    workspace: `id:${requested.worktree}`,
    group: groupId,
    viewId: DIFF_VIEW_ID,
    key,
    input: apiInput,
    title: titleOf(input),
    icon: DIFF_TAB_ICON,
    reuse: true,
    activate: true,
    preview,
    closeMethod: 'quirky.git/diffCloseGuard',
    closeParams: { worktree: requested.worktree, dirty: false },
    closeContext: true,
    revision: workspace.revision,
    ...(replace === undefined ? {} : { replace })
  }
  const openedValue = await context.call('quirky.terminal/openViewTab', params)
  if (typeof openedValue !== 'object' || openedValue === null || Array.isArray(openedValue)) throw new Error('Terminal did not open the diff tab.')
  const opened = openedValue as Record<string, unknown>
  if (typeof opened.tab !== 'string') throw new Error('Terminal did not return the diff tab identity.')
  let openedWorkspace = workspaceFrom(opened)

  if (split) {
    const movedValue = await context.call('quirky.terminal/moveTab', {
      tab: opened.tab,
      split: 'right',
      of: groupId,
      revision: openedWorkspace.revision
    })
    openedWorkspace = workspaceFrom(movedValue)
  }
  const owner = tabById(openedWorkspace, opened.tab)
  if (!owner) throw new Error('Terminal did not retain the diff tab in its workspace.')
  const finalInput = withHostedIdentity(input, {
    tabId: opened.tab,
    groupId: owner.group.id,
    preview,
    split
  })
  const finalApiInput = finalInput as unknown as Record<string, unknown>
  await context.call('quirky.terminal/rekeyViewTabs', {
    workspace: `id:${requested.worktree}`,
    viewId: DIFF_VIEW_ID,
    changes: [{ tab: opened.tab, key, input: finalApiInput, title: titleOf(finalInput), preview }],
    revision: openedWorkspace.revision
  })
  setActiveHostedView(opened.tab)
  if (shownWorktree(context) !== requested.worktree) {
    context.openView(SESSIONS_VIEW_ID, { worktree: requested.worktree })
  }
  return finalInput
}

export async function closeHostedDiff(context: UiPluginContext, input: DiffViewInput): Promise<void> {
  if (!input.tabId) {
    context.closeView()
    return
  }
  await context.call('quirky.terminal/closeTab', { tab: input.tabId })
}

export async function updateHostedDiffDirty(context: UiPluginContext, input: DiffViewInput, dirty: boolean): Promise<void> {
  if (!input.tabId) return
  const workspace = await readWorkspace(context, input.worktree)
  const current = tabById(workspace, input.tabId)
  if (!current || current.tab.closeParams?.dirty === dirty) return
  const hostedInput = withHostedIdentity(input, {
    tabId: current.tab.id,
    groupId: current.group.id,
    preview: current.tab.preview,
    split: input.split === true
  })
  const apiInput = hostedInput as unknown as Record<string, unknown>
  await context.call('quirky.terminal/openViewTab', {
    workspace: `id:${input.worktree}`,
    group: current.group.id,
    viewId: DIFF_VIEW_ID,
    key: current.tab.key,
    input: apiInput,
    title: current.tab.title,
    icon: DIFF_TAB_ICON,
    reuse: true,
    activate: false,
    preview: current.tab.preview,
    closeMethod: 'quirky.git/diffCloseGuard',
    closeParams: { worktree: input.worktree, dirty },
    closeContext: true
  })
}

async function promotePinnedPreviews(context: UiPluginContext, worktree: string): Promise<void> {
  const workspace = await readWorkspace(context, worktree)
  const changes: Array<{ tab: string; key: string; input: Record<string, unknown>; title: string; preview: false }> = []
  for (const { tab, group } of tabLocations(workspace)) {
    if (tab.viewId !== DIFF_VIEW_ID || !tab.preview || !tab.pinned || !tab.input || typeof tab.input.worktree !== 'string') continue
    const input = tab.input as unknown as DiffViewInput
    const permanent = withHostedIdentity(input, {
      tabId: tab.id,
      groupId: group.id,
      preview: false,
      split: input.split === true
    })
    const apiInput = permanent as unknown as Record<string, unknown>
    changes.push({ tab: tab.id, key: tab.key, input: apiInput, title: tab.title, preview: false })
  }
  if (changes.length === 0) return
  await context.call('quirky.terminal/rekeyViewTabs', {
    workspace: `id:${worktree}`,
    viewId: DIFF_VIEW_ID,
    changes,
    revision: workspace.revision
  })
}

function shownWorktree(context: UiPluginContext): string | null {
  const shown = context.getLayout().view
  const input = shown?.input
  if (shown?.id !== SESSIONS_VIEW_ID || typeof input !== 'object' || input === null || !('worktree' in input)) return null
  return typeof input.worktree === 'string' ? input.worktree : null
}

async function refreshActiveHostedView(context: UiPluginContext): Promise<void> {
  try {
    const focusValue = await context.call('quirky.terminal/focusContext')
    if (typeof focusValue !== 'object' || focusValue === null || Array.isArray(focusValue)) {
      setActiveHostedView(null)
      return
    }
    const focus = focusValue as Record<string, unknown>
    // focus is only reported once a terminal takes it, and a diff can be the first thing opened
    const worktree = typeof focus.workspace === 'string' && focus.workspace !== '' ? focus.workspace : shownWorktree(context)
    if (worktree === null) {
      setActiveHostedView(null)
      return
    }
    const workspace = await readWorkspace(context, worktree)
    const group = groupsIn(workspace.root).find((candidate) => candidate.id === workspace.activeGroup)
    const activeTab = typeof group?.activeTab === 'string' ? tabById(workspace, group.activeTab) : undefined
    setActiveHostedView(activeTab?.tab.viewId === DIFF_VIEW_ID ? activeTab.tab.id : null)
  } catch {
    setActiveHostedView(null)
  }
}

export function subscribeHostedLayouts(context: UiPluginContext): void {
  if (subscribed.has(context)) return
  subscribed.add(context)
  context.subscribe((event) => {
    if (event.type === 'quirky.terminal/focusContextChanged') {
      void refreshActiveHostedView(context)
      return
    }
    if (event.type !== 'quirky.terminal/layout' || !('data' in event)) return
    const data = event.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return
    const payload = data as Record<string, unknown>
    const worktree = payload.workspace
    if (typeof worktree !== 'string' || worktree === '') return
    void promotePinnedPreviews(context, worktree).catch((error: unknown) => {
      context.toast('Could not make the diff tab permanent', messageOf(error))
    })
    void refreshActiveHostedView(context)
  })
}
