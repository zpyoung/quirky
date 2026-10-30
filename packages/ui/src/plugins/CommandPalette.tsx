import { useEffect, useMemo, useState } from 'react'
import type { UiCommandEntry, UiSlotEntry, UiToolEntry, Worktree } from '@quirky/protocol'
import type { Connection } from '../connection'
import { Dialog, EmptyState, ListRow, TextField } from '../design-system'
import { useConnection, usePluginHost, usePluginState } from '../context'
import { useAttention } from '../shell/attention'
import { SLOT_LABELS } from '../shell/tool-slot-labels'
import { paletteKey } from './palette'

type PaletteEntry = {
  id: string
  title: string
  description?: string
  kind: 'command' | 'tool' | 'view' | 'worktree'
}

function matches(entry: PaletteEntry, query: string): boolean {
  return query === '' || `${entry.title} ${entry.description ?? ''} ${entry.id} ${entry.kind}`.toLowerCase().includes(query)
}
function entryKey(entry: PaletteEntry): string {
  return `${entry.kind}:${entry.id}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function showCommandError(connection: Connection, title: string, error: unknown): void {
  const body = errorMessage(error)
  connection.store.dispatch({ type: 'toast', toast: { kind: 'error', title: `${title}: ${body}`, body } })
}

const AGENT_COMMAND_PREFIX = 'command:quirky.agents/new-'
const GENERIC_AGENT_COMMAND = `${AGENT_COMMAND_PREFIX}agent-tab`

function agentIdForLaunchCommand(commandId: string): string | null {
  if (commandId === GENERIC_AGENT_COMMAND) return null
  if (!commandId.startsWith(AGENT_COMMAND_PREFIX) || !commandId.endsWith('-tab')) return null
  return commandId.slice(AGENT_COMMAND_PREFIX.length, -'-tab'.length)
}

function installedEnabledAgentIds(value: unknown): Set<string> {
  if (typeof value !== 'object' || value === null || !('agents' in value) || !Array.isArray(value.agents)) {
    return new Set()
  }
  const ids = new Set<string>()
  const agents: unknown[] = value.agents
  for (const candidate of agents) {
    if (
      typeof candidate !== 'object' || candidate === null ||
      !('id' in candidate) || typeof candidate.id !== 'string' ||
      !('installed' in candidate) || candidate.installed !== true ||
      !('enabled' in candidate) || candidate.enabled !== true
    ) continue
    ids.add(candidate.id)
  }
  return ids
}

function entriesOf(
  commands: UiCommandEntry[],
  tools: UiToolEntry[],
  views: UiSlotEntry[],
  worktrees: Worktree[],
  projectNames: Map<string, string>,
  query: string,
  enabledAgentIds: Set<string>
): PaletteEntry[] {
  const entries: PaletteEntry[] = [
    ...commands.filter((command) => {
      if (command.palette === false) return false
      const agentId = agentIdForLaunchCommand(command.id)
      return agentId === null || enabledAgentIds.has(agentId)
    }).map((command) => ({
      id: command.id,
      title: command.title,
      description: command.description,
      kind: 'command' as const
    })),
    ...tools.map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: `Tool · ${SLOT_LABELS[tool.defaultSlot]}`,
      kind: 'tool' as const
    })),
    ...views.map((view) => ({
      id: view.id,
      title: view.title,
      description: 'View',
      kind: 'view' as const
    })),
    ...worktrees.map((worktree) => ({
      id: worktree.id,
      title: worktree.name,
      description: [
        projectNames.get(worktree.repoId),
        worktree.branch ?? undefined,
        'Worktree'
      ].filter(Boolean).join(' · '),
      kind: 'worktree' as const
    }))
  ]
  const matching = entries.filter((entry) => matches(entry, query))
  if (query === '') return matching

  const exactTitleMatches: PaletteEntry[] = []
  const otherMatches: PaletteEntry[] = []
  for (const entry of matching) {
    if (entry.title.trim().toLowerCase() === query) exactTitleMatches.push(entry)
    else otherMatches.push(entry)
  }
  return exactTitleMatches.concat(otherMatches)
}

/** Search effective commands, tools, views and canonical worktree snapshots. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const host = usePluginHost()
  const connection = useConnection()
  const { model, windowRoute } = usePluginState()
  const { snapshot } = useAttention()
  const [filter, setFilter] = useState('')
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null)
  const [enabledAgentIds, setEnabledAgentIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    let mounted = true
    let requestVersion = 0
    const refreshAgents = async () => {
      const version = ++requestVersion
      try {
        const listing = await connection.callAny('quirky.agents/list', {})
        if (!mounted || version !== requestVersion) return
        setEnabledAgentIds(installedEnabledAgentIds(listing))
      } catch {
        if (mounted && version === requestVersion) setEnabledAgentIds(new Set())
      }
    }
    const unsubscribe = connection.onEvent((event) => {
      if (event.type === 'quirky.agents/changed') void refreshAgents()
    })
    const unsubscribeConnected = connection.onConnected(() => void refreshAgents())
    void refreshAgents()
    return () => {
      mounted = false
      requestVersion++
      unsubscribe()
      unsubscribeConnected()
    }
  }, [connection])
  const entries = useMemo(() => {
    const projectNames = new Map<string, string>()
    if (!snapshot.errors.repos) {
      for (const repo of snapshot.repos ?? []) projectNames.set(repo.id, repo.displayName ?? repo.name)
    }
    return entriesOf(
      model?.commands ?? [],
      model?.tools ?? [],
      model?.views ?? [],
      windowRoute || snapshot.errors.worktrees ? [] : snapshot.worktrees ?? [],
      projectNames,
      filter.trim().toLowerCase(),
      enabledAgentIds
    )
  }, [enabledAgentIds, filter, model?.commands, model?.tools, model?.views, snapshot.errors.repos, snapshot.errors.worktrees, snapshot.repos, snapshot.worktrees, windowRoute])
  const selectedIndex = selectedEntryKey === null ? -1 : entries.findIndex((entry) => entryKey(entry) === selectedEntryKey)
  const current = selectedIndex < 0 ? 0 : selectedIndex
  useEffect(() => {
    if (selectedEntryKey !== null && selectedIndex < 0) setSelectedEntryKey(null)
  }, [selectedEntryKey, selectedIndex])

  const openWorktree = async (worktreeId: string) => {
    try {
      const self = await connection.callAny('ui.window.self', {})
      if (typeof self !== 'object' || self === null || !('connId' in self) ||
        typeof self.connId !== 'number' || !Number.isSafeInteger(self.connId) || self.connId < 1) {
        throw new Error('The daemon did not identify this window.')
      }
      await connection.callAny('quirky.worktree/navigate', { worktree: worktreeId, window: self.connId })
    } catch (error) {
      showCommandError(connection, 'Could not open worktree', error)
    }
  }

  const run = (entry: PaletteEntry) => {
    onClose()
    switch (entry.kind) {
      case 'command':
        void host.runCommand(entry.id).catch((error) => showCommandError(connection, 'Command failed', error))
        break
      case 'tool':
        host.openTool(entry.id)
        break
      case 'view':
        host.openView(entry.id)
        break
      case 'worktree':
        void openWorktree(entry.id)
        break
    }
  }

  if (windowRoute) return null

  return (
    <Dialog open title="Command palette" placement="top" onClose={onClose}>
      <TextField
        label="Search"
        aria-label="Search commands, tools, views, and worktrees"
        placeholder="Type to search"
        autoFocus
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value)
          setSelectedEntryKey(null)
        }}
        onKeyDown={(event) => {
          const next = paletteKey(event.key, current, entries.length)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault()
          const selectedEntry = entries[next.selected]
          setSelectedEntryKey(selectedEntry ? entryKey(selectedEntry) : null)
          if (next.run && entries[next.selected]) {
            event.preventDefault()
            run(entries[next.selected]!)
          }
        }}
      />
      {snapshot.errors.worktrees && <p className="ui-error-text" role="status">Worktrees unavailable: {snapshot.errors.worktrees}</p>}
      {snapshot.worktrees === null && !snapshot.errors.worktrees && <p className="ui-text-muted" role="status">Loading worktrees…</p>}
      {entries.length === 0 && snapshot.worktrees !== null && !snapshot.errors.worktrees ? (
        <EmptyState message="No matching contributions." />
      ) : entries.length > 0 ? (
        <div className="ui-option-list" role="listbox" aria-label="Search results">
          {entries.map((entry, index) => (
            <div
              key={entryKey(entry)}
              role="option"
              aria-selected={index === current}
              onMouseEnter={() => setSelectedEntryKey(entryKey(entry))}
            >
              <ListRow
                title={entry.title}
                description={entry.description}
                selected={index === current}
                onClick={() => run(entry)}
              />
            </div>
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}
