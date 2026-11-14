import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginCaller, PluginContext, Worktree } from '@quirky/protocol'
import { ServerPool, type Language, type ServerLocation } from './servers'

export type NavLocation = ServerLocation & { relativePath: string | null; preview: string }
export type NavResult = { worktreeId: string; language: string; locations: NavLocation[]; truncated: boolean }
type NavParams = { worktree?: string; path: string; line: number; column: number }
const extensions: Record<string, Language> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'typescript', '.jsx': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript',
  '.py': 'python', '.pyi': 'python'
}
const maxPreviewBytes = 8 * 1024 * 1024
const maxLocations = 1000

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** Validates disk-backed navigation requests before consuming a language server slot. */
export class NavigationService {
  constructor(private context: Pick<PluginContext, 'call' | 'error'>, private pool: ServerPool) {}

  private async worktree(selector: string | undefined, caller: PluginCaller): Promise<Worktree> {
    return await this.context.call('quirky.worktree/resolve', {
      selector: selector ?? 'current',
      ...(caller.role !== 'plugin' && caller.cwd ? { cwd: caller.cwd } : {}),
      ...(caller.role !== 'plugin' && caller.worktreeId ? { worktreeId: caller.worktreeId } : {})
    }) as Worktree
  }

  async navigate(method: 'definition' | 'references', params: NavParams, caller: PluginCaller): Promise<NavResult> {
    const worktree = await this.worktree(params.worktree, caller)
    if (params.path.includes('\0')) throw this.context.error('invalid-params', 'Path must not contain NUL bytes')
    const root = await realpath(worktree.path)
    const candidate = resolve(worktree.path, params.path)
    if (!inside(resolve(worktree.path), candidate) && !inside(root, candidate)) {
      throw this.context.error('invalid-params', `Path is outside the worktree: ${params.path}`)
    }
    let path: string
    try {
      path = await realpath(candidate)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        throw this.context.error('not-found', `File not found: ${params.path}`)
      }
      throw error
    }
    if (!inside(root, path)) throw this.context.error('invalid-params', `Path is outside the worktree: ${params.path}`)
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw this.context.error('invalid-params', `Path must be a file: ${params.path}`)
    const extension = extname(path).toLowerCase()
    const language = extensions[extension]
    if (!language) throw this.context.error('invalid-params', `Unsupported file extension: ${extension || '(none)'}`)
    const lineBreak = language === 'python' ? /\r\n|[\n\r]/ : /\r\n|[\n\r\u2028\u2029]/
    const lines = (await readFile(path, 'utf8')).split(lineBreak)
    const text = lines[params.line - 1]
    if (!Number.isInteger(params.line) || params.line < 1 || text === undefined) {
      throw this.context.error('invalid-params', `Invalid line ${params.line} in ${params.path}`)
    }
    if (!Number.isInteger(params.column) || params.column < 1 || params.column > text.length + 1) {
      throw this.context.error('invalid-params', `Invalid column ${params.column} on line ${params.line} in ${params.path}`)
    }
    const locations = await this.pool.use({ id: worktree.id, path: root }, language, (server) => server[method](path, params.line, params.column))
    const canonicalPaths = new Map<string, Promise<string>>()
    const canonical = (file: string) => {
      let result = canonicalPaths.get(file)
      if (!result) {
        result = realpath(file).catch(() => resolve(file))
        canonicalPaths.set(file, result)
      }
      return result
    }
    const unique = new Map<string, Omit<NavLocation, 'preview'>>()
    for (const location of locations) {
      const path = await canonical(location.path)
      const item = { ...location, path, relativePath: inside(root, path) ? relative(root, path).split(sep).join('/') : null }
      const key = JSON.stringify([path, item.line, item.column, item.endLine, item.endColumn])
      unique.set(key, item)
    }
    const sorted = [...unique.values()].sort((a, b) => {
      const left = a.relativePath ?? a.path
      const right = b.relativePath ?? b.path
      return (left < right ? -1 : left > right ? 1 : 0) || a.line - b.line || a.column - b.column
    })
    const previews = new Map<string, Promise<string[]>>([[path, Promise.resolve(fileStat.size > maxPreviewBytes ? [] : lines)]])
    const preview = async (file: string, line: number): Promise<string> => {
      let contents = previews.get(file)
      if (!contents) {
        contents = (async () => (await stat(file)).size > maxPreviewBytes ? [] : (await readFile(file, 'utf8')).split(lineBreak))().catch(() => [])
        previews.set(file, contents)
      }
      return (await contents)[line - 1]?.slice(0, 240) ?? ''
    }
    return {
      worktreeId: worktree.id, language, truncated: sorted.length > maxLocations,
      locations: await Promise.all(sorted.slice(0, maxLocations).map(async (item) => ({ ...item, preview: await preview(item.path, item.line) })))
    }
  }

  async stop(params: { worktree?: string; language?: string }, caller: PluginCaller): Promise<{ stopped: number }> {
    if (params.language !== undefined && params.language !== 'typescript' && params.language !== 'python') {
      throw this.context.error('invalid-params', `Unsupported language: ${params.language}`)
    }
    const worktreePath = params.worktree === undefined ? undefined : await realpath((await this.worktree(params.worktree, caller)).path)
    return { stopped: await this.pool.stop({ worktreePath, language: params.language }) }
  }
}
