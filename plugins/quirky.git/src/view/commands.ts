import type { UiPluginContext } from '@quirky/protocol'
import { AI_SETTINGS_VIEW_ID } from '../ai/types'
import { addReviewNote } from '../notes/composers'
import { activePanel } from '../panel/registry'
import { worktreeOf } from '../scm'
import { isHeld, postSendRequest } from '../notes/SendMenu'
import type { Note } from '../notes/useNotes'
import { DIFF_VIEW_ID, PANEL_ID, type DiffViewInput } from '../shared/view-input'
import { activeView, openDiffView } from './registry'

type Args = Record<string, unknown>

const argsOf = (args: unknown): Args => (typeof args === 'object' && args !== null ? (args as Args) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** The worktree a command acts on: its `worktree` argument, else the one the open view shows. */
function worktreeFor(context: UiPluginContext, args: Args): string {
  const worktree = text(args.worktree) ?? openDiffView()?.input.worktree ?? worktreeOf(context.getLayout())
  if (!worktree) throw new Error('Open a worktree first.')
  return worktree
}

const SOURCES = ['unstaged', 'staged', 'branch', 'commit'] as const
const AREAS = ['staged', 'unstaged', 'untracked', 'branch', 'all'] as const

/** The file diff (or conflict file) input for an `open-diff` command. */
function openDiffInput(worktree: string, args: Args): DiffViewInput {
  const path = text(args.path)
  if (!path) throw new Error('open-diff needs a path.')
  if (args.source === 'conflict') return { worktree, mode: 'conflict-file', path }
  const source =
    SOURCES.find((s) => s === args.source) ??
    (args.area === 'staged' || args.area === 'branch' ? args.area : args.commit ? 'commit' : 'unstaged')
  const oldPath = text(args.oldPath)
  const commit = text(args.commit)
  return { worktree, mode: 'file', source, path, ...(oldPath ? { oldPath } : {}), ...(commit ? { commit } : {}) }
}

/**
 * Every window command of `quirky.git`, keyed by its short id. Handlers tolerate missing
 * arguments (keybindings run them with none). The view commands act on the open diff view and
 * throw when there is none; the open commands default to the open view's worktree.
 */
export function commandHandlers(context: UiPluginContext): Record<string, (args?: unknown) => unknown> {
  const open = (input: DiffViewInput) => context.openView(DIFF_VIEW_ID, input)
  return {
    show: () => context.togglePanel(PANEL_ID, true),
    'open-diff': (args) => open(openDiffInput(worktreeFor(context, argsOf(args)), argsOf(args))),
    'open-changes': (args) => {
      const given = argsOf(args)
      const area = AREAS.find((a) => a === given.area) ?? 'unstaged'
      open({ worktree: worktreeFor(context, given), mode: 'combined', area })
    },
    'open-branch-changes': (args) => open({ worktree: worktreeFor(context, argsOf(args)), mode: 'combined', area: 'branch' }),
    'open-commit': (args) => {
      const given = argsOf(args)
      const commit = text(given.commit)
      if (!commit) throw new Error('open-commit needs a commit.')
      open({ worktree: worktreeFor(context, given), mode: 'combined', commit })
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
