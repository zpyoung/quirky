import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { UiCommandEntry, UiSlotEntry, UiToolEntry, Worktree } from '@quirky/protocol'
import type { Connection } from '../connection'
import { ControlIcon, Dialog, EmptyState, FileIcon, ListRow, SectionHeader, Tabs, TextField, ToolIcon } from '../design-system'
import { useConnection, usePluginHost, usePluginState } from '../context'
import { useAttention } from '../shell/attention'
import { SLOT_LABELS } from '../shell/tool-slot-labels'
import {
  FILE_SEARCH_DEBOUNCE_MS,
  FILE_SEARCH_LIMIT,
  PALETTE_SCOPES,
  cycleScope,
  decodeFileId,
  entryKey,
  rankPaletteEntries,
  fileEntry,
  paletteKey,
  paletteSections,
  quickOpenPaths,
  searchesFiles,
  type PaletteEntry,
  type PaletteScope
} from './palette'

type FileResults = { key: string; entries: PaletteEntry[] }

function matches(entry: PaletteEntry, query: string): boolean {
  return query === '' || `${entry.title} ${entry.description ?? ''} ${entry.id} ${entry.kind}`.toLowerCase().includes(query)
}

function EntryIcon({ entry }: { entry: PaletteEntry }) {
  switch (entry.kind) {
    case 'tool':
      return <ToolIcon name={entry.icon ?? 'squares-four'} hue={entry.hue ?? 'slate'} />
    case 'worktree':
      return <ToolIcon name="git-branch" hue="blue" />
    case 'file':
      return <FileIcon path={entry.description ?? entry.title} />
    case 'command':
      return <ControlIcon name="caret-right" />
    case 'view':
      return <ControlIcon name="squares-four" />
  }
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
      kind: 'tool' as const,
      icon: tool.icon,
      hue: tool.hue
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
  return entries.filter((entry) => matches(entry, query))
}

/** Search effective commands, tools, views, worktrees and, in the selected worktree, files. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const host = usePluginHost()
  const connection = useConnection()
  const { model, windowRoute, layout } = usePluginState()
  const { snapshot } = useAttention()
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<PaletteScope>('all')
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null)
  const [enabledAgentIds, setEnabledAgentIds] = useState<Set<string>>(() => new Set())
  const [fileResults, setFileResults] = useState<FileResults | null>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const sectionId = useId()
  const selectedWorktree = layout.worktree ?? null
  const fileQuery = filter.trim()
  const fileSearchKey = `${selectedWorktree}\n${fileQuery}`
  const fileSearchActive = searchesFiles(scope) && fileQuery !== '' && selectedWorktree !== null
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
  useEffect(() => {
    if (!fileSearchActive || selectedWorktree === null) return
    let requestVersion = 0
    const timer = setTimeout(async () => {
      const version = ++requestVersion
      let found: PaletteEntry[] = []
      try {
        const reply = await connection.callAny('quirky.editor/quickOpen', {
          action: 'search',
          worktree: selectedWorktree,
          query: fileQuery,
          limit: FILE_SEARCH_LIMIT
        })
        found = quickOpenPaths(reply).map((path) => fileEntry(selectedWorktree, path))
      } catch {
        found = []
      }
      if (version === requestVersion) setFileResults({ key: fileSearchKey, entries: found })
    }, FILE_SEARCH_DEBOUNCE_MS)
    return () => {
      requestVersion++
      clearTimeout(timer)
    }
  }, [connection, fileQuery, fileSearchActive, fileSearchKey, selectedWorktree])
  const fileSearchPending = fileSearchActive && fileResults?.key !== fileSearchKey
  const { entries, worktreeIds } = useMemo(() => {
    const projectNames = new Map<string, string>()
    if (!snapshot.errors.repos) {
      for (const repo of snapshot.repos ?? []) projectNames.set(repo.id, repo.displayName ?? repo.name)
    }
    const worktrees = windowRoute || snapshot.errors.worktrees ? [] : snapshot.worktrees ?? []
    const matching = entriesOf(
      model?.commands ?? [],
      model?.tools ?? [],
      model?.views ?? [],
      worktrees,
      projectNames,
      filter.trim().toLowerCase(),
      enabledAgentIds
    )
    const files = fileSearchActive && fileResults?.key === fileSearchKey ? fileResults.entries : []
    return {
      entries: rankPaletteEntries([...matching, ...files], filter.trim().toLowerCase()),
      worktreeIds: new Set(worktrees.map((worktree) => worktree.id))
    }
  }, [enabledAgentIds, fileResults, fileSearchActive, fileSearchKey, filter, model?.commands, model?.tools, model?.views, snapshot.errors.repos, snapshot.errors.worktrees, snapshot.repos, snapshot.worktrees, windowRoute])
  const sections = useMemo(() => paletteSections({
    entries,
    scope,
    query: filter.trim(),
    recents: layout.paletteRecents ?? [],
    worktreeIds
  }), [entries, filter, layout.paletteRecents, scope, worktreeIds])
  const visible = useMemo(() => sections.flatMap((section) => section.entries), [sections])
  const selectedIndex = selectedEntryKey === null ? -1 : visible.findIndex((entry) => entryKey(entry) === selectedEntryKey)
  const current = selectedIndex < 0 ? 0 : selectedIndex
  useEffect(() => {
    if (selectedEntryKey !== null && selectedIndex < 0) setSelectedEntryKey(null)
  }, [selectedEntryKey, selectedIndex])

  const openWorktree = async (worktreeId: string): Promise<boolean> => {
    try {
      const self = await connection.callAny('ui.window.self', {})
      if (typeof self !== 'object' || self === null || !('connId' in self) ||
        typeof self.connId !== 'number' || !Number.isSafeInteger(self.connId) || self.connId < 1) {
        throw new Error('The daemon did not identify this window.')
      }
      await connection.callAny('quirky.worktree/navigate', { worktree: worktreeId, window: self.connId })
      return true
    } catch (error) {
      showCommandError(connection, 'Could not open worktree', error)
      return false
    }
  }

  const openFile = async (id: string) => {
    const file = decodeFileId(id)
    if (file === null) return
    if (file.worktree !== selectedWorktree && !(await openWorktree(file.worktree))) return
    try {
      await connection.callAny('quirky.editor/open', { worktree: file.worktree, path: file.path, focus: true })
    } catch (error) {
      showCommandError(connection, 'Could not open file', error)
      return
    }
    try {
      await connection.callAny('quirky.editor/quickOpen', { worktree: file.worktree, action: 'record', path: file.path })
    } catch {
      // a file that opened but was not recorded only costs its place in quick-open history
    }
  }

  const run = (entry: PaletteEntry) => {
    onClose()
    connection.callAny('ui.palette.recent', { id: entryKey(entry) }).catch(() => {})
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
      case 'file':
        void openFile(entry.id)
        break
    }
  }

  const chooseScope = (next: PaletteScope) => {
    setScope(next)
    setSelectedEntryKey(null)
  }

  if (windowRoute) return null

  const emptyMessage = scope === 'files' && fileQuery === ''
    ? 'Type to search files'
    : scope === 'files' && selectedWorktree === null
      ? 'Select a worktree to search files'
      : fileSearchPending && scope === 'files'
        ? 'Searching files…'
        : 'No results'
  const showEmpty = visible.length === 0 &&
    (scope === 'files' || (snapshot.worktrees !== null && !snapshot.errors.worktrees))

  let position = 0
  return (
    <Dialog open title="Command palette" placement="top" onClose={onClose}>
      <TextField
        ref={fieldRef}
        autoFocus
        label="Search"
        aria-label="Search commands, tools, views, worktrees, and files"
        placeholder="Type to search"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value)
          setSelectedEntryKey(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            event.preventDefault()
            event.stopPropagation()
            chooseScope(cycleScope(scope, event.shiftKey ? -1 : 1))
            return
          }
          const next = paletteKey(event.key, current, visible.length)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault()
          const selectedEntry = visible[next.selected]
          setSelectedEntryKey(selectedEntry ? entryKey(selectedEntry) : null)
          if (next.run && visible[next.selected]) {
            event.preventDefault()
            run(visible[next.selected]!)
          }
        }}
      />
      <Tabs
        label="Search scope"
        items={PALETTE_SCOPES}
        value={scope}
        onChange={(id) => {
          chooseScope(id as PaletteScope)
          fieldRef.current?.focus()
        }}
      />
      {snapshot.errors.worktrees && <p className="ui-error-text" role="status">Worktrees unavailable: {snapshot.errors.worktrees}</p>}
      {snapshot.worktrees === null && !snapshot.errors.worktrees && <p className="ui-text-muted" role="status">Loading worktrees…</p>}
      {showEmpty ? (
        <EmptyState message={emptyMessage} />
      ) : visible.length > 0 ? (
        <div className="ui-option-list" role="listbox" aria-label="Search results">
          {sections.map((section, sectionIndex) => (
            <div key={section.title ?? 'results'} role="group" aria-labelledby={section.title === null ? undefined : `${sectionId}-${sectionIndex}`}>
              {section.title !== null && <SectionHeader id={`${sectionId}-${sectionIndex}`} title={section.title} />}
              {section.entries.map((entry) => {
                const index = position++
                return (
                  <div
                    key={entryKey(entry)}
                    role="option"
                    aria-selected={index === current}
                    onMouseEnter={() => setSelectedEntryKey(entryKey(entry))}
                  >
                    <ListRow
                      title={<span className="ui-cluster"><EntryIcon entry={entry} /><span>{entry.title}</span></span>}
                      description={entry.description}
                      selected={index === current}
                      onClick={() => run(entry)}
                    />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}
