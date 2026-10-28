import type { IBuffer, ILink, ILinkProvider } from '@xterm/xterm'
import type { UiPluginContext } from '@quirky/protocol'
import { readLogicalLine } from './link-provider'
import { taskLinkModifierLabel } from './links'

export const MAX_TASK_ID_LENGTH = 128

export type TaskIdMatch = { start: number; end: number; text: string }

type TaskLinkHandlers = {
  hover(target: string | null): void
  activate(event: MouseEvent, taskId: string): void
}

type TaskTerminalContext = Pick<UiPluginContext, 'call' | 'openView' | 'toast'>
type RecordValue = Record<string, unknown>

const TASK_ID_PREFIX = 'task_'
const TASK_ID = new RegExp(`${TASK_ID_PREFIX}[A-Za-z0-9_-]{1,${MAX_TASK_ID_LENGTH - TASK_ID_PREFIX.length}}`, 'g')
const TASK_ID_CHARACTER = /[A-Za-z0-9_-]/
const SESSION_WORKTREE_VIEW = 'view:quirky.session/worktree'

function isTaskIdCharacter(character: string | undefined): boolean {
  return character !== undefined && TASK_ID_CHARACTER.test(character)
}

function recordOf(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
}

function textOf(record: RecordValue, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Matches complete task_ tokens, bounded to 128 characters and detached from adjacent ID characters. */
export function findTaskIdCandidates(lineText: string): TaskIdMatch[] {
  const matches: TaskIdMatch[] = []
  for (const match of lineText.matchAll(TASK_ID)) {
    const start = match.index!
    const end = start + match[0].length
    if (isTaskIdCharacter(lineText[start - 1]) || isTaskIdCharacter(lineText[end])) continue
    matches.push({ start, end, text: match[0] })
  }
  return matches
}

/** Displays a task token as an xterm link while preserving logical-line and wide-cell coordinates. */
export function createTaskLinkProvider(
  term: { buffer: { active: Pick<IBuffer, 'getLine'> } },
  handlers: TaskLinkHandlers
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      try {
        const { text, cells } = readLogicalLine(term.buffer.active, y)
        const links: ILink[] = []
        for (const match of findTaskIdCandidates(text)) {
          const startCell = cells[match.start]
          const endCell = cells[match.end - 1]
          if (!startCell || !endCell) continue
          links.push({
            range: {
              start: { x: startCell.col + 1, y: startCell.row + 1 },
              end: { x: endCell.col + endCell.width, y: endCell.row + 1 }
            },
            text: match.text,
            activate: (event) => handlers.activate(event, match.text),
            hover: () => handlers.hover(`${match.text} — Click for actions or ${taskLinkModifierLabel(navigator.platform)}+click to open task terminal`),
            leave: () => handlers.hover(null)
          })
        }
        callback(links.length > 0 ? links : undefined)
      } catch {
        callback(undefined)
      }
    }
  }
}

/** Opens the public exact local terminal or host-bound read-only output target. */
export async function openTaskTerminal(context: TaskTerminalContext, taskId: string): Promise<void> {
  try {
    const target = recordOf(await context.call('quirky.orchestration/taskTerminal', { taskId }))
    const resolvedTaskId = target ? textOf(target, 'taskId') : null
    const dispatchId = target ? textOf(target, 'dispatchId') : null
    if (target?.kind === 'remote_output') {
      const input = recordOf(target.input)
      if (resolvedTaskId !== taskId || !dispatchId ||
        target.viewId !== 'view:quirky.orchestration/remote-worker-output' || input?.dispatchId !== dispatchId) {
        throw new Error('The orchestration service did not prove an exact remote output target.')
      }
      context.openView('view:quirky.orchestration/remote-worker-output', { dispatchId })
      return
    }
    const sessionId = target ? textOf(target, 'sessionId') : null
    const worktreeId = target ? textOf(target, 'worktreeId') : null
    if (!target || resolvedTaskId !== taskId || !dispatchId || !sessionId || !worktreeId) {
      throw new Error('The orchestration service did not prove an exact terminal for this task.')
    }

    const session = recordOf(await context.call('quirky.session/get', { session: sessionId }))
    if (session?.id !== sessionId || session.kind !== 'terminal' || session.worktreeId !== worktreeId) {
      throw new Error('The task terminal session no longer matches its current workspace.')
    }
    context.openView(SESSION_WORKTREE_VIEW, { worktree: worktreeId, session: sessionId })
  } catch (error) {
    context.toast('Could not open task terminal', error instanceof Error ? error.message : String(error))
  }
}
