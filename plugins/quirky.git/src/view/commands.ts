import type { UiPluginContext } from '@quirky/protocol'
import { AI_SETTINGS_VIEW_ID } from '../ai/types'
import { addReviewNote } from '../notes/composers'
import { activePanel } from '../panel/registry'
import { worktreeOf } from '../scm'
import { isHeld, postSendRequest } from '../notes/SendMenu'
import type { Note } from '../notes/useNotes'
import { PANEL_ID, type DiffViewInput } from '../shared/view-input'
import { openReview } from '../review/open'
import { messageOf } from './data'
import { openHostedDiff } from './hosted-tabs'
import { activeView, openDiffView, requestHostedDiffClose } from './registry'

type Args = Record<string, unknown>

const argsOf = (args: unknown): Args => (typeof args === 'object' && args !== null ? (args as Args) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** The worktree a command acts on: its `worktree` argument, else the one the open view shows. */
function worktreeFor(context: UiPluginContext, args: Args): string {
  const worktree = text(args.worktree) ?? openDiffView()?.input.worktree ?? worktreeOf(context.getLayout())
  if (!worktree) throw new Error('Open a worktree first.')
  return worktree
}

/** The conflict file input for an `open-diff` command with `source: 'conflict'`. */
function conflictInput(worktree: string, args: Args): DiffViewInput {
  const path = text(args.path)
  if (!path) throw new Error('open-diff needs a path.')
  const groupId = text(args.groupId)
  const display: DiffViewInput['display'] = args.display === 'source' || args.display === 'preview' ? args.display : undefined
  return {
    worktree,
    mode: 'conflict-file',
    path,
    ...(typeof args.preview === 'boolean' ? { preview: args.preview } : {}),
    ...(args.split === true ? { split: true } : {}),
    ...(groupId ? { groupId } : {}),
    ...(display === undefined ? {} : { display })
  }
}

/**
 * Every window command of `quirky.git`, keyed by its short id. Handlers tolerate missing
 * arguments (keybindings run them with none). The view commands act on the open diff view and
 * throw when there is none; the open commands default to the open view's worktree. Every diff
 * command except a conflict file opens the worktree's Review tab.
 */
export function commandHandlers(context: UiPluginContext): Record<string, (args?: unknown) => unknown> {
  const shown = async (opening: Promise<unknown>): Promise<void> => {
    try {
      await opening
    } catch (error) {
      context.toast('Could not open diff', messageOf(error))
    }
  }
  const open = (input: DiffViewInput) => shown(openHostedDiff(context, input))
  const review = (input: Parameters<typeof openReview>[1]) => shown(openReview(context, input))
  return {
    show: () => context.togglePanel(PANEL_ID, true),
    'open-diff': (args) => {
      const given = argsOf(args)
      const worktree = worktreeFor(context, given)
      if (given.source === 'conflict') return open(conflictInput(worktree, given))
      const path = text(given.path)
      if (!path) throw new Error('open-diff needs a path.')
      const commit = text(given.commit)
      return review({ worktree, reveal: path, ...(commit && (given.source === 'commit' || given.source === undefined) ? { commit } : {}) })
    },
    'close-diff': (args) => {
      const tabId = text(argsOf(args).tabId)
      if (!tabId) throw new Error('close-diff needs a tabId.')
      return requestHostedDiffClose(tabId) ?? context.call('quirky.terminal/closeTab', { tab: tabId })
    },
    'open-changes': (args) => review({ worktree: worktreeFor(context, argsOf(args)) }),
    'open-branch-changes': (args) => review({ worktree: worktreeFor(context, argsOf(args)) }),
    'open-commit': (args) => {
      const given = argsOf(args)
      const commit = text(given.commit)
      if (!commit) throw new Error('open-commit needs a commit.')
      return review({ worktree: worktreeFor(context, given), commit })
    },
    'review-conflicts': (args) => open({ worktree: worktreeFor(context, argsOf(args)), mode: 'conflicts' }),
    'send-review-notes': async () => {
      const { notes } = (await context.call('quirky.git/notes', { worktree: worktreeFor(context, {}) })) as { notes: Note[] }
      if (!notes.some((note) => !isHeld(note.id))) return
      context.togglePanel(PANEL_ID, true)
      postSendRequest({ nonce: Date.now(), issuedAt: Date.now() })
    },
    'add-review-note': () => void addReviewNote(),
    'ai-settings': () => context.openView(AI_SETTINGS_VIEW_ID, { worktree: worktreeFor(context, {}) }),
    'next-change': () => activeView().nextChange(),
    'previous-change': () => activeView().previousChange(),
    'next-conflict': () => activeView().nextConflict(),
    'previous-conflict': () => activeView().previousConflict(),
    'revert-change': () => activeView().revertChange(),
    save: () => activeView().save(),
    'reload-from-disk': () => activeView().reloadFromDisk(),
    overwrite: () => activeView().overwrite(),
    'collapse-all': (args) => {
      const collapsed = argsOf(args).collapsed
      activeView().collapseAll(typeof collapsed === 'boolean' ? collapsed : undefined)
    },
    'load-diff': (args) => {
      const path = text(argsOf(args).path)
      if (!path) throw new Error('load-diff needs a path.')
      return activeView().loadDiff(path)
    },
    'refresh-compare': () => activePanel().refreshCompare(),
    'set-filter': (args) => activePanel().setFilter(String(argsOf(args).query ?? '')),
    select: (args) => {
      const paths = argsOf(args).paths
      activePanel().select(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [])
    },
    'toggle-history': (args) => {
      const open = argsOf(args).open
      activePanel().toggleHistory(typeof open === 'boolean' ? open : undefined)
    }
  }
}
