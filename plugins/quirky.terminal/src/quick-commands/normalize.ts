import { QUICK_COMMAND_LIMITS } from '../layout/types'
import type { QuickCommand } from '../layout/types'

/** One thing wrong with a quick command, tied to the field the form should mark. */
export type QuickCommandError = { field: 'label' | 'kind' | 'agent' | 'command' | 'appendEnter' | 'scope' | 'repo'; message: string }

const LINE_BREAK = /\r\n|\r|\n/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null
}

/** An ID slug from a label: lowercase, runs of other characters become one `-`, at most 80 characters. */
function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, QUICK_COMMAND_LIMITS.id)
    .replace(/-+$/, '')
}

/** A quick command with both a label and a command can be run; half-typed rows are kept but not offered. */
export function isQuickCommandComplete(command: Pick<QuickCommand, 'label' | 'command'>): boolean {
  return command.label.trim().length > 0 && command.command.trim().length > 0
}

/**
 * Cleans a stored or submitted list: trims text, clamps it to the limits, derives an ID from the
 * label for rows without one, and de-duplicates IDs with `-2`, `-3`. Rows with neither a label nor
 * a command are dropped, but a row with only one of them is kept so a half-typed command survives.
 * Agent rows need an agent. Rows past the 40th are dropped.
 */
export function normalizeQuickCommands(list: unknown): QuickCommand[] {
  if (!Array.isArray(list)) return []
  const out: QuickCommand[] = []
  const seen = new Set<string>()

  for (const item of list) {
    if (!isRecord(item)) continue
    const label = text(item.label)
    const command = text(item.command)
    if (label === null && command === null) continue
    const kind = item.kind === 'agent' ? 'agent' : 'terminal'
    const agent = kind === 'agent' ? text(item.agent) : null
    if (kind === 'agent' && !agent) continue

    const base = text(item.id)?.slice(0, QUICK_COMMAND_LIMITS.id) || slug(label ?? '') || `quick-command-${out.length + 1}`
    let id = base
    for (let n = 2; seen.has(id); n += 1) {
      const suffix = `-${n}`
      id = `${base.slice(0, QUICK_COMMAND_LIMITS.id - suffix.length)}${suffix}`
    }
    seen.add(id)

    const repo = item.scope === 'repo' ? text(item.repo)?.slice(0, QUICK_COMMAND_LIMITS.repo) || null : null
    out.push({
      id,
      label: (label ?? '').slice(0, QUICK_COMMAND_LIMITS.label),
      kind,
      agent,
      command: (command ?? '').slice(0, QUICK_COMMAND_LIMITS.command),
      appendEnter: kind === 'terminal' && item.appendEnter !== false,
      scope: repo ? 'repo' : 'global',
      repo
    })
    if (out.length >= QUICK_COMMAND_LIMITS.count) break
  }
  return out
}

/**
 * The problems with a quick command the user is saving, one entry per problem. Empty text is not
 * an error here (a half-typed row is kept; the form blocks Save itself). An agent command needs
 * an agent, a terminal command must not name one, and Append Enter exists only for terminal
 * commands.
 */
export function validateQuickCommand(input: unknown): QuickCommandError[] {
  if (!isRecord(input)) return [{ field: 'label', message: 'a quick command must be an object' }]
  const errors: QuickCommandError[] = []
  const add = (field: QuickCommandError['field'], message: string) => errors.push({ field, message })
  const tooLong = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > max

  if (input.label !== undefined && typeof input.label !== 'string') add('label', 'label must be text')
  else if (tooLong(input.label, QUICK_COMMAND_LIMITS.label)) add('label', `label must be at most ${QUICK_COMMAND_LIMITS.label} characters`)

  if (input.command !== undefined && typeof input.command !== 'string') add('command', 'command must be text')
  else if (tooLong(input.command, QUICK_COMMAND_LIMITS.command)) add('command', `command must be at most ${QUICK_COMMAND_LIMITS.command} characters`)

  const kind = input.kind ?? 'terminal'
  if (kind !== 'terminal' && kind !== 'agent') add('kind', 'kind must be terminal or agent')

  const agent = text(input.agent) ?? ''
  if (kind === 'agent' && !agent) add('agent', 'an agent command needs an agent')
  if (kind === 'terminal' && agent) add('agent', 'only an agent command takes an agent')
  if (kind === 'agent' && input.appendEnter === true) add('appendEnter', 'appendEnter applies only to terminal commands')

  const scope = input.scope ?? 'global'
  if (scope !== 'global' && scope !== 'repo') add('scope', 'scope must be global or repo')
  if (scope === 'repo' && !text(input.repo)) add('repo', 'a repo command needs a repo')
  if (tooLong(input.repo, QUICK_COMMAND_LIMITS.repo)) add('repo', `repo must be at most ${QUICK_COMMAND_LIMITS.repo} characters`)

  return errors
}

/** The message for adding a command when `existing` are already saved, or null while there is room. */
export function quickCommandCountError(existing: number): string | null {
  return existing >= QUICK_COMMAND_LIMITS.count ? `at most ${QUICK_COMMAND_LIMITS.count} quick commands` : null
}

/**
 * One shell command list from a multi-line command: each line trimmed, empty lines dropped, the
 * rest joined with `; `, so a foreground program can't read the later lines as its input.
 */
export function flattenQuickCommand(command: string): string {
  return command
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('; ')
}

/** The commands a workspace offers: every global one and the ones saved for its repo (null for the floating workspace). */
export function visibleQuickCommands(list: readonly QuickCommand[], repoId: string | null): QuickCommand[] {
  return list.filter((command) => command.scope === 'global' || (repoId !== null && command.repo === repoId))
}

/**
 * The command the tab strip's button runs: the group's last one if it is still offered, else the
 * first command saved for the repo, else the first global one. Incomplete rows are never picked.
 */
export function pickStripCommand(list: readonly QuickCommand[], repoId: string | null, lastId: string | null): QuickCommand | null {
  const runnable = visibleQuickCommands(list, repoId).filter(isQuickCommandComplete)
  return (
    (lastId !== null ? runnable.find((command) => command.id === lastId) : undefined) ??
    runnable.find((command) => command.scope === 'repo') ??
    runnable[0] ??
    null
  )
}
