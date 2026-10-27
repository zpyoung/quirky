/** Every live descendant pid of `rootPid`, found by walking the process table; empty when it cannot be read. */
export function descendantsOf(rootPid: number): number[] {
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
  const found: number[] = []
  const queue = [rootPid]
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]!) ?? []) {
      if (child === rootPid || found.includes(child)) continue
      found.push(child)
      queue.push(child)
    }
  }
  return found
}
