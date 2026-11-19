import type { ViewNode } from '../core/contract'

/** The key a node is matched by across versions: its `id`, else its position in the tree. */
export const nodeKey = (node: ViewNode, path: string): string => (node.id === undefined ? `path:${path}` : `id:${node.id}`)

function stable(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
}

/** A node without its children: a container changes only when its own props do, not when a child does. */
const own = (node: ViewNode): string => stable([node.type, node.props ?? null])

function collect(node: ViewNode, path: string, into: Map<string, ViewNode>): void {
  into.set(nodeKey(node, path), node)
  ;(node.children ?? []).forEach((child, index) => collect(child, `${path}.${index}`, into))
}

/**
 * The keys of the nodes in `next` that are new or differ from the node they match in `previous`.
 * Nodes match by id, else by path.
 */
export function changedKeys(previous: ViewNode, next: ViewNode): Set<string> {
  const before = new Map<string, ViewNode>()
  const after = new Map<string, ViewNode>()
  collect(previous, '0', before)
  collect(next, '0', after)
  const changed = new Set<string>()
  for (const [key, node] of after) {
    const match = before.get(key)
    if (match === undefined || own(match) !== own(node)) changed.add(key)
  }
  return changed
}
