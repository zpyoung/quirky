import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { PluginContext } from '@quirky/protocol'

export const QUICK_OPEN_MAX_ENTRIES = 20_001
export const QUICK_OPEN_MAX_RESULTS = 50
export const QUICK_OPEN_QUERY_MAX_BYTES = 2048
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024
const EXCLUDED_DIRS = [
  '.git', 'node_modules', '.next', '.nuxt', '.cache', '.stably', '.vscode', '.idea', '.yarn', '.pnpm-store',
  '.terraform', '.docker', '.husky', '.npm', '.npm-global', '.gvfs', '.local/share'
]

export type Inventory = { paths: string[]; truncated: boolean }
export type RankedPath = { path: string; name: string; score: number; line?: number; column?: number }

type SpawnResult = { bytes: Buffer; code: number; stderr: string; truncated: boolean }

export class FileInventory {
  private cache = new Map<string, { expires: number; promise: Promise<Inventory> }>()

  constructor(private readonly context: PluginContext) {}

  async list(root: string, includeIgnored = true, followSymlinks = false): Promise<Inventory> {
    const cacheKey = `${root}\0${includeIgnored}\0${followSymlinks}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expires > Date.now()) return cached.promise
    const promise = this.collect(root, includeIgnored, followSymlinks)
    this.cache.set(cacheKey, { expires: Date.now() + 750, promise })
    try {
      return await promise
    } catch (error) {
      this.cache.delete(cacheKey)
      throw error
    }
  }

  invalidate(root?: string): void {
    if (root === undefined) {
      this.cache.clear()
      return
    }
    for (const key of this.cache.keys()) if (key.startsWith(`${root}\0`)) this.cache.delete(key)
  }

  searchPaths(paths: string[], query: string, history: string[], limit = QUICK_OPEN_MAX_RESULTS): RankedPath[] {
    if (Buffer.byteLength(query, 'utf8') > QUICK_OPEN_QUERY_MAX_BYTES) return []
    const terms = [...new Set(query.toLowerCase().replaceAll('\\', '/').split(/\s+/).filter(Boolean))].sort()
    const recent = new Map(history.map((path, index) => [path, index]))
    const ranked: RankedPath[] = []
    for (const path of paths) {
      const normalized = path.toLowerCase().replaceAll('\\', '/')
      const name = path.slice(path.lastIndexOf('/') + 1)
      const loweredName = name.toLowerCase()
      let score = 0
      let matches = true
      for (const term of terms) {
        const pathScore = fuzzyScore(normalized, term)
        if (pathScore === null) {
          matches = false
          break
        }
        const nameScore = fuzzyScore(loweredName, term)
        score += nameScore === null ? pathScore : Math.max(pathScore, nameScore + 20)
      }
      if (!matches) continue
      const recentIndex = recent.get(path)
      if (recentIndex !== undefined) score += 10_000 - recentIndex
      ranked.push({ path, name, score })
    }
    ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, 'en', { sensitivity: 'base', numeric: true }) || (left.path < right.path ? -1 : 1))
    return ranked.slice(0, Math.max(1, Math.min(limit, QUICK_OPEN_MAX_RESULTS)))
  }

  private async collect(root: string, includeIgnored: boolean, followSymlinks: boolean): Promise<Inventory> {
    const args = ['--files', '--no-config', '--null', '--hidden', '--path-separator', '/']
    if (followSymlinks) args.push('--follow')
    if (includeIgnored) args.push('--no-ignore-vcs')
    for (const excluded of EXCLUDED_DIRS) {
      args.push('--glob', `!**/${excluded}/**`)
      args.push('--glob', `!**/${excluded}`)
    }
    args.push('--', '.')
    const result = await spawnBounded('rg', args, root, MAX_INVENTORY_BYTES)
    if (result.code !== 0 && result.code !== 1) {
      throw this.context.error('not-found', `ripgrep (rg) could not list worktree files: ${result.stderr.trim() || `exit ${result.code}`}`)
    }
    const names = result.bytes.toString('utf8').split('\0').filter(Boolean)
    const limited = names.slice(0, QUICK_OPEN_MAX_ENTRIES)
    const filtered = await this.excludeNestedWorktrees(root, limited)
    return { paths: filtered, truncated: result.truncated || names.length > QUICK_OPEN_MAX_ENTRIES }
  }

  private async excludeNestedWorktrees(root: string, names: string[]): Promise<string[]> {
    const markerCache = new Map<string, Promise<boolean>>()
    const isNested = async (name: string): Promise<boolean> => {
      const segments = name.split('/').filter(Boolean)
      for (let end = 1; end < segments.length; end++) {
        const prefix = segments.slice(0, end).join('/')
        let marker = markerCache.get(prefix)
        if (marker === undefined) {
          marker = lstat(join(root, prefix, '.git')).then(() => true).catch(() => false)
          markerCache.set(prefix, marker)
        }
        if (await marker) return true
      }
      return false
    }
    const keep: string[] = []
    for (const name of names) if (!(await isNested(name))) keep.push(name.replaceAll(sep, '/'))
    return keep
  }
}

export function parseQuickOpenTarget(query: string): { path: string; line?: number; column?: number } {
  const match = /^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/.exec(query)
  if (match === null || match[1] === '') return { path: query }
  const candidate = match[1]!
  if (/^[A-Za-z]$/.test(candidate)) return { path: query }
  return { path: candidate, line: Number(match[2]), ...(match[3] === undefined ? {} : { column: Number(match[3]) }) }
}

function fuzzyScore(haystack: string, needle: string): number | null {
  if (needle.length === 0) return 0
  const exactIndex = haystack.indexOf(needle)
  if (exactIndex >= 0) return 100 + needle.length * 4 - exactIndex - Math.max(0, haystack.length - needle.length) / 100
  let cursor = 0
  let first = -1
  let last = -1
  let streak = 0
  let streakBest = 0
  for (const char of needle) {
    const index = haystack.indexOf(char, cursor)
    if (index < 0) return null
    if (first < 0) first = index
    streak = index === last + 1 ? streak + 1 : 1
    streakBest = Math.max(streakBest, streak)
    last = index
    cursor = index + 1
  }
  return needle.length * 3 + streakBest * 2 - first - (last - first - needle.length + 1)
}

function spawnBounded(command: string, args: string[], cwd: string, maxBytes: number): Promise<SpawnResult> {
  const process = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks: Buffer[] = []
  let bytes = 0
  let stderr = ''
  let truncated = false
  process.stdout.on('data', (chunk: Buffer) => {
    if (bytes >= maxBytes) {
      truncated = true
      process.kill('SIGTERM')
      return
    }
    const keep = Math.min(chunk.byteLength, maxBytes - bytes)
    chunks.push(chunk.subarray(0, keep))
    bytes += keep
    if (keep < chunk.byteLength) {
      truncated = true
      process.kill('SIGTERM')
    }
  })
  process.stderr.setEncoding('utf8')
  process.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
  return new Promise((resolve, reject) => {
    process.once('error', reject)
    process.once('close', (code) => resolve({ bytes: Buffer.concat(chunks, bytes), code: code ?? -1, stderr, truncated }))
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('ripgrep (rg) is required for file inventory and contents search; install ripgrep and retry')
    throw error
  })
}
