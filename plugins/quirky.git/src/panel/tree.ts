const collator = new Intl.Collator('en', { numeric: true })

/** A file row of a section tree. `item` is the caller's value (usually a status entry) for the path. */
export type TreeFile<T> = { kind: 'file'; name: string; path: string; depth: number; item: T }

/** A folder row. `name` is the compacted chain (`src/app`); `paths`/`items` are every file beneath it, in display order. */
export type TreeDir<T> = {
  kind: 'dir'
  name: string
  path: string
  depth: number
  fileCount: number
  paths: string[]
  items: T[]
  children: TreeNode<T>[]
}

export type TreeNode<T> = TreeFile<T> | TreeDir<T>

type Draft<T> = { name: string; path: string; dirs: Map<string, Draft<T>>; files: { name: string; item: T }[] }

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * Builds the "View as tree" rows of one section from its items' paths. Directories sort before
 * files at every level, each group in natural order, and a directory whose only child is another
 * directory is merged with it (`a/b/c`). `depth` counts rendered levels, after merging.
 */
export function buildTree<T extends { path: string }>(items: readonly T[]): TreeNode<T>[] {
  const root: Draft<T> = { name: '', path: '', dirs: new Map(), files: [] }
  for (const item of items) {
    const segments = item.path.split('/')
    segments.pop()
    let at = root
    for (const segment of segments) {
      let next = at.dirs.get(segment)
      if (!next) {
        next = { name: segment, path: at.path === '' ? segment : `${at.path}/${segment}`, dirs: new Map(), files: [] }
        at.dirs.set(segment, next)
      }
      at = next
    }
    at.files.push({ name: baseName(item.path), item })
  }
  return render(root, 0)
}

function render<T extends { path: string }>(draft: Draft<T>, depth: number): TreeNode<T>[] {
  const dirs = [...draft.dirs.values()].sort((a, b) => collator.compare(a.name, b.name)).map((d) => renderDir(d, depth))
  const files = draft.files
    .slice()
    .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.item.path, b.item.path))
    .map((f): TreeFile<T> => ({ kind: 'file', name: f.name, path: f.item.path, depth, item: f.item }))
  return [...dirs, ...files]
}

function renderDir<T extends { path: string }>(first: Draft<T>, depth: number): TreeDir<T> {
  let draft = first
  let name = first.name
  while (draft.files.length === 0 && draft.dirs.size === 1) {
    draft = [...draft.dirs.values()][0]
    name = `${name}/${draft.name}`
  }
  const children = render(draft, depth + 1)
  const items = children.flatMap((c) => (c.kind === 'dir' ? c.items : [c.item]))
  return { kind: 'dir', name, path: draft.path, depth, fileCount: items.length, paths: items.map((i) => i.path), items, children }
}

/** A tree node and its indent, for one rendered row. */
export type TreeRow<T> = { node: TreeNode<T>; depth: number }

/**
 * The rows in display order, which is also the order shift-click selects across. Children of
 * a directory whose `path` is in `collapsed` are left out.
 */
export function flattenTree<T>(nodes: readonly TreeNode<T>[], collapsed: ReadonlySet<string> = new Set()): TreeRow<T>[] {
  const rows: TreeRow<T>[] = []
  const visit = (list: readonly TreeNode<T>[]) => {
    for (const node of list) {
      rows.push({ node, depth: node.depth })
      if (node.kind === 'dir' && !collapsed.has(node.path)) visit(node.children)
    }
  }
  visit(nodes)
  return rows
}
