import { useMemo, useRef, type DragEvent, type MouseEvent } from 'react'
import { Badge, Button, IconButton, ListRow } from '@quirky/ui'
import type { UiStatus, UiTone } from '@quirky/ui'
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

export type ClickKind = 'plain' | 'mod' | 'shift' | 'split'

/** A submodule row's expansion: `entries` is null until the first read finishes, `failed` when it did not. */
export type Expansion = { open: boolean; entries: readonly GitStatusEntry[] | null; failed: boolean }

/** What a section's rows can do; the section decides, the rows only call. */
export type RowHandlers = {
  click(item: RowItem, kind: ClickKind, permanent?: boolean): void
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

const clickKind = (event: MouseEvent): ClickKind =>
  event.metaKey || event.ctrlKey ? 'mod' : event.shiftKey ? 'shift' : event.altKey ? 'split' : 'plain'

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

function statusFor(status: GitChangeStatus): UiStatus {
  if (status === 'modified') return 'needs-you'
  if (status === 'deleted') return 'failing'
  if (status === 'renamed' || status === 'copied') return 'done'
  if (status === 'added' || status === 'untracked') return 'working'
  return 'idle'
}

function toneFor(status: GitChangeStatus): UiTone {
  if (status === 'modified') return 'needs-you'
  if (status === 'deleted') return 'failing'
  if (status === 'renamed' || status === 'copied') return 'accent'
  if (status === 'added' || status === 'untracked') return 'working'
  return 'neutral'
}

function Buttons({ buttons, subject }: { buttons: RowButton[]; subject: string }) {
  if (buttons.length === 0) return null
  return (
    <span className="ui-cluster">
      {buttons.map((button) => (
        <IconButton
          key={button.label}
          label={`${button.label} ${subject}`}
          title={button.label}
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
  )
}

function Counts({ item }: { item: RowItem }) {
  return (
    <>
      {(item.added ?? 0) > 0 && <Badge tone="working" label={`${item.added} additions`}>{`+${item.added}`}</Badge>}
      {(item.removed ?? 0) > 0 && <Badge tone="failing" label={`${item.removed} deletions`}>{`−${item.removed}`}</Badge>}
    </>
  )
}

function NoteCount({ count }: { count: number | undefined }) {
  if (count === undefined || count === 0) return null
  const title = `${count} ${count === 1 ? 'note' : 'notes'}`
  return <span data-note-count title={title}><Badge tone="neutral" label={title}>✎ {count}</Badge></span>
}

function Trailing({ item }: { item: RowItem }) {
  const conflict = item.entry?.conflict
  if (conflict) {
    const unresolved = conflict.state === 'unresolved'
    const text = unresolved ? 'Unresolved' : 'Resolved locally'
    return (
      <>
        <NoteCount count={item.notes} />
        <Badge
          tone={unresolved ? 'needs-you' : 'accent'}
          label={`${text} conflict (${conflictLabel(conflict.kind)})`}
        >
          {unresolved ? '⚠' : '✓'} {text}
        </Badge>
      </>
    )
  }
  return (
    <>
      <NoteCount count={item.notes} />
      <Counts item={item} />
      <Badge tone={toneFor(item.status)} label={`Git status ${item.status}`}>{statusLetter(item.status)}</Badge>
    </>
  )
}

const ROW_STYLE = { gap: 'var(--ui-space-2)', listStyle: 'none', margin: 0, padding: 0 } as const

function SubmoduleEntries({ expansion, depth, tree }: { expansion: Expansion; depth: number; tree: boolean }) {
  const indent = tree ? { paddingInlineStart: `calc(${depth + 1} * var(--ui-space-12))` } : undefined
  if (expansion.entries === null || expansion.entries.length === 0) {
    const text = expansion.failed ? 'Could not load the submodule changes' : expansion.entries === null ? 'Loading…' : 'No changes inside'
    return (
      <li style={indent}>
        <p className="ui-text-muted" data-submodule-message>{text}</p>
      </li>
    )
  }
  return (
    <li style={indent}>
      <ul className="ui-stack" style={ROW_STYLE}>
        {expansion.entries.map((inside) => {
          const { name, dir } = splitPath(inside.path)
          return (
            <li key={`${inside.area}:${inside.path}`} data-submodule-entry data-row-path={inside.path}>
              <ListRow
                title={<span title={inside.path}><span data-row-name>{name}</span>{dir !== '' && <span data-row-dir={dir} className="ui-text-muted">{` · ${dir}`}</span>}</span>}
                status={statusFor(inside.status)}
                statusLabel={`Git status ${inside.status}`}
                trailing={<Badge tone={toneFor(inside.status)} label={`Git status ${inside.status}`}>{statusLetter(inside.status)}</Badge>}
              />
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
  const activation = useRef<{ kind: ClickKind; permanent: boolean }>({ kind: 'plain', permanent: false })
  const onDragStart = (event: DragEvent<HTMLLIElement>) => {
    event.dataTransfer?.setData('text/plain', handlers.dragText(item))
  }
  return (
    <>
      <li
        data-row-path={item.path}
        title={item.path}
        style={tree ? { paddingInlineStart: `calc(${depth} * var(--ui-space-12))` } : undefined}
        draggable
        onClickCapture={(event) => { activation.current = { kind: clickKind(event), permanent: event.detail > 1 } }}
        onDragStart={onDragStart}
        onContextMenu={(event) => {
          event.preventDefault()
          handlers.contextMenu(item, event.clientX, event.clientY)
        }}
      >
        <div className="ui-cluster" style={{ flexWrap: 'nowrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ListRow
              title={<span><span data-row-name>{name}</span>{!tree && dir !== '' && <span data-row-dir={dir} className="ui-text-muted">{` · ${dir}`}</span>}</span>}
              description={hint ?? undefined}
              status={statusFor(item.status)}
              statusLabel={`Git status ${item.status}`}
              selected={selected}
              trailing={
                <span className="ui-cluster">
                  <Trailing item={item} />
                  <Buttons buttons={handlers.buttons(item)} subject={item.path} />
                </span>
              }
              onClick={() => handlers.click(item, activation.current.kind, activation.current.permanent)}
            />
          </div>
          {expansion && (
            <IconButton
              label={`${expansion.open ? 'Collapse' : 'Expand'} ${item.path}`}
              aria-expanded={expansion.open}
              onClick={() => handlers.toggleExpansion?.(item)}
            >
              {expansion.open ? '▾' : '▸'}
            </IconButton>
          )}
        </div>
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
          <li key={key} data-directory-path={node.path} data-directory-name={node.name} style={{ paddingInlineStart: `calc(${node.depth} * var(--ui-space-12))` }}>
            <div className="ui-cluster">
              <Button title={node.path} aria-expanded={!collapsed} onClick={() => onToggleDir(key)}>
                <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                <span>{node.name}</span>
                <Badge label={`${node.fileCount} files`}>{node.fileCount}</Badge>
              </Button>
              <Buttons buttons={handlers.folderButtons(node.items)} subject={node.path} />
            </div>
            {!collapsed && (
              <ul className="ui-stack" style={ROW_STYLE}>
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
    <ul className="ui-stack" style={ROW_STYLE}>
      {viewMode === 'tree' ? (
        <TreeRows scope={scope} nodes={tree} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} selected={selected} handlers={handlers} />
      ) : (
        items.map((item) => <FileRow key={item.key} item={item} depth={0} tree={false} selected={selected.includes(item.path)} handlers={handlers} />)
      )}
    </ul>
  )
}
