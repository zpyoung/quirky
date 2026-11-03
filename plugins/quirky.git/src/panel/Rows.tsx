import type { DragEvent, ReactNode } from 'react'
import { Badge, FileIcon, IconButton, ListRow, ReviewMark } from '@quirky/ui'
import type { UiTone } from '@quirky/ui'
import type { GitChangeStatus, GitStatusEntry, ReviewMarkState } from '@quirky/protocol'
import { conflictLabel, splitPath, statusLetter } from './format'

/** The one-letter status a row ends with. */
export type StatusLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U'

/** One file row: a file of the review, or a file of a commit (which has no mark or uncommitted state). */
export type RowItem = {
  key: string
  path: string
  oldPath?: string
  letter: StatusLetter
  added?: number | null
  removed?: number | null
  /** The review mark; absent for rows that are not reviewed, such as a commit's files. */
  mark?: ReviewMarkState
  /** How many notes the path carries; absent or 0 shows nothing. */
  notes?: number
  /** The path has staged, unstaged or untracked changes, which the dot before the letter shows. */
  uncommitted?: boolean
  staged?: boolean
  conflict?: GitStatusEntry['conflict']
  submodule?: GitStatusEntry['submodule']
}

/** A button on the selected row. */
export type RowButton = { label: string; glyph: string; run(): void; destructive?: boolean }

/** A submodule row's expansion: `entries` is null until the first read finishes, `failed` when it did not. */
export type Expansion = { open: boolean; entries: readonly GitStatusEntry[] | null; failed: boolean }

/** What a list's rows can do; the list decides, the rows only call. */
export type RowHandlers = {
  click(item: RowItem): void
  contextMenu(item: RowItem, x: number, y: number): void
  /** The inline buttons of the selected row. */
  buttons(item: RowItem): RowButton[]
  dragText(item: RowItem): string
  /** The expansion of a dirty submodule row; null for every other row. */
  expansion?(item: RowItem): Expansion | null
  toggleExpansion?(item: RowItem): void
  /** Whether the row's commit checkbox is ticked; null shows no checkbox for the row. */
  check?(item: RowItem): boolean | null
  toggleCheck?(item: RowItem): void
}

const STATUS_NAMES: Readonly<Record<StatusLetter, GitChangeStatus>> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'untracked'
}

/** The row letter for a commit file's change status. */
export const letterOf = (status: GitChangeStatus): StatusLetter => statusLetter(status) as StatusLetter

function toneFor(letter: StatusLetter): UiTone {
  if (letter === 'M') return 'needs-you'
  if (letter === 'D') return 'failing'
  if (letter === 'R' || letter === 'C') return 'accent'
  if (letter === 'A' || letter === 'U') return 'working'
  return 'neutral'
}

function Counts({ item }: { item: RowItem }) {
  const added = item.added ?? 0
  const removed = item.removed ?? 0
  return (
    <>
      {added > 0 && <span className="git-row__added" aria-label={`${added} ${added === 1 ? 'addition' : 'additions'}`}>{`+${added}`}</span>}
      {removed > 0 && <span className="git-row__removed" aria-label={`${removed} ${removed === 1 ? 'deletion' : 'deletions'}`}>{`−${removed}`}</span>}
    </>
  )
}

function NoteCount({ count }: { count: number | undefined }) {
  if (count === undefined || count === 0) return null
  const title = `${count} ${count === 1 ? 'note' : 'notes'}`
  return <span className="git-row__notes" data-note-count title={title} aria-label={title}>{`✎${count}`}</span>
}

/** The row's single status letter, or its conflict badge: coloured text, labelled for assistive tech. */
function Status({ item }: { item: RowItem }) {
  if (item.conflict) {
    const unresolved = item.conflict.state === 'unresolved'
    const text = unresolved ? 'Unresolved' : 'Resolved locally'
    return (
      <Badge tone={unresolved ? 'needs-you' : 'accent'} label={`${text} conflict (${conflictLabel(item.conflict.kind)})`}>
        {unresolved ? '⚠' : '✓'} {text}
      </Badge>
    )
  }
  return (
    <span className={`git-row__status git-row__status--${toneFor(item.letter)}`} role="img" aria-label={`Git status ${STATUS_NAMES[item.letter]}`}>
      {item.letter}
    </span>
  )
}

function Dot({ item }: { item: RowItem }) {
  if (item.uncommitted !== true) return null
  const staged = item.staged === true
  return (
    <span
      className={`git-row__dirty${staged ? ' git-row__dirty--staged' : ''}`}
      role="img"
      aria-label={staged ? 'Staged, not committed' : 'Uncommitted changes'}
    />
  )
}

/** The commit checkbox, the review mark, file icon, name and, outside the tree, the folder dimmed after it. */
function RowTitle({ item, checkbox, tree }: { item: RowItem; checkbox?: ReactNode; tree: boolean }) {
  const { name, dir } = splitPath(item.path)
  return (
    <span className="git-row__title">
      {checkbox}
      {item.mark !== undefined && <span className="git-row__mark"><ReviewMark state={item.mark} /></span>}
      <FileIcon path={item.path} />
      <span className="git-row__text" data-row-name>{name}</span>
      {!tree && dir !== '' && <span className="git-row__dir" data-row-dir={dir} title={dir}><bdi>{dir}</bdi></span>}
      <span className="git-row__spacer" aria-hidden="true" />
    </span>
  )
}

const ROW_STYLE = { gap: 'var(--ui-space-2)', listStyle: 'none', margin: 0, padding: 0 } as const

function SubmoduleEntries({ expansion, indent }: { expansion: Expansion; indent: string | undefined }) {
  const style = indent === undefined ? undefined : { paddingInlineStart: indent }
  if (expansion.entries === null || expansion.entries.length === 0) {
    const text = expansion.failed ? 'Could not load the submodule changes' : expansion.entries === null ? 'Loading…' : 'No changes inside'
    return (
      <li role="presentation" style={style}>
        <p className="ui-text-muted" data-submodule-message>{text}</p>
      </li>
    )
  }
  return (
    <li role="presentation" style={style}>
      <ul className="ui-stack" role="group" aria-label="Changes inside the submodule" style={ROW_STYLE}>
        {expansion.entries.map((inside) => {
          const { name, dir } = splitPath(inside.path)
          return (
            <li key={`${inside.area}:${inside.path}`} className="git-row" data-submodule-entry data-row-path={inside.path}>
              <ListRow
                title={
                  <span className="git-row__title">
                    <FileIcon path={inside.path} />
                    <span className="git-row__text" data-row-name>{name}</span>
                    {dir !== '' && <span className="git-row__dir" data-row-dir={dir}><bdi>{dir}</bdi></span>}
                    <span className="git-row__spacer" aria-hidden="true" />
                  </span>
                }
                trailing={
                  <span className="ui-cluster git-row__end">
                    <span className={`git-row__status git-row__status--${toneFor(letterOf(inside.status))}`} role="img" aria-label={`Git status ${inside.status}`}>
                      {statusLetter(inside.status)}
                    </span>
                  </span>
                }
              />
            </li>
          )
        })}
      </ul>
    </li>
  )
}

type FileRowProps = {
  item: RowItem
  /** Tree indent level; 0 for a flat list. */
  depth: number
  tree: boolean
  selected: boolean
  /** The row sits in a listbox, so it is an option that reports whether it is selected. */
  option: boolean
  id?: string
  handlers: RowHandlers
}

/**
 * One file row. Only the selected row renders its inline buttons, and nothing is revealed by
 * hovering. Clicks select and open through the handlers; the buttons stop their own clicks.
 */
export function FileRow({ item, depth, tree, selected, option, id, handlers }: FileRowProps) {
  const hint = item.submodule ? 'Stage inside submodule' : item.conflict ? conflictLabel(item.conflict.kind) : null
  const expansion = handlers.expansion?.(item) ?? null
  const buttons = selected ? handlers.buttons(item) : []
  const checked = handlers.check?.(item) ?? null
  const indent = tree ? `calc(${depth} * var(--ui-space-12))` : undefined
  const onDragStart = (event: DragEvent<HTMLLIElement>) => {
    event.dataTransfer?.setData('text/plain', handlers.dragText(item))
  }
  return (
    <>
      <li
        id={id}
        className="git-row"
        role={option ? 'option' : undefined}
        aria-selected={option ? selected : undefined}
        data-row-path={item.path}
        title={hint === null ? item.path : `${item.path}\n${hint}`}
        style={indent === undefined ? undefined : { paddingInlineStart: indent }}
        draggable
        onClick={() => handlers.click(item)}
        onDragStart={onDragStart}
        onContextMenu={(event) => {
          event.preventDefault()
          handlers.contextMenu(item, event.clientX, event.clientY)
        }}
      >
        <div className={`ui-list-row ui-list-row--interactive${selected ? ' ui-list-row--selected' : ''}`}>
          <span className="ui-list-row__main">
            <RowTitle
              item={item}
              tree={tree}
              checkbox={
                checked === null ? undefined : (
                  <input
                    type="checkbox"
                    className="git-row__check"
                    aria-label={`Include ${item.path} in the commit`}
                    checked={checked}
                    tabIndex={-1}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => handlers.toggleCheck?.(item)}
                  />
                )
              }
            />
          </span>
          <span className="ui-list-row__trailing">
            <span className="ui-cluster git-row__end">
              {expansion && (
                <IconButton
                  label={`${expansion.open ? 'Collapse' : 'Expand'} ${item.path}`}
                  aria-expanded={expansion.open}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    handlers.toggleExpansion?.(item)
                  }}
                >
                  {expansion.open ? '▾' : '▸'}
                </IconButton>
              )}
              <Counts item={item} />
              <NoteCount count={item.notes} />
              <Dot item={item} />
              <Status item={item} />
              {buttons.length > 0 && (
                <span className="git-row__actions">
                  {buttons.map((button) => (
                    <IconButton
                      key={button.label}
                      label={`${button.label} ${item.path}`}
                      title={button.label}
                      tabIndex={-1}
                      variant={button.destructive ? 'destructive' : 'secondary'}
                      onClick={(event) => {
                        event.stopPropagation()
                        button.run()
                      }}
                    >
                      {button.glyph}
                    </IconButton>
                  ))}
                </span>
              )}
            </span>
          </span>
        </div>
      </li>
      {expansion?.open && <SubmoduleEntries expansion={expansion} indent={indent} />}
    </>
  )
}

/** A flat, non-interactive-selection list of file rows, such as the files of one commit. */
export function Rows({ items, selected, handlers }: { items: readonly RowItem[]; selected: readonly string[]; handlers: RowHandlers }) {
  return (
    <ul className="ui-stack git-rows" style={ROW_STYLE}>
      {items.map((item) => (
        <FileRow key={item.key} item={item} depth={0} tree={false} option={false} selected={selected.includes(item.path)} handlers={handlers} />
      ))}
    </ul>
  )
}
