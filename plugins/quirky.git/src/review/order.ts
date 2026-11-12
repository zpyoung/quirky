import type { ReviewFile } from '@quirky/protocol'
import { buildTree, flattenTree } from '../panel/tree'

const utf8 = new TextEncoder()

/** Orders paths by their UTF-8 bytes, as the daemon does; UTF-16 code unit order differs for supplementary characters. */
function byteOrder(a: string, b: string): number {
  const x = utf8.encode(a)
  const y = utf8.encode(b)
  const shared = Math.min(x.length, y.length)
  for (let i = 0; i < shared; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}

/**
 * The files in the order the panel shows them, which is also the order the Review tab stacks its
 * cards and the order mark-and-advance walks. `tree` matches the panel's tree view with nothing collapsed.
 */
export function reviewOrder(files: readonly ReviewFile[], mode: 'list' | 'tree'): ReviewFile[] {
  if (mode === 'list') return [...files].sort((a, b) => byteOrder(a.path, b.path))
  const rows = flattenTree(buildTree(files))
  return rows.flatMap(({ node }) => (node.kind === 'file' ? [node.item] : []))
}

/**
 * The path to move to after `current` is dealt with: the first file after it in `ordered` that is
 * not yet reviewed (mark `none` or `changed`) and not conflicted, wrapping to the start. Null when
 * no other file is left, so the caller leaves the selection where it is.
 */
export function nextToReview(ordered: readonly ReviewFile[], current: string | null): string | null {
  const from = current === null ? -1 : ordered.findIndex((file) => file.path === current)
  for (let step = 1; step <= ordered.length; step++) {
    const file = ordered[(from + step) % ordered.length]!
    if (file.path === current) continue
    if (file.conflict === undefined && (file.mark === 'none' || file.mark === 'changed')) return file.path
  }
  return null
}
