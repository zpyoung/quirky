import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react'
import { Badge, Button } from '@quirky/ui'
import type { ReviewFile } from '@quirky/protocol'
import { reviewOrder } from '../review/order'
import type { ViewMode } from './data'
import { FileRow, type RowHandlers, type RowItem } from './Rows'
import { buildTree, flattenTree, type TreeNode } from './tree'

const ROW_STYLE = { gap: 'var(--ui-space-2)', listStyle: 'none', margin: 0, padding: 0 } as const

/** The row a review file is shown as. */
export function toRowItem(file: ReviewFile): RowItem {
  return {
    key: file.path,
    path: file.path,
    oldPath: file.oldPath,
    letter: file.status,
    added: file.added,
    removed: file.removed,
    mark: file.mark,
    notes: file.notes,
    uncommitted: file.uncommitted,
    staged: file.staged,
    conflict: file.conflict,
    submodule: file.submodule
  }
}

/**
 * The files in the order the list shows them: path order, or the folder tree's order with the
 * files of `collapsed` folders left out. Keyboard movement follows this order.
 */
export function displayOrder(files: readonly ReviewFile[], mode: ViewMode, collapsed: ReadonlySet<string>): ReviewFile[] {
  if (mode === 'list') return reviewOrder(files, 'list')
  return flattenTree(buildTree(files), collapsed).flatMap(({ node }) => (node.kind === 'file' ? [node.item] : []))
}

type Props = {
  label: string
  files: readonly ReviewFile[]
  viewMode: ViewMode
  /** Folders (by path) whose files are hidden in the tree. */
  collapsed: ReadonlySet<string>
  onToggleDir(path: string): void
  selected: string | null
  handlers: RowHandlers
  onKeyDown(event: KeyboardEvent<HTMLUListElement>): void
}

function TreeRows({
  nodes,
  collapsed,
  onToggleDir,
  selected,
  handlers,
  idOf
}: Pick<Props, 'collapsed' | 'onToggleDir' | 'selected' | 'handlers'> & { nodes: TreeNode<ReviewFile>[]; idOf(path: string): string }) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'file') {
          return (
            <FileRow
              key={node.item.path}
              id={idOf(node.item.path)}
              item={toRowItem(node.item)}
              depth={node.depth}
              tree
              option
              selected={selected === node.path}
              handlers={handlers}
            />
          )
        }
        const closed = collapsed.has(node.path)
        return (
          <li
            key={node.path}
            role="presentation"
            data-directory-path={node.path}
            data-directory-name={node.name}
            style={{ paddingInlineStart: `calc(${node.depth} * var(--ui-space-12))` }}
          >
            <div className="ui-cluster git-folder-head">
              <Button tabIndex={-1} title={node.path} aria-expanded={!closed} onClick={() => onToggleDir(node.path)}>
                <span aria-hidden="true">{closed ? '▸' : '▾'}</span>
                <span>{node.name}</span>
                <Badge label={`${node.fileCount} file${node.fileCount === 1 ? '' : 's'}`}>{node.fileCount}</Badge>
              </Button>
            </div>
            {!closed && (
              <ul className="ui-stack" role="group" aria-label={node.name} style={ROW_STYLE}>
                <TreeRows nodes={node.children} collapsed={collapsed} onToggleDir={onToggleDir} selected={selected} handlers={handlers} idOf={idOf} />
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}

/**
 * The changed files as one listbox with a single tab stop, flat in path order or as a folder
 * tree. The selected row is announced through `aria-activedescendant`, and keys are the owner's:
 * the list only forwards them.
 */
export function ReviewList({ label, files, viewMode, collapsed, onToggleDir, selected, handlers, onKeyDown }: Props) {
  const root = useRef<HTMLUListElement>(null)
  const listId = useId()
  const idOf = (path: string) => `${listId}:${path}`
  const tree = useMemo(() => (viewMode === 'tree' ? buildTree(files) : []), [files, viewMode])
  const ordered = useMemo(() => (viewMode === 'list' ? reviewOrder(files, 'list') : []), [files, viewMode])
  const shown = files.some((file) => file.path === selected)

  useEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  return (
    <ul
      ref={root}
      className="ui-stack git-rows"
      role="listbox"
      aria-label={label}
      aria-activedescendant={selected !== null && shown ? idOf(selected) : undefined}
      tabIndex={0}
      style={ROW_STYLE}
      onKeyDown={onKeyDown}
    >
      {viewMode === 'tree' ? (
        <TreeRows nodes={tree} collapsed={collapsed} onToggleDir={onToggleDir} selected={selected} handlers={handlers} idOf={idOf} />
      ) : (
        ordered.map((file) => (
          <FileRow key={file.path} id={idOf(file.path)} item={toRowItem(file)} depth={0} tree={false} option selected={selected === file.path} handlers={handlers} />
        ))
      )}
    </ul>
  )
}
