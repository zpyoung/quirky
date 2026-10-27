import type { GitArea, GitChangeStatus, GitStatusEntry } from '@quirky/protocol'

/** The sections a "discard all" can act on; conflicts are resolved or aborted, never discarded. */
export type DiscardArea = Exclude<GitArea, 'conflicts'>

/** What a discard dialog is about: one row, or a whole section of `count` rows. */
export type DiscardTarget =
  | { kind: 'file'; path: string; area: GitArea; status: GitChangeStatus }
  | { kind: 'section'; area: DiscardArea; count: number }

/** The dialog copy for a discard: heading, explanation and the destructive button's label. */
export type DiscardText = { title: string; body: string; confirm: string }

const UNDONE = 'This cannot be undone.'

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The confirmation text Orca shows for a discard, so the window dialog and the daemon's
 * `describe` ask the same question. Pure and free of DOM, React and CodeMirror because both
 * halves of the plugin import it.
 */
export function discardText(target: DiscardTarget): DiscardText {
  return textFor(target)
}

type MixedTarget = { kind: 'mixed'; count: number }

function textFor(target: DiscardTarget | MixedTarget): DiscardText {
  if (target.kind === 'mixed') {
    return {
      title: `Discard changes to ${plural(target.count, 'file')}?`,
      body: `This will revert the unstaged changes to these files. ${UNDONE}`,
      confirm: `Discard ${target.count}`
    }
  }
  if (target.kind === 'file') {
    const name = baseName(target.path)
    if (target.area === 'untracked' || target.status === 'untracked') {
      return { title: `Delete "${name}"?`, body: `This will permanently delete this file. ${UNDONE}`, confirm: 'Delete' }
    }
    if (target.status === 'deleted') {
      return {
        title: `Restore "${name}"?`,
        body: `This will restore the last staged version and discard the deletion. ${UNDONE}`,
        confirm: 'Restore'
      }
    }
    return {
      title: `Discard changes to "${name}"?`,
      body: `This will revert the unstaged changes to this file. ${UNDONE}`,
      confirm: 'Discard'
    }
  }
  switch (target.area) {
    case 'untracked': {
      const n = target.count
      return {
        title: `Delete ${plural(n, 'untracked file')}?`,
        body: `This will permanently delete ${n === 1 ? 'this untracked file' : `these ${n} untracked files`}. ${UNDONE}`,
        confirm: n === 1 ? 'Delete' : `Delete ${n}`
      }
    }
    case 'staged':
      return {
        title: 'Discard all staged changes?',
        body: `This will unstage and revert all staged changes. Staged new files will be deleted. ${UNDONE}`,
        confirm: 'Discard all'
      }
    case 'unstaged':
      return {
        title: 'Discard all unstaged changes?',
        body: `This will revert all unstaged changes. ${UNDONE}`,
        confirm: 'Discard all'
      }
  }
}

/** What a daemon `discard` call acts on: explicit paths, or a whole area; `entries` is the current status. */
export type DiscardRequest = {
  paths?: readonly string[]
  area?: DiscardArea
  entries: readonly GitStatusEntry[]
}

/**
 * One line of text for the kernel's ask: the dialog's title and body joined by a space.
 * Several explicit paths that are all untracked read as an untracked section; any other mix
 * reads "Discard changes to N files?" (no Orca equivalent, bulk discards are not dialogs there).
 */
export function describeDiscardText(request: DiscardRequest): string {
  const { title, body } = textFor(targetOf(request))
  return `${title} ${body}`
}

function targetOf({ paths, area, entries }: DiscardRequest): DiscardTarget | MixedTarget {
  if (area) return { kind: 'section', area, count: entries.filter((e) => e.area === area).length }
  const list = paths ?? []
  const rows = list.map((path) => discardableRow(path, entries))
  if (list.length === 1) {
    const row = rows[0]
    return { kind: 'file', path: list[0], area: row?.area ?? 'unstaged', status: row?.status ?? 'modified' }
  }
  if (list.length > 1 && rows.every((row) => row?.area === 'untracked')) {
    return { kind: 'section', area: 'untracked', count: list.length }
  }
  return { kind: 'mixed', count: list.length }
}

/** The row a discard of `path` would act on: its changed side, never its staged side. */
function discardableRow(path: string, entries: readonly GitStatusEntry[]): GitStatusEntry | undefined {
  return entries.find((e) => e.path === path && (e.area === 'unstaged' || e.area === 'untracked'))
}
