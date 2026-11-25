import { File } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LOCAL_COMMANDS, type ComposerCommand, type LocalCommandName } from './composer-commands'

/** One pickable row of the list; `source` says what picking it does. */
export type Suggestion =
  | {
      id: string
      group: string
      label: string
      detail?: string
      tag?: string
      source: 'file'
      path: string
    }
  | {
      id: string
      group: string
      label: string
      detail?: string
      tag: string
      source: 'local'
      command: LocalCommandName
    }
  | {
      id: string
      group: string
      label: string
      detail?: string
      tag: string
      source: 'host'
      command: ComposerCommand
    }
  | {
      id: string
      group: string
      label: string
      detail?: string
      tag: string
      source: 'agent'
      name: string
    }

const AGENT_GROUPS: readonly { kind: 'command' | 'skill'; group: string }[] = [
  { kind: 'command', group: 'Commands' },
  { kind: 'skill', group: 'Skills' }
]

/**
 * The `/` rows matching `query`: the composer's own commands (only those in `available`), then the
 * host's, then the agent's grouped by kind. An agent entry sharing a name with a local command is
 * hidden, because picking that name acts in the composer.
 */
export function slashSuggestions(
  commands: readonly ComposerCommand[],
  query: string,
  available: ReadonlySet<LocalCommandName>
): Suggestion[] {
  const wanted = query.toLowerCase()
  const matches = (name: string) => name.toLowerCase().includes(wanted)
  const local = LOCAL_COMMANDS.filter(
    (command) => available.has(command.name) && matches(command.name)
  ).map((command): Suggestion => ({
    id: `local:${command.name}`,
    group: 'Composer',
    label: `/${command.name}`,
    detail: command.description,
    tag: 'acts now',
    source: 'local',
    command: command.name
  }))
  const localNames = new Set<string>(LOCAL_COMMANDS.map((command) => command.name))
  const offered = commands.filter(
    (command) => matches(command.name) && !localNames.has(command.name)
  )
  const host = offered
    .filter((command) => command.kind === 'host')
    .map((command): Suggestion => ({
      id: `host:${command.name}`,
      group: 'Conversation',
      label: `/${command.name}`,
      detail: command.description,
      tag: 'acts now',
      source: 'host',
      command
    }))
  const agent = AGENT_GROUPS.flatMap(({ kind, group }) =>
    offered
      .filter((command) => command.kind === kind)
      .map((command): Suggestion => ({
        id: `${kind}:${command.name}`,
        group,
        label: command.argumentHint
          ? `/${command.name} ${command.argumentHint}`
          : `/${command.name}`,
        detail: command.description,
        tag: 'sent',
        source: 'agent',
        name: command.name
      }))
  )
  return [...local, ...host, ...agent]
}

export function fileSuggestions(paths: readonly string[]): Suggestion[] {
  return paths.map((path) => ({
    id: `file:${path}`,
    group: 'Files',
    label: path,
    source: 'file',
    path
  }))
}

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
  items: readonly Suggestion[]
  active: number
  label: string
  empty: string
  unavailable?: string
  onPick: (item: Suggestion) => void
}): React.JSX.Element {
  const frame =
    'scrollbar-sleek max-h-64 overflow-y-auto rounded-t-xl border border-b-0 border-chat-composer-border bg-popover p-1 text-popover-foreground'
  if (unavailable) {
    return (
      <div className={frame} role="alert">
        <p className="px-2 py-1.5 text-xs text-destructive">{unavailable}</p>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className={frame} role="status">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{empty}</p>
      </div>
    )
  }
  const groups = items.reduce<{ group: string; rows: { item: Suggestion; index: number }[] }[]>(
    (found, item, index) => {
      const last = found.at(-1)
      if (last?.group === item.group) {
        last.rows.push({ item, index })
      } else {
        found.push({ group: item.group, rows: [{ item, index }] })
      }
      return found
    },
    []
  )
  return (
    <div className={frame} role="listbox" aria-label={label}>
      {groups.map(({ group, rows }) => (
        <div key={group} role="group" aria-label={group}>
          <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">{group}</p>
          {rows.map(({ item, index }) => (
            <div
              key={item.id}
              role="option"
              aria-selected={index === active}
              className={cn(
                'flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm',
                index === active && 'bg-accent text-accent-foreground'
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(item)}
            >
              {item.source === 'file' ? (
                <File className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : null}
              <span className="shrink-0 truncate">{item.label}</span>
              {item.source !== 'file' && item.detail ? (
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {item.detail}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {item.tag ? (
                <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                  {item.tag}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
