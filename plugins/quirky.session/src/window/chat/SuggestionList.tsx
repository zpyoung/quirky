import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentCommand, UiPluginContext } from '@quirky/protocol'
import { EmptyState, FileIcon, InlineError, ListRow, SectionHeader } from '@quirky/ui'
import { QUIRKY_COMMANDS, type QuirkyCommandName } from './commands'

/** One pickable row of the list; `source` says what picking it does. */
export type Suggestion =
  | { id: string; group: string; label: string; detail?: string; tag?: string; source: 'file'; path: string }
  | { id: string; group: string; label: string; detail?: string; tag: string; source: 'quirky'; command: QuirkyCommandName }
  | { id: string; group: string; label: string; detail?: string; tag: string; source: 'agent'; name: string }

/** The commands and skills the agent reports for the session, kept live by `commandsChanged`. */
export function useAgentCommands(context: UiPluginContext, session: string): AgentCommand[] {
  const [commands, setCommands] = useState<AgentCommand[]>([])
  useEffect(() => {
    let cancelled = false
    setCommands([])
    context
      .call('quirky.structured/commands', { session })
      .then((loaded) => {
        const found = (loaded as { commands?: AgentCommand[] } | undefined)?.commands
        if (!cancelled && Array.isArray(found)) setCommands(found)
      })
      .catch(() => {})
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.structured/commandsChanged') return
      const data = event.data as { sessionId?: string; commands?: AgentCommand[] } | undefined
      if (!cancelled && data?.sessionId === session && Array.isArray(data.commands)) setCommands(data.commands)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [context, session])
  return commands
}

/** The `/` rows matching `query`: Quirky's own commands, then the agent's commands, then its skills. */
export function slashSuggestions(commands: AgentCommand[], query: string, agentLabel: string): Suggestion[] {
  const wanted = query.toLowerCase()
  const matches = (name: string) => name.toLowerCase().includes(wanted)
  const quirky = QUIRKY_COMMANDS.filter((command) => matches(command.name)).map(
    (command): Suggestion => ({ id: `quirky:${command.name}`, group: 'Quirky', label: `/${command.name}`, detail: command.description, tag: 'acts now', source: 'quirky', command: command.name })
  )
  const fromAgent = (kind: AgentCommand['kind'], group: string) =>
    commands
      .filter((command) => command.kind === kind && matches(command.name))
      .map((command): Suggestion => ({ id: `${kind}:${command.name}`, group, label: `/${command.name}`, detail: command.description, tag: 'sent', source: 'agent', name: command.name }))
  return [...quirky, ...fromAgent('command', `${agentLabel} commands`), ...fromAgent('skill', `${agentLabel} skills`)]
}

export function fileSuggestions(paths: string[]): Suggestion[] {
  return paths.map((path) => ({ id: `file:${path}`, group: 'Files', label: path, source: 'file', path }))
}

const list = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 'calc(var(--ui-row-single) * 8)',
  overflowY: 'auto',
  padding: 'var(--ui-space-4)',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)',
  border: 'var(--ui-border-width) solid var(--ui-accent)',
  borderBottom: 'none',
  borderRadius: 'var(--ui-radius-window) var(--ui-radius-window) 0 0'
} satisfies CSSProperties
const option = { cursor: 'pointer', minWidth: 0 } satisfies CSSProperties
const tagStyle = { color: 'var(--ui-muted)', whiteSpace: 'nowrap' } satisfies CSSProperties

/**
 * The suggestion list attached above the composer card. `empty` is the line shown when nothing
 * matches and `unavailable` replaces the list when the source cannot answer; `active` is the
 * highlighted row.
 */
export function SuggestionList({
  items,
  active,
  label,
  empty,
  unavailable,
  onPick
}: {
  items: Suggestion[]
  active: number
  label: string
  empty: string
  unavailable?: string
  onPick: (item: Suggestion) => void
}) {
  if (unavailable) return <div style={list}><InlineError message={unavailable} /></div>
  if (items.length === 0) return <div style={list} role="status"><EmptyState message={empty} /></div>
  const groups = items.reduce<{ group: string; rows: { item: Suggestion; index: number }[] }[]>((found, item, index) => {
    const last = found[found.length - 1]
    if (last?.group === item.group) last.rows.push({ item, index })
    else found.push({ group: item.group, rows: [{ item, index }] })
    return found
  }, [])
  return (
    <div style={list} role="listbox" aria-label={label}>
      {groups.map(({ group, rows }) => (
        <div key={group} role="group" aria-label={group}>
          <SectionHeader title={group} />
          {rows.map(({ item, index }) => (
            <div key={item.id} role="option" aria-selected={index === active} style={option} onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(item)}>
              <ListRow
                compact
                selected={index === active}
                title={
                  <>
                    {item.source === 'file' && <FileIcon path={item.path} />} {item.label}
                  </>
                }
                trailing={item.tag ? <span style={tagStyle}>{item.detail ? `${item.detail} · ${item.tag}` : item.tag}</span> : undefined}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
