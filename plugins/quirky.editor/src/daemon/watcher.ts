import { watch, type FSWatcher } from 'node:fs'
import { join, relative, sep } from 'node:path'

const IGNORED_WATCH_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'target', '.venv', '__pycache__'])

type WatchRecord = { root: string; watcher: FSWatcher; touched: number }
type WatchCallbacks = { change(worktreeId: string, path: string | null): void }

export class EditorWatcher {
  private readonly roots = new Map<string, WatchRecord>()
  private disposed = false

  constructor(private readonly callbacks: WatchCallbacks, private readonly maximumRoots = 4) {}

  keep(worktreeId: string, root: string): void {
    if (this.disposed) return
    const existing = this.roots.get(worktreeId)
    if (existing !== undefined) {
      existing.touched = Date.now()
      return
    }
    if (this.roots.size >= this.maximumRoots) {
      const oldest = [...this.roots.entries()].sort((left, right) => left[1].touched - right[1].touched)[0]
      if (oldest !== undefined) this.drop(oldest[0])
    }
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (this.disposed) return
        if (filename === null) {
          this.callbacks.change(worktreeId, null)
          return
        }
        const path = join(root, filename.toString())
        const rel = relative(root, path)
        if (rel.split(sep).some((segment) => IGNORED_WATCH_SEGMENTS.has(segment))) return
        this.callbacks.change(worktreeId, path)
      })
      watcher.on('error', () => {
        this.callbacks.change(worktreeId, null)
        this.drop(worktreeId)
      })
      this.roots.set(worktreeId, { root, watcher, touched: Date.now() })
    } catch {
      this.callbacks.change(worktreeId, null)
    }
  }

  touch(worktreeId: string): void {
    const record = this.roots.get(worktreeId)
    if (record !== undefined) record.touched = Date.now()
  }

  drop(worktreeId: string): void {
    const record = this.roots.get(worktreeId)
    if (record === undefined) return
    this.roots.delete(worktreeId)
    record.watcher.close()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.roots.values()) record.watcher.close()
    this.roots.clear()
  }
}
