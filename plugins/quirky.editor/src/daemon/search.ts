import { randomUUID } from 'node:crypto'
import type { PluginCaller, PluginContext, SpawnExit, SpawnedProcess } from '@quirky/protocol'
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
  handle: SpawnedProcess
  result: SearchResult
  stop(): Promise<SpawnExit>
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
    const handle = this.context.process.spawn(['rg', ...args], {
      timeoutMs: SEARCH_TIMEOUT_MS,
      cwd: root,
      stderrTailBytes: 24_576
    })
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
    const byPath = new Map<string, SearchFile>()
    const maxResults = Math.max(1, Math.min(params.maxResults ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS))
    let stopPromise: Promise<SpawnExit> | undefined
    let outputBytes = 0
    let pendingLine = ''
    let incompleteRead = false
    let resultLimitReached = false
    let limitReached = false
    const running: RunningSearch = {
      id: requestId,
      cancelled: false,
      handle,
      result,
      stop() {
        stopPromise ??= handle.stop()
        return stopPromise
      }
    }

    const publish = () => {
      result.files = [...byPath.values()]
      if (this.running.get(worktreeId) === running) this.states.set(worktreeId, { ...result, files: [...result.files] })
    }
    const finish = (error?: string) => {
      result.loading = false
      result.error = error ?? null
      result.files = [...byPath.values()]
      const final = { ...result, files: [...result.files] }
      if (this.running.get(worktreeId) === running) {
        this.states.set(worktreeId, final)
        this.running.delete(worktreeId)
      }
      resolve(final)
    }
    const stopForLimit = () => {
      result.truncated = true
      resultLimitReached = true
      limitReached = true
      void running.stop()
    }
    const acceptLine = (raw: string) => {
      if (raw.length === 0 || resultLimitReached) return
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
      const submatches = data.submatches ?? []
      if (result.totalMatches >= maxResults && submatches.length > 0) {
        stopForLimit()
        return
      }
      const line = lineText.replace(/[\r\n]+$/, '')
      let file = byPath.get(relativePath)
      if (file === undefined) {
        file = { path: join(root, relativePath), relativePath, matches: [] }
        byPath.set(relativePath, file)
      }
      for (const submatch of submatches) {
        if (result.totalMatches >= maxResults) {
          stopForLimit()
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

    this.running.set(worktreeId, running)
    this.states.set(worktreeId, { ...result, files: [] })

    const readStdout = async () => {
      const reader = handle.stdout.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            if (!limitReached) {
              pendingLine += decoder.decode()
              if (!resultLimitReached && pendingLine !== '') acceptLine(pendingLine)
            }
            publish()
            return
          }
          if (limitReached) continue
          outputBytes += value.byteLength
          if (outputBytes > SEARCH_MAX_OUTPUT_BYTES) {
            result.truncated = true
            limitReached = true
            void running.stop()
            continue
          }
          pendingLine += decoder.decode(value, { stream: true })
          let newline = pendingLine.indexOf('\n')
          while (newline >= 0 && !limitReached) {
            const line = pendingLine.slice(0, newline)
            pendingLine = pendingLine.slice(newline + 1)
            acceptLine(line)
            newline = pendingLine.indexOf('\n')
          }
          publish()
        }
      } catch {
        if (!running.cancelled && !limitReached) {
          incompleteRead = true
          result.truncated = true
          void running.stop()
        }
      } finally {
        reader.releaseLock()
      }
    }

    const readTask = readStdout()
    const exit = await handle.exited
    await readTask

    if (exit.stopped === 'timeout') result.truncated = true
    let error: string | undefined
    if (!running.cancelled && exit.stopped !== 'aborted') {
      if (exit.spawnError !== undefined) {
        error = exit.spawnError.code === 'ENOENT'
          ? 'ripgrep (rg) is required for contents search; install ripgrep and retry'
          : exit.spawnError.message
      } else if (incompleteRead) {
        error = 'Search results are incomplete: ripgrep output could not be read to its end'
      } else if (exit.stopped !== 'timeout' && !result.truncated && exit.exitCode !== 0 && exit.exitCode !== 1) {
        const stderr = handle.stderrTail().slice(-8192)
        error = params.useRegex === true && /^(?:rg: )?regex parse error:/.test(stderr.trim())
          ? `Invalid regular expression: ${query}`
          : stderr.trim() || `ripgrep exited with status ${exit.exitCode}`
      }
    }
    finish(error)
    return await promise
  }

  private cancel(worktreeId: string, requestId?: string): void {
    const active = this.running.get(worktreeId)
    if (active === undefined || (requestId !== undefined && active.id !== requestId)) return
    active.cancelled = true
    void active.stop()
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
