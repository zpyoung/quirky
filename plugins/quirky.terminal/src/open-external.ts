import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

/**
 * Whether `target` may be opened: an http, https or mailto URL, or an absolute path. Returns
 * the error message to show, or null when the target is fine.
 */
export function checkExternalTarget(target: unknown): string | null {
  if (typeof target !== 'string' || target.length === 0) return 'target must be a non-empty string'
  if (/[\u0000-\u001f\u007f]/.test(target)) return 'target contains control characters'
  if (SCHEME.test(target)) return ALLOWED_PROTOCOLS.has(protocolOf(target)) ? null : 'only http, https and mailto links can be opened'
  return isAbsolute(target) ? null : 'target must be an http, https or mailto URL or an absolute path'
}

/**
 * Opens a link or path with the system's default handler, or reveals a path in Finder when
 * `reveal` is set. With `QUIRKY_TEST_OPEN_LOG` set it appends `{target, reveal}` as a JSON line to
 * that file instead and opens nothing. The target goes to `open` as one argument, never through a
 * shell. Throws on a target `checkExternalTarget` refuses.
 */
export function openExternal(request: { target: string; reveal?: boolean }, env: Record<string, string | undefined> = process.env): void {
  const problem = checkExternalTarget(request.target)
  if (problem) throw new Error(problem)
  const reveal = request.reveal === true
  const log = env.QUIRKY_TEST_OPEN_LOG
  if (log) {
    appendFileSync(log, `${JSON.stringify({ target: request.target, reveal })}\n`)
    return
  }
  const argv = reveal && !SCHEME.test(request.target) ? ['open', '-R', request.target] : ['open', request.target]
  Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref()
}

/**
 * The text typed at a prompt when files are dropped on a pane: paths made of safe characters
 * stay bare, any other path is single-quoted (an embedded quote becomes `'\''`), joined by spaces.
 */
export function shellEscapePaths(paths: readonly string[]): string {
  return paths.map((path) => (SAFE_PATH.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`)).join(' ')
}
