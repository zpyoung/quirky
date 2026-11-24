/**
 * Plans the path moves for rename.mjs. planPathMoves(paths, mapPath, exists)
 * returns { moves, collisions }: a move for every path whose mapped name
 * differs, and a collision for each target that already exists, that two
 * sources share (compared case-insensitively, since macOS volumes are), or
 * whose parent directory chain runs through a file, existing or planned.
 *
 * `exists(path)` returns a falsy value when nothing is there, 'dir' for a
 * directory and any other truthy value for a file.
 */

function ancestorsOf(path) {
  const parts = path.split('/')
  const out = []
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join('/'))
  }
  return out
}

export function planPathMoves(paths, mapPath, exists) {
  const moves = []
  const collisions = []
  const claimedFiles = new Map()
  const claimedDirs = new Map()

  for (const from of paths) {
    const to = mapPath(from)
    if (to === from) {
      continue
    }
    moves.push({ from, to })
    const key = to.toLowerCase()
    const ancestors = ancestorsOf(to)
    let reason = null
    if (claimedFiles.has(key)) {
      reason = `same target as ${claimedFiles.get(key)}`
    } else if (claimedDirs.has(key)) {
      reason = `target is a directory that ${claimedDirs.get(key)} needs`
    } else if (exists(to)) {
      reason = 'target exists'
    } else {
      const plannedFile = ancestors.find((dir) => claimedFiles.has(dir.toLowerCase()))
      const existingFile = ancestors.find((dir) => {
        const kind = exists(dir)
        return kind && kind !== 'dir'
      })
      if (plannedFile !== undefined) {
        reason = `parent ${plannedFile} is the target of ${claimedFiles.get(plannedFile.toLowerCase())}`
      } else if (existingFile !== undefined) {
        reason = `parent ${existingFile} is a file`
      }
    }
    if (reason) {
      collisions.push({ from, to, reason })
      continue
    }
    claimedFiles.set(key, from)
    for (const dir of ancestors) {
      claimedDirs.set(dir.toLowerCase(), from)
    }
  }
  return { moves, collisions }
}
