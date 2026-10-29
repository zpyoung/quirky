import type { Session, UiPluginContext } from '@quirky/protocol'
import { HISTORY_AGENTS } from './agents'
import type { PublicListResult, ViewState } from './types'
import { mountHistoryPanel } from './window/HistoryPanel'
import { HISTORY_PANEL_ID, SETTINGS_SECTION_ID, SETTINGS_VIEW_ID } from './window/model'
import { mountSearchSettings, mountSearchSettingsView } from './window/SearchSettings'

type MountProps = { input?: unknown; report?(state: unknown): void }

type CommandArgs = Record<string, unknown>

function asRecord(value: unknown): CommandArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as CommandArgs : {}
}

function inputString(value: unknown, max = 2048): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

async function openHistory(context: UiPluginContext, value?: unknown): Promise<void> {
  const args = asRecord(value)
  const agent = inputString(args.agent, 80)
  const sessionId = inputString(args.sessionId, 2048) ?? inputString(args.session, 2048)
  const query = inputString(args.query, 512)
  const patch: Partial<ViewState> = { focusedSearch: true }
  if (agent !== null) {
    const supported = HISTORY_AGENTS.includes(agent as typeof HISTORY_AGENTS[number])
    patch.disabledAgents = supported ? HISTORY_AGENTS.filter((candidate) => candidate !== agent) : [...HISTORY_AGENTS]
  }
  if (sessionId !== null) {
    if (agent === null) patch.query = sessionId
    try {
      const rows = await context.call('quirky.vault/list', {
        host: typeof args.host === 'string' ? args.host : 'local',
        agents: agent === null ? undefined : HISTORY_AGENTS.includes(agent as typeof HISTORY_AGENTS[number]) ? [agent] : [],
        unlimited: true
      }) as PublicListResult
      const matching = rows.sessions.find((row) => row.sessionId === sessionId && (agent === null || row.agent === agent))
      if (matching) {
        patch.selectedId = matching.id
        patch.expandedIds = [matching.id]
        patch.query = query ?? ''
      } else {
        patch.query = query ?? sessionId
      }
    } catch {
      patch.query = query ?? sessionId
    }
  }
  await context.call('quirky.vault/setView', patch as Record<string, unknown>)
  context.togglePanel(HISTORY_PANEL_ID, true)
}

async function resumeCommand(context: UiPluginContext, value?: unknown): Promise<unknown> {
  const args = asRecord(value)
  const id = inputString(args.id)
  if (id === null) throw new Error('A valid host-qualified vault session ID is required to resume.')
  const group = inputString(args.group, 256)
  const worktree = inputString(args.worktree, 256)
  if ((group === null) !== (worktree === null)) throw new Error('A drop target must identify both its group and worktree.')
  if (args.remote !== undefined) {
    const remote = asRecord(args.remote)
    const owner = asRecord(remote.owner)
    const hostId = inputString(owner.hostId, 256)
    const mirrorId = inputString(remote.mirrorId, 256)
    const targetWorktree = inputString(remote.worktreeId, 256)
    if (hostId === null || mirrorId === null || targetWorktree === null) {
      throw new Error('A remote resume target must identify its registered owner workspace.')
    }
    if (group !== null || worktree !== null) throw new Error('A remote resume target cannot be combined with a local group or worktree.')
    const result = await context.call('quirky.vault/resume', { id, remote })
    const session = asRecord(result)
    if (session.hostId !== hostId || typeof session.id !== 'string' || session.worktreeId !== targetWorktree) {
      throw new Error('The vault did not resume the source on the selected owner workspace.')
    }
    context.openView('view:quirky.worktree/remote', { workspace: mirrorId })
    return result
  }
  const result = await context.call('quirky.vault/resume', {
    id,
    ...(group === null ? {} : { group, worktree })
  })
  const session = asRecord(result)
  if (typeof session.id !== 'string' || typeof session.worktreeId !== 'string') throw new Error('The vault did not launch the requested source session.')
  if (worktree !== null && session.worktreeId !== worktree) throw new Error('The vault launched the session in a different worktree than requested.')
  const launched = result as Session
  context.openView('view:quirky.session/worktree', { worktree: launched.worktreeId, session: launched.id })
  return result
}

export function activate(context: UiPluginContext): void {
  context.provide(HISTORY_PANEL_ID, (element: HTMLElement, props: MountProps) => mountHistoryPanel(context, element, props))
  context.provide(SETTINGS_SECTION_ID, (element: HTMLElement, props: MountProps) => mountSearchSettings(context, element, props))
  context.provide(SETTINGS_VIEW_ID, (element: HTMLElement, props: MountProps) => mountSearchSettingsView(context, element, props))
  context.provide('command:quirky.vault/open', (args?: unknown) => openHistory(context, args))
  context.provide('command:quirky.vault/settings', () => context.openView(SETTINGS_VIEW_ID))
  context.provide('command:quirky.vault/resume', (args?: unknown) => resumeCommand(context, args))
}
