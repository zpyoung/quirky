/**
 * Plans the path moves for rename.mjs. planPathMoves(paths, mapPath, exists)
 * returns { moves, collisions }: a move for every path whose mapped name
 * differs, and a collision for each target that already exists or that two
 * sources share (compared case-insensitively, since macOS volumes are).
 */

export function planPathMoves(paths, mapPath, exists) {
  const moves = []
  const collisions = []
  const claimed = new Map()

  for (const from of paths) {
    const to = mapPath(from)
    if (to === from) {
      continue
    }
    moves.push({ from, to })
    const key = to.toLowerCase()
    if (claimed.has(key)) {
      collisions.push({ from, to, reason: `same target as ${claimed.get(key)}` })
      continue
    }
    claimed.set(key, from)
    if (exists(to)) {
      collisions.push({ from, to, reason: 'target exists' })
    }
  }
  return { moves, collisions }
}
