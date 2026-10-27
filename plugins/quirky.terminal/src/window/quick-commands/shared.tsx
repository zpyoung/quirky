import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { QuickCommand } from '../../layout/types'

const QUICK_COMMANDS_EVENT = 'quirky.terminal/quickCommands'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The one-line summary under a command's label: `agent: prompt` for an agent command. */
export function summaryOf(command: QuickCommand): string {
  return command.kind === 'agent' && command.agent ? `${command.agent}: ${command.command}` : command.command
}

/**
 * The saved quick commands a view shows, loaded on mount and again on every `quickCommands`
 * event. With `workspace` it lists what that workspace's repo sees; `'all'` lists every command;
 * null loads nothing. `loaded` is false until the first answer, so a caller can avoid drawing the empty state early.
 */
export function useQuickCommands(context: UiPluginContext, workspace: string | 'all' | null): { commands: QuickCommand[]; loaded: boolean; refresh(): Promise<void> } {
  const [commands, setCommands] = useState<QuickCommand[]>([])
  const [loaded, setLoaded] = useState(false)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (workspace === null) return
    try {
      const params = workspace === 'all' ? { all: true } : { workspace }
      const result = (await context.call('quirky.terminal/quickCommands', params)) as { commands: QuickCommand[] }
      if (mounted.current) {
        setCommands(result.commands)
        setLoaded(true)
      }
    } catch (error) {
      if (mounted.current) setLoaded(true)
      context.toast('Could not load quick commands', messageOf(error))
    }
  }, [context, workspace])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === QUICK_COMMANDS_EVENT) void refresh()
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [context, refresh])

  return { commands, loaded, refresh }
}

/** Asks the person to confirm and removes a command; returns true when it was removed. */
export async function confirmAndRemove(context: UiPluginContext, command: QuickCommand): Promise<boolean> {
  const ok = await context.confirm({
    title: `Delete "${command.label}"?`,
    body: 'This quick command will be removed from your saved list.',
    confirmLabel: 'Delete'
  })
  if (!ok) return false
  try {
    await context.call('quirky.terminal/removeQuickCommand', { id: command.id, yes: true })
    return true
  } catch (error) {
    context.toast('Could not delete quick command', messageOf(error))
    return false
  }
}

/** Runs a command through the daemon, showing a toast when it can't start. */
export async function runCommand(context: UiPluginContext, params: Record<string, unknown>): Promise<void> {
  try {
    await context.call('quirky.terminal/runQuickCommand', params)
  } catch (error) {
    context.toast('Could not run quick command', messageOf(error))
  }
}

/** The display name of a repo, or its ID when the repo list can't be read. */
export function useRepoName(context: UiPluginContext, repo: string | null): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    setName(null)
    if (repo === null) return
    let live = true
    void (async () => {
      try {
        const repos = (await context.call('quirky.repo/list', {})) as { id: string; name: string }[]
        if (live) setName(repos.find((entry) => entry.id === repo)?.name ?? null)
      } catch {
        // the ID is a fine label when the list can't be read
      }
    })()
    return () => {
      live = false
    }
  }, [context, repo])
  return repo === null ? null : (name ?? repo)
}

type IconProps = { size?: number }

function Svg({ size = 12, children, filled = false }: IconProps & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export const PlayIcon = (props: IconProps) => (
  <Svg {...props} filled>
    <path d="M4 2.5v11l9-5.5z" />
  </Svg>
)
export const ChevronDownIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3.5 6l4.5 4.5L12.5 6" />
  </Svg>
)
export const CopyIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Svg>
)
export const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 8.5l3.2 3.2L13 4.8" />
  </Svg>
)
export const PencilIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.5 2.5l3 3L5 14H2v-3z" />
  </Svg>
)
export const TrashIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 4.5h11M6 4.5V2.8h4v1.7M4 4.5l.7 9h6.6l.7-9" />
  </Svg>
)
