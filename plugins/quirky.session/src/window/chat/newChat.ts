import type { Session, UiPluginContext } from '@quirky/protocol'

/** The open "New chat" dialog: where the chat goes and how far starting it got. */
export type NewChatDialogState = {
  id: number
  workspace: string
  group: string | null
  /** Set once the session exists, so a retry adopts it instead of creating another. */
  created: Session | null
  error: string | null
}

type Listener = () => void

let current: NewChatDialogState | null = null
let sequence = 0
const listeners = new Set<Listener>()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function publish(next: NewChatDialogState | null): void {
  current = next
  for (const listener of [...listeners]) listener()
}

/** The open dialog, or null. */
export const getNewChatDialog = (): NewChatDialogState | null => current

/** Calls `listener` whenever the dialog opens, changes or closes. */
export function subscribeNewChatDialog(listener: Listener): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Closes the dialog if it is still the one `id` names. */
export function closeNewChatDialog(id: number): void {
  if (current?.id === id) publish(null)
}

/** Drops the dialog without notifying, for when its overlay is torn down. */
export function resetNewChatDialog(): void {
  current = null
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Resolves the workspace of a group, or of an explicit workspace, falling back to the focused one. */
async function resolveWorkspace(
  context: UiPluginContext,
  workspaceValue: unknown,
  groupValue: unknown
): Promise<{ workspace: string; group: string | null }> {
  let workspace = optionalText(workspaceValue, 'workspace')
  const group = optionalText(groupValue, 'group')
  if (group !== undefined) {
    const result = await context.call('quirky.terminal/groupInfo', { group })
    if (!isRecord(result) || typeof result.workspace !== 'string' || result.workspace === '') {
      throw new Error('terminal returned an invalid group owner')
    }
    if (workspace !== undefined && workspace !== result.workspace) throw new Error(`group ${group} is not in workspace ${workspace}`)
    workspace = result.workspace
  }
  if (workspace === undefined) {
    const focus = await context.call('quirky.terminal/focusContext', {})
    if (isRecord(focus) && typeof focus.workspace === 'string' && focus.workspace !== '') workspace = focus.workspace
  }
  if (workspace === undefined) throw new Error('workspace or group is required')
  return { workspace, group: group ?? null }
}

/**
 * The `new-chat` command: opens the "New chat" dialog for the workspace of `group` (or `workspace`,
 * or the focused one). Rejects unknown arguments and an unresolvable workspace without opening anything.
 */
export async function newChatCommand(context: UiPluginContext, raw: unknown): Promise<{ opened: true; workspace: string; group?: string }> {
  const args = raw === undefined ? {} : raw
  if (!isRecord(args)) throw new Error('new-chat arguments must be an object')
  for (const key of Object.keys(args)) {
    if (key !== 'workspace' && key !== 'group' && key !== 'worktree') throw new Error(`new-chat takes no ${key} argument`)
  }
  void optionalText(args.worktree, 'worktree')
  const target = await resolveWorkspace(context, args.workspace, args.group)
  publish({ id: ++sequence, workspace: target.workspace, group: target.group, created: null, error: null })
  return { opened: true, workspace: target.workspace, ...(target.group === null ? {} : { group: target.group }) }
}

/** Records that the session exists and clears any earlier error. */
export function noteChatCreated(id: number, session: Session): void {
  if (current?.id === id) publish({ ...current, created: session, error: null })
}

/** Shows `message` in the dialog. */
export function failNewChat(id: number, message: string): void {
  if (current?.id === id) publish({ ...current, error: message })
}

/**
 * Places the created session in the dialog's group (the workspace's active group when none was
 * given) so it opens as the active tab, then closes the dialog. A failure stays in the dialog.
 */
export async function adoptNewChat(context: UiPluginContext, dialog: NewChatDialogState, session: Session): Promise<void> {
  try {
    let group = dialog.group
    if (group === null) {
      const result = await context.call('quirky.terminal/workspace', { workspace: dialog.workspace })
      const active = isRecord(result) && isRecord(result.workspace) ? result.workspace.activeGroup : undefined
      if (typeof active !== 'string' || active === '') throw new Error('the workspace has no active group')
      group = active
    }
    await context.call('quirky.terminal/adoptSession', { group, session: session.id })
    closeNewChatDialog(dialog.id)
  } catch (error) {
    failNewChat(dialog.id, `Chat ${session.id} was created, but its tab could not be opened: ${messageOf(error)}`)
  }
}
