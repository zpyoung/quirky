import type { UiPluginContext } from '@quirky/protocol'
import type { QuickCommand } from '../../layout/types'
import { isQuickCommandComplete } from '../../quick-commands/normalize'
import { openQuickCommandDialog } from './QuickCommandDialog'
import { runCommand } from './shared'

/** One row of the pane menu's Quick Commands submenu, in the shape the pane menu adapts. */
export type PaneMenuItem = {
  label: string
  /** Right-aligned secondary text, such as `Insert`. */
  hint?: string
  enabled: boolean
  /** True when a separator is drawn above the row. */
  separatorBefore?: boolean
  onSelect(): void | Promise<void>
}

/**
 * The rows of the pane menu's Quick Commands submenu for `pane`: the repo's commands, then global
 * ones, each typed into that pane; a command that does not press Enter shows `Insert`. Rows with
 * no command text are left out. With nothing to run the submenu says so, and `Add Quick Command…`
 * is always last. `options.repo` is the pane's repo, preselected as the new command's Project.
 */
export function paneQuickCommandItems(context: UiPluginContext, commands: readonly QuickCommand[], pane: string, options: { repo?: string | null } = {}): PaneMenuItem[] {
  const runnable = commands.filter(isQuickCommandComplete)
  const ordered = [...runnable.filter((entry) => entry.scope === 'repo'), ...runnable.filter((entry) => entry.scope !== 'repo')]
  const items: PaneMenuItem[] = ordered.map((command) => ({
    label: command.label,
    ...(command.kind === 'terminal' && !command.appendEnter ? { hint: 'Insert' } : {}),
    enabled: true,
    onSelect: () => runCommand(context, { id: command.id, pane })
  }))
  if (items.length === 0) items.push({ label: 'No quick commands', enabled: false, onSelect() {} })
  items.push({
    label: 'Add Quick Command…',
    enabled: true,
    separatorBefore: true,
    onSelect() {
      openQuickCommandDialog({ context, command: null, repo: options.repo ?? null })
    }
  })
  return items
}
