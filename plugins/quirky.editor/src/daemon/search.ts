import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { PluginCaller, PluginContext } from '@quirky/protocol'
import type { EditorSearchState, SearchFile } from '../types'
import { join } from 'node:path'
import { WorktreePaths } from './paths'
import { normalizeRipgrepPath } from './inventory'

export const SEARCH_MAX_RESULTS = 2000
export const SEARCH_MAX_INPUT_BYTES = 8192
export const SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024
export const SEARCH_TIMEOUT_MS = 15_000
const SEARCH_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DISPLAY_LINE_MAX = 500

type SearchOptions = {
  worktree?: string
  action: 'run' | 'cancel' | 'state'
  query?: string
  caseSensitive?: boolean
  wholeWord?: boolean
  useRegex?: boolean
  includePattern?: string
  excludePattern?: string
  requestId?: string
  maxResults?: number
}

type SearchResult = EditorSearchState

type MatchData = {
  path?: { text?: string; bytes?: string }
  lines?: { text?: string; bytes?: string }
  line_number?: number
  submatches?: { match?: { text?: string; bytes?: string }; start?: number; end?: number }[]
}

type RunningSearch = {
  id: string
  cancelled: boolean
  child: ChildProcessByStdio<null, Readable, Readable>
  timer: ReturnType<typeof setTimeout>
  result: SearchResult
  done: Promise<SearchResult>
  resolve(result: SearchResult): void
}

export class ContentsSearch {
  private readonly states = new Map<string, SearchResult>()
  private readonly running = new Map<string, RunningSearch>()
  private disposed = false

  constructor(private readonly context: PluginContext, private readonly paths: WorktreePaths) {}

  async call(params: SearchOptions, caller?: PluginCaller): Promise<SearchResult> {
    const worktree = await this.paths.resolve(params.worktree, caller)
    if (params.action === 'state') return this.state(worktree.id)
    if (params.action === 'cancel') {
      this.cancel(worktree.id, params.requestId)
      return this.state(worktree.id)
    }
    return await this.start(worktree.id, worktree.path, params)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const worktreeId of this.running.keys()) this.cancel(worktreeId)
    this.running.clear()
  }

  private state(worktreeId: string): SearchResult {
    return this.states.get(worktreeId) ?? {
      worktreeId,
      query: '',
      loading: false,
      error: null,
      files: [],
      totalMatches: 0,
      truncated: false,
      requestId: null
    }
  }

  private async start(worktreeId: string, root: string, params: SearchOptions): Promise<SearchResult> {
    if (this.disposed) throw this.context.error('conflict', 'editor search service is disposed')
    const query = params.query ?? ''
    const includePattern = params.includePattern ?? ''
    const excludePattern = params.excludePattern ?? ''
    if (query.length === 0) {
      const empty: SearchResult = { worktreeId, query, loading: false, error: null, files: [], totalMatches: 0, truncated: false, requestId: null }
      this.states.set(worktreeId, empty)
      return empty
    }
    if ([query, includePattern, excludePattern].some((text) => Buffer.byteLength(text, 'utf8') > SEARCH_MAX_INPUT_BYTES)) {
      const bounded = {
        worktreeId, query, loading: false, error: null, files: [], totalMatches: 0, truncated: false, requestId: null
      }
      this.states.set(worktreeId, bounded)
      return bounded
    }
    this.cancel(worktreeId)
    const requestId = params.requestId ?? randomUUID()
    const args = this.arguments(params, query, includePattern, excludePattern)
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn('rg', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      throw this.context.error('not-found', `ripgrep (rg) is required for contents search: ${error instanceof Error ? error.message : String(error)}`)
    }

    const result: SearchResult = {
      worktreeId,
      query,
      loading: true,
      error: null,
      files: [],
      totalMatches: 0,
      truncated: false,
      requestId
    }
    const { promise, resolve } = Promise.withResolvers<SearchResult>()
    let outputBytes = 0
    let pendingLine = ''
    let stderr = ''
    let settled = false
    const byPath = new Map<string, SearchFile>()
    const maxResults = Math.max(1, Math.min(params.maxResults ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS))

    const publish = (loading: boolean) => {
      result.loading = loading
      result.files = [...byPath.values()]
      if (this.running.get(worktreeId)?.child === child) this.states.set(worktreeId, { ...result, files: [...result.files] })
    }
    const finish = (error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      result.loading = false
      result.error = error ?? null
      result.files = [...byPath.values()]
      const final = { ...result, files: [...result.files] }
      const isCurrent = this.running.get(worktreeId)?.child === child
      if (isCurrent) {
        this.states.set(worktreeId, final)
        this.running.delete(worktreeId)
      }
      resolve(final)
    }
    const acceptLine = (raw: string) => {
      if (raw.length === 0) return
      let event: { type?: string; data?: MatchData }
      try {
        event = JSON.parse(raw) as typeof event
      } catch {
        return
      }
      if (event.type !== 'match' || event.data === undefined) return
      const data = event.data
      const rawPath = data.path?.text
      const lineText = data.lines?.text
      if (rawPath === undefined || lineText === undefined || data.line_number === undefined) return
      const relativePath = normalizeRipgrepPath(rawPath)
      if (relativePath === null) return
      const line = lineText.replace(/[\r\n]+$/, '')
      let file = byPath.get(relativePath)
      if (file === undefined) {
        file = { path: join(root, relativePath), relativePath, matches: [] }
        byPath.set(relativePath, file)
      }
      for (const submatch of data.submatches ?? []) {
        if (result.totalMatches >= maxResults) {
          result.truncated = true
          child.kill('SIGTERM')
          return
        }
        const byteStart = submatch.start ?? 0
        const matchText = submatch.match?.text ?? decodeJsonBytes(submatch.match?.bytes)
        const column = Buffer.from(line).subarray(0, byteStart).toString('utf8').length
        const matchLength = matchText.length
        const windowed = line.length > DISPLAY_LINE_MAX
        const windowStart = windowed ? Math.max(0, Math.min(column - 120, line.length - DISPLAY_LINE_MAX)) : 0
        const prefix = windowStart > 0 ? '…' : ''
        const suffix = windowStart + DISPLAY_LINE_MAX < line.length ? '…' : ''
        const contentStart = windowStart
        const contentEnd = Math.min(line.length, windowStart + DISPLAY_LINE_MAX - prefix.length - suffix.length)
        file.matches.push({
          line: data.line_number,
          column: column + 1,
          matchLength,
          lineContent: `${prefix}${line.slice(contentStart, contentEnd)}${suffix}`,
          ...(windowed ? {
            displayColumn: column - contentStart + prefix.length + 1,
            displayMatchLength: Math.min(matchLength, Math.max(0, contentEnd - column))
          } : {})
        })
        file.matchCount = (file.matchCount ?? 0) + 1
        result.totalMatches++
      }
    }
    const timer = setTimeout(() => {
      result.truncated = true
      child.kill('SIGTERM')
    }, SEARCH_TIMEOUT_MS)
    const running: RunningSearch = { id: requestId, child, timer, result, done: promise, resolve, cancelled: false }
    this.running.set(worktreeId, running)
    this.states.set(worktreeId, { ...result, files: [] })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8')
      if (outputBytes > SEARCH_MAX_OUTPUT_BYTES) {
        result.truncated = true
        child.kill('SIGTERM')
        return
      }
      pendingLine += chunk
      let newline = pendingLine.indexOf('\n')
      while (newline >= 0) {
        acceptLine(pendingLine.slice(0, newline))
        pendingLine = pendingLine.slice(newline + 1)
        newline = pendingLine.indexOf('\n')
      }
      publish(true)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
    child.once('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      finish(missing ? 'ripgrep (rg) is required for contents search; install ripgrep and retry' : error.message)
    })
    child.once('close', (code) => {
      if (pendingLine !== '') acceptLine(pendingLine)
      if (!running.cancelled && code !== 0 && code !== 1 && !result.truncated) {
        const error = params.useRegex === true && /^(?:rg: )?regex parse error:/.test(stderr.trim())
          ? `Invalid regular expression: ${query}`
          : stderr.trim() || `ripgrep exited with status ${code}`
        finish(error)
      } else finish()
    })
    return await promise
  }

  private cancel(worktreeId: string, requestId?: string): void {
    const active = this.running.get(worktreeId)
    if (active === undefined || (requestId !== undefined && active.id !== requestId)) return
    active.cancelled = true
    clearTimeout(active.timer)
    active.child.kill('SIGTERM')
    active.result.loading = false
    if (this.running.get(worktreeId)?.id === active.id) {
      this.states.set(worktreeId, { ...active.result, loading: false, files: [...active.result.files] })
    }
  }

  private arguments(params: SearchOptions, query: string, includePattern: string, excludePattern: string): string[] {
    const args = ['--no-config', '--json', '--hidden', '--path-separator', '/', `--max-filesize=${SEARCH_MAX_FILE_BYTES}`]
    args.push('--glob', '!**/.git/**', '--glob', '!**/node_modules/**')
    if (params.caseSensitive !== true) args.push('--ignore-case')
    if (params.wholeWord === true) args.push('--word-regexp')
    if (params.useRegex !== true) args.push('--fixed-strings')
    for (const pattern of splitGlobPatterns(includePattern)) {
      if (pattern.startsWith('!')) throw this.context.error('invalid-params', 'include globs cannot be exclusions')
      args.push('--glob', pattern)
    }
    for (const pattern of splitGlobPatterns(excludePattern)) args.push('--glob', `!${pattern}`)
    args.push('--', query, '.')
    return args
  }
}

function splitGlobPatterns(value: string): string[] {
  if (value === '') return []
  const patterns: string[] = []
  let current = ''
  let braces = 0
  let brackets = 0
  let escaped = false
  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') {
      current += char
      escaped = true
    } else if (char === '{') {
      braces++
      current += char
    } else if (char === '}' && braces > 0) {
      braces--
      current += char
    } else if (char === '[') {
      brackets++
      current += char
    } else if (char === ']' && brackets > 0) {
      brackets--
      current += char
    } else if (char === ',' && braces === 0 && brackets === 0) {
      if (current.trim() !== '') patterns.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') patterns.push(current.trim())
  return patterns
}

function decodeJsonBytes(value: string | undefined): string {
  if (value === undefined) return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}
