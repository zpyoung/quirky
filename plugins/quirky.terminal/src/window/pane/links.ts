import type { LinkClickSetting } from './settings'

export type PathMatch = {
  /** Offsets into the line text; `end` is exclusive. */
  start: number
  end: number
  /** The matched text including any `:line:column` suffix. */
  text: string
  path: string
  line: number | null
  column: number | null
}

/** The most paths one line may offer, which is also the daemon's batch limit for `pathsExist`. */
export const MAX_PATHS_PER_LINE = 50

const URL_RANGE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/g
const RUN = /[\p{L}\p{N}\p{M}_.\-/@+%:~[\]()]+/gu
const POSITION = /^(.*?)(?::(\d+))?(?::(\d+))?$/

function overlaps(ranges: [number, number][], start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from)
}

const count = (text: string, char: string) => text.split(char).length - 1

/** The run without wrapping brackets and trailing punctuation, and how many characters came off the front. */
function trimRun(run: string): { lead: number; text: string } {
  let lead = 0
  let text = run
  while (text.startsWith('(') || text.startsWith('[')) {
    lead += 1
    text = text.slice(1)
  }
  for (;;) {
    const last = text.at(-1)
    if (last === undefined) break
    if (last === ':' || last === '.' || last === '~') text = text.slice(0, -1)
    else if (last === ')' && count(text, ')') > count(text, '(')) text = text.slice(0, -1)
    else if (last === ']' && count(text, ']') > count(text, '[')) text = text.slice(0, -1)
    else break
  }
  return { lead, text }
}

function looksLikePath(path: string): boolean {
  if (path.includes('/')) return /[\p{L}\p{N}]/u.test(path) && !/^\/+$/.test(path) && path !== '.' && path !== '..'
  if (path.includes('@')) return false
  const extension = /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.([A-Za-z][A-Za-z0-9]{0,9})$/u.exec(path)
  return extension !== null
}

/**
 * The file-path-looking spans of one line of terminal text: anything with a `/`, or a bare name
 * with an extension, optionally followed by `:line` and `:column`. Spans inside URLs are skipped.
 * Whether a span names a real file is for the caller to check.
 */
export function findPathCandidates(lineText: string): PathMatch[] {
  if (!lineText.trim()) return []
  const urls: [number, number][] = []
  for (const url of lineText.matchAll(URL_RANGE)) urls.push([url.index!, url.index! + url[0].length])

  const matches: PathMatch[] = []
  for (const run of lineText.matchAll(RUN)) {
    const trimmed = trimRun(run[0])
    if (!trimmed.text) continue
    const start = run.index! + trimmed.lead
    const end = start + trimmed.text.length
    if (overlaps(urls, start, end)) continue
    const parts = POSITION.exec(trimmed.text)!
    const path = parts[1]!
    if (!looksLikePath(path)) continue
    matches.push({
      start,
      end,
      text: trimmed.text,
      path,
      line: parts[2] === undefined ? null : Number(parts[2]),
      column: parts[3] === undefined ? null : Number(parts[3])
    })
    if (matches.length === MAX_PATHS_PER_LINE) break
  }
  return matches
}

/** `path` as an absolute, normalized path (relative ones joined onto `cwd`), or null without a directory. */
export function resolveAgainst(path: string, cwd: string): string | null {
  const absolute = path.startsWith('/')
  if (!absolute && !cwd.startsWith('/')) return null
  const segments: string[] = []
  for (const part of `${absolute ? '' : `${cwd}/`}${path}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return `/${segments.join('/')}`
}

/** The normalized path relative to `root`, only when an absolute file stays inside that root. */
export function relativeWithinRoot(root: string, absolutePath: string): string | null {
  if (!root.startsWith('/') || !absolutePath.startsWith('/')) return null
  const normalizedRoot = resolveAgainst(root, '/')
  const normalizedPath = resolveAgainst(absolutePath, '/')
  if (!normalizedRoot || !normalizedPath || normalizedPath === normalizedRoot) return null
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null
}

/** The hover text for a file link: the absolute path with its `:line:column`. */
export function describeTarget(absolutePath: string, line: number | null, column: number | null): string {
  return `${absolutePath}${line === null ? '' : `:${line}`}${line !== null && column !== null ? `:${column}` : ''}`
}

export type LinkKind = 'url' | 'path'
export type LinkAction = 'popover' | 'open' | 'copy' | 'reveal' | 'none'

type ClickLike = { button: number; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }

/**
 * What a click on a link does: a plain click follows the `link-click` setting and a middle
 * click `link-middle-click`; Cmd-click opens, Shift-Cmd-click copies a URL or reveals a path;
 * every other combination is left alone.
 */
export function decideLinkClick(
  kind: LinkKind,
  event: ClickLike,
  settings: { 'link-click': LinkClickSetting; 'link-middle-click': LinkClickSetting }
): LinkAction {
  if (event.altKey || event.ctrlKey) return 'none'
  const fromSetting = (value: LinkClickSetting): LinkAction => (value === 'actions' ? 'popover' : value === 'open' ? 'open' : 'none')
  if (event.button === 1) return event.metaKey || event.shiftKey ? 'none' : fromSetting(settings['link-middle-click'])
  if (event.button !== 0) return 'none'
  if (event.metaKey) return event.shiftKey ? (kind === 'url' ? 'copy' : 'reveal') : 'open'
  if (event.shiftKey) return 'none'
  return fromSetting(settings['link-click'])
}

export type TaskLinkClickAction = 'popover' | 'open' | 'none'

/** The modifier shown in task-link hints and used to open a worker terminal directly. */
export function taskLinkModifierLabel(platform: string): 'Cmd' | 'Ctrl' {
  return platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl'
}

/** Task links always offer actions on a plain click and only switch on the host's primary modifier. */
export function decideTaskLinkClick(event: ClickLike, platform: string): TaskLinkClickAction {
  if (event.button !== 0 || event.altKey || event.shiftKey) return 'none'
  const mac = platform.toLowerCase().includes('mac')
  const modifier = mac ? event.metaKey : event.ctrlKey
  const otherModifier = mac ? event.ctrlKey : event.metaKey
  if (otherModifier) return 'none'
  if (modifier) return 'open'
  return 'popover'
}
