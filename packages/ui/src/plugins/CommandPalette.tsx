import { useMemo, useState } from 'react'
import type { UiCommandEntry, UiSlotEntry, UiToolEntry, Worktree } from '@quirky/protocol'
import type { Connection } from '../connection'
import { Dialog, ListRow, TextField } from '../design-system'
import { useConnection, usePluginHost, usePluginState } from '../context'
import { useAttention } from '../shell/attention'
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function showCommandError(connection: Connection, title: string, error: unknown): void {
  const body = errorMessage(error)
  connection.store.dispatch({ type: 'toast', toast: { kind: 'error', title: `${title}: ${body}`, body } })
}

function entriesOf(
  commands: UiCommandEntry[],
  tools: UiToolEntry[],
  views: UiSlotEntry[],
  worktrees: Worktree[],
  projectNames: Map<string, string>,
  query: string
): PaletteEntry[] {
  const entries: PaletteEntry[] = [
    ...commands.map((command) => ({
      id: command.id,
      title: command.title,
      description: command.description,
      kind: 'command' as const
    })),
    ...tools.map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: `Tool · ${tool.defaultSlot}`,
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
  return entries.filter((entry) => matches(entry, query))
}

/** Search effective commands, tools, views and canonical worktree snapshots. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const host = usePluginHost()
  const connection = useConnection()
  const { model, windowRoute } = usePluginState()
  const { snapshot } = useAttention()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
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
      filter.trim().toLowerCase()
    )
  }, [filter, model?.commands, model?.tools, model?.views, snapshot.errors.repos, snapshot.errors.worktrees, snapshot.repos, snapshot.worktrees, windowRoute])
  const current = Math.min(selected, Math.max(entries.length - 1, 0))

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
    <Dialog open title="Command palette" onClose={onClose}>
      <TextField
        label="Search"
        aria-label="Search commands, tools, views, and worktrees"
        placeholder="Type to search"
        autoFocus
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value)
          setSelected(0)
        }}
        onKeyDown={(event) => {
          const next = paletteKey(event.key, current, entries.length)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault()
          setSelected(next.selected)
          if (next.run && entries[next.selected]) {
            event.preventDefault()
            run(entries[next.selected]!)
          }
        }}
      />
      {snapshot.errors.worktrees && <p className="ui-error-text" role="status">Worktrees unavailable: {snapshot.errors.worktrees}</p>}
      {snapshot.worktrees === null && !snapshot.errors.worktrees && <p className="muted pad">Loading worktrees…</p>}
      {entries.length === 0 && snapshot.worktrees !== null && !snapshot.errors.worktrees ? (
        <p className="muted pad">No matching contributions.</p>
      ) : entries.length > 0 ? (
        <ul className="shell-palette-list" role="listbox" aria-label="Search results">
          {entries.map((entry, index) => (
            <li
              key={`${entry.kind}:${entry.id}`}
              role="option"
              aria-selected={index === current}
              onMouseEnter={() => setSelected(index)}
            >
              <ListRow
                title={entry.title}
                description={entry.description}
                selected={index === current}
                onClick={() => run(entry)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  )
}
