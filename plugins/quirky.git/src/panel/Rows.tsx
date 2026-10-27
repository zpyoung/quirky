import { useMemo, type DragEvent, type MouseEvent } from 'react'
import type { GitChangeStatus, GitStatusEntry } from '@quirky/protocol'
import { conflictLabel, splitPath, statusLetter } from './format'
import { buildTree, flattenTree, type TreeNode } from './tree'
import type { ViewMode } from './data'

/** One row of a section: an uncommitted entry or a file of the branch compare. */
export type RowItem = {
  key: string
  path: string
  oldPath?: string
  status: GitChangeStatus
  added?: number | null
  removed?: number | null
  /** The status entry behind an uncommitted row; absent for compare rows. */
  entry?: GitStatusEntry
  /** How many notes the path carries; absent or 0 shows no icon. */
  notes?: number
}

/** A hover button of a row or folder. */
export type RowButton = { label: string; glyph: string; run(): void; destructive?: boolean }

export type ClickKind = 'plain' | 'mod' | 'shift'

/** A submodule row's expansion: `entries` is null until the first read finishes, `failed` when it did not. */
export type Expansion = { open: boolean; entries: readonly GitStatusEntry[] | null; failed: boolean }

/** What a section's rows can do; the section decides, the rows only call. */
export type RowHandlers = {
  click(item: RowItem, kind: ClickKind): void
  contextMenu(item: RowItem, x: number, y: number): void
  buttons(item: RowItem): RowButton[]
  folderButtons(items: RowItem[]): RowButton[]
  dragText(item: RowItem): string
  /** The expansion of a dirty submodule row; null for every other row. */
  expansion?(item: RowItem): Expansion | null
  toggleExpansion?(item: RowItem): void
}

type Props = {
  /** Distinguishes folders of different sections that share a path. */
  scope: string
  items: readonly RowItem[]
  viewMode: ViewMode
  collapsedDirs: ReadonlySet<string>
  onToggleDir(key: string): void
  selected: readonly string[]
  handlers: RowHandlers
}

const clickKind = (event: MouseEvent): ClickKind => (event.metaKey || event.ctrlKey ? 'mod' : event.shiftKey ? 'shift' : 'plain')

/** The paths of a section's file rows in the order they are shown, which shift-click selects across. */
export function displayPaths(items: readonly RowItem[], viewMode: ViewMode, scope: string, collapsed: ReadonlySet<string>): string[] {
  if (viewMode === 'list') return items.map((i) => i.path)
  const tree = buildTree(items)
  return flattenTree(tree, scopedCollapsed(scope, collapsed, tree))
    .filter((r) => r.node.kind === 'file')
    .map((r) => r.node.path)
}

/** Collapsed folder keys are `scope:path`; the tree helpers want bare folder paths. */
function scopedCollapsed(scope: string, collapsed: ReadonlySet<string>, tree: TreeNode<RowItem>[]): Set<string> {
  const out = new Set<string>()
  const visit = (nodes: TreeNode<RowItem>[]) => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue
      if (collapsed.has(`${scope}:${node.path}`)) out.add(node.path)
      visit(node.children)
    }
  }
  visit(tree)
  return out
}

function Buttons({ buttons, subject }: { buttons: RowButton[]; subject: string }) {
  if (buttons.length === 0) return null
  return (
    <span className="scm-row-actions">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          className={`icon-button${b.destructive ? ' scm-destructive' : ''}`}
          title={b.label}
          aria-label={`${b.label} ${subject}`}
          onClick={(event) => {
            event.stopPropagation()
            b.run()
          }}
        >
          {b.glyph}
        </button>
      ))}
    </span>
  )
}

function Counts({ item }: { item: RowItem }) {
  return (
    <>
      {(item.added ?? 0) > 0 && <span className="scm-added">{`+${item.added}`}</span>}
      {(item.removed ?? 0) > 0 && <span className="scm-removed">{`−${item.removed}`}</span>}
    </>
  )
}

function NoteCount({ count }: { count: number | undefined }) {
  if (count === undefined || count === 0) return null
  const title = `${count} ${count === 1 ? 'note' : 'notes'}`
  return (
    <span className="scm-note-count" title={title}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <path d="M2.5 3h11v7.5H7L4 13v-2.5H2.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      {count}
    </span>
  )
}

function Trailing({ item }: { item: RowItem }) {
  const conflict = item.entry?.conflict
  if (conflict) {
    const unresolved = conflict.state === 'unresolved'
    const text = unresolved ? 'Unresolved' : 'Resolved locally'
    return (
      <>
        <NoteCount count={item.notes} />
        <span
          className={`scm-badge ${unresolved ? 'scm-badge-unresolved' : 'scm-badge-resolved'}`}
          aria-label={`${text} conflict (${conflictLabel(conflict.kind)})`}
          title={unresolved ? undefined : 'Local session state derived from a conflict you opened here.'}
        >
          <span className="scm-badge-icon" aria-hidden="true">
            {unresolved ? '⚠' : '✓'}
          </span>
          <span className="scm-badge-text">{text}</span>
        </span>
      </>
    )
  }
  return (
    <>
      <NoteCount count={item.notes} />
      <Counts item={item} />
      <span className={`scm-letter scm-status-${item.status}`}>{statusLetter(item.status)}</span>
    </>
  )
}

function SubmoduleEntries({ expansion, depth, tree }: { expansion: Expansion; depth: number; tree: boolean }) {
  const indent = tree ? { paddingLeft: (depth + 1) * 12 } : undefined
  if (expansion.entries === null || expansion.entries.length === 0) {
    const text = expansion.failed ? 'Could not load the submodule changes' : expansion.entries === null ? 'Loading…' : 'No changes inside'
    return (
      <li className="scm-sub-list" style={indent}>
        <p className="scm-sub-note">{text}</p>
      </li>
    )
  }
  return (
    <li className="scm-sub-list" style={indent}>
      <ul className="scm-rows">
        {expansion.entries.map((inside) => {
          const { name, dir } = splitPath(inside.path)
          return (
            <li key={`${inside.area}:${inside.path}`} className="scm-row scm-sub-entry" title={inside.path}>
              <span className="scm-row-main">
                <span className={`scm-file-icon scm-status-${inside.status}`} aria-hidden="true" />
                <span className="scm-row-text">
                  <span className="scm-row-line">
                    <span className="scm-row-name">{name}</span>
                    {dir !== '' && <span className="scm-row-dir">{dir}</span>}
                  </span>
                </span>
                <span className={`scm-letter scm-status-${inside.status}`}>{statusLetter(inside.status)}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </li>
  )
}

function FileRow({ item, depth, tree, selected, handlers }: { item: RowItem; depth: number; tree: boolean; selected: boolean; handlers: RowHandlers }) {
  const { name, dir } = splitPath(item.path)
  const hint = item.entry?.submodule ? 'Stage inside submodule' : item.entry?.conflict ? conflictLabel(item.entry.conflict.kind) : null
  const expansion = handlers.expansion?.(item) ?? null
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer?.setData('text/plain', handlers.dragText(item))
  }
  return (
    <>
      <li
        className={`scm-row${selected ? ' selected' : ''}`}
        style={tree ? { paddingLeft: depth * 12 } : undefined}
        draggable
        onDragStart={onDragStart}
        onContextMenu={(event) => {
          event.preventDefault()
          handlers.contextMenu(item, event.clientX, event.clientY)
        }}
      >
        {expansion && (
          <button
            type="button"
            className="scm-row-chevron"
            aria-label={`${expansion.open ? 'Collapse' : 'Expand'} ${item.path}`}
            aria-expanded={expansion.open}
            onClick={() => handlers.toggleExpansion?.(item)}
          >
            {expansion.open ? '▾' : '▸'}
          </button>
        )}
        <button type="button" className="scm-row-main" title={item.path} aria-pressed={selected} onClick={(event) => handlers.click(item, clickKind(event))}>
          <span className={`scm-file-icon scm-status-${item.status}`} aria-hidden="true" />
          <span className="scm-row-text">
            <span className="scm-row-line">
              <span className="scm-row-name">{name}</span>
              {!tree && dir !== '' && <span className="scm-row-dir">{dir}</span>}
            </span>
            {hint !== null && <span className="scm-row-sub">{hint}</span>}
          </span>
          <Trailing item={item} />
        </button>
        <Buttons buttons={handlers.buttons(item)} subject={item.path} />
      </li>
      {expansion?.open && <SubmoduleEntries expansion={expansion} depth={depth} tree={tree} />}
    </>
  )
}

function TreeRows({ scope, nodes, collapsedDirs, onToggleDir, selected, handlers }: Omit<Props, 'items' | 'viewMode'> & { nodes: TreeNode<RowItem>[] }) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'file') {
          return <FileRow key={node.item.key} item={node.item} depth={node.depth} tree selected={selected.includes(node.path)} handlers={handlers} />
        }
        const key = `${scope}:${node.path}`
        const collapsed = collapsedDirs.has(key)
        return (
          <li key={key} className="scm-dir-group">
            <div className="scm-row scm-dir" style={{ paddingLeft: node.depth * 12 }}>
              <button
                type="button"
                className="scm-row-main"
                aria-expanded={!collapsed}
                title={node.path}
                onClick={() => onToggleDir(key)}
              >
                <span className="scm-chevron" aria-hidden="true">
                  {collapsed ? '▸' : '▾'}
                </span>
                <span className="scm-row-name">{node.name}</span>
                <span className="scm-count">{node.fileCount}</span>
              </button>
              <Buttons buttons={handlers.folderButtons(node.items)} subject={node.path} />
            </div>
            {!collapsed && (
              <ul className="scm-rows">
                <TreeRows scope={scope} nodes={node.children} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} selected={selected} handlers={handlers} />
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}

/** The rows of one section, flat or as a folder tree. */
export function Rows({ scope, items, viewMode, collapsedDirs, onToggleDir, selected, handlers }: Props) {
  const tree = useMemo(() => (viewMode === 'tree' ? buildTree(items) : []), [items, viewMode])
  return (
    <ul className="scm-rows">
      {viewMode === 'tree' ? (
        <TreeRows scope={scope} nodes={tree} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} selected={selected} handlers={handlers} />
      ) : (
        items.map((item) => <FileRow key={item.key} item={item} depth={0} tree={false} selected={selected.includes(item.path)} handlers={handlers} />)
      )}
    </ul>
  )
}
