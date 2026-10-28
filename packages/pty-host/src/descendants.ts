/** Every live descendant pid of `rootPid` or a tracked descendant, found from the process table. */
export function descendantsOf(rootPid: number, trackedRoots: Iterable<number> = []): number[] {
  let table: string
  try {
    const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' })
    if (!result.success) return []
    table = result.stdout.toString()
  } catch {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const siblings = children.get(ppid!)
    if (siblings) siblings.push(pid!)
    else children.set(ppid!, [pid!])
  }
  const roots = new Set([rootPid, ...trackedRoots])
  const found = new Set<number>()
  const queue = [...roots]
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]!) ?? []) {
      if (roots.has(child) || found.has(child)) continue
      found.add(child)
      queue.push(child)
    }
  }
  return [...found]
}
