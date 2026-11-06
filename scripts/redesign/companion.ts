/**
 * Wrapper around the quirk plugin's companion server (`companion.py`) for the redesigning-features
 * skill: finds the server on this machine and shows screens whose `{{img:...}}` placeholders are
 * replaced with screenshots embedded as data URIs.
 *
 * Every invocation prints one JSON object on stdout and diagnostics on stderr. Exit 0 is success,
 * 1 or any other code is the companion's own, passed through, and 2 is bad arguments or a broken
 * environment.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'

const COMPANION_SUFFIX = join('skills', 'writing-html-artifacts', 'scripts', 'companion.py')
const MAX_BUILT_BYTES = 8 * 1024 * 1024
const PLACEHOLDER = /\{\{img:([^}@]+)(?:@(\d+),(\d+),(\d+),(\d+))?\}\}/g
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** An environment problem a script reports as `{"error", "path"}` with exit 2. */
export class CompanionError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message)
    this.name = 'CompanionError'
  }
}

/** Crops the image at `file` to the `x,y,w,h` pixel rectangle and returns the cropped file's bytes. */
export type CropFn = (file: string, x: number, y: number, w: number, h: number) => Uint8Array

export type LocateEnvironment = { CLAUDE_PLUGIN_ROOT?: string; HOME: string }

type Search = { found: string | null; searched: string[] }

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function cachedCompanions(home: string): string[] {
  const cache = join(home, '.claude', 'plugins', 'cache')
  const versions = listDirectories(cache).flatMap((marketplace) =>
    listDirectories(join(cache, marketplace, 'quirk')).map((version) => ({
      version,
      path: join(cache, marketplace, 'quirk', version, COMPANION_SUFFIX),
    })),
  )
  return versions.sort((a, b) => compareVersions(b.version, a.version)).map((entry) => entry.path)
}

function marketplaceCompanions(home: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const paths: string[] = []
  for (const entry of Object.values(parsed)) {
    const source = (entry as { source?: { source?: unknown; path?: unknown } } | null)?.source
    if (source?.source === 'directory' && typeof source.path === 'string') {
      paths.push(join(source.path, COMPANION_SUFFIX))
    }
  }
  return paths
}

function searchCompanion(env: LocateEnvironment): Search {
  const searched: string[] = []
  const sources: Array<() => string[]> = [
    () => (env.CLAUDE_PLUGIN_ROOT ? [join(env.CLAUDE_PLUGIN_ROOT, COMPANION_SUFFIX)] : []),
    () => {
      const cached = cachedCompanions(env.HOME)
      return cached.length > 0 ? cached : [join(env.HOME, '.claude', 'plugins', 'cache', '*', 'quirk', '*', COMPANION_SUFFIX)]
    },
    () => marketplaceCompanions(env.HOME),
  ]
  for (const source of sources) {
    for (const candidate of source()) {
      searched.push(candidate)
      if (existsSync(candidate)) return { found: candidate, searched }
    }
  }
  return { found: null, searched }
}

/**
 * Returns the absolute path of the quirk plugin's `companion.py`, or null when none is installed.
 * Search order: `$CLAUDE_PLUGIN_ROOT`, the newest cached plugin version, then directory
 * marketplaces from `known_marketplaces.json` (a missing or malformed file is skipped).
 */
export function locateCompanion(env: LocateEnvironment): string | null {
  return searchCompanion(env).found
}

/** Default {@link CropFn}: shells out to macOS `sips`, so it throws a {@link CompanionError} elsewhere. */
export const sipsCrop: CropFn = (file, x, y, w, h) => {
  if (process.platform !== 'darwin') {
    throw new CompanionError('image crops need macOS sips and this host is not macOS', file)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'redesign-crop-'))
  try {
    const out = join(scratch, `crop${extname(file)}`)
    const result = spawnSync('sips', ['--cropOffset', String(y), String(x), '-c', String(h), String(w), file, '--out', out], {
      encoding: 'utf8',
    })
    if (result.error || result.status !== 0) {
      throw new CompanionError(`sips crop failed: ${result.error?.message ?? result.stderr.trim()}`, file)
    }
    return readFileSync(out)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function embedImage(spec: string, rect: Array<string | undefined>, crop: CropFn, screenDir: string): string {
  const file = isAbsolute(spec) ? spec : resolve(screenDir, spec)
  const mime = MIME_BY_EXTENSION[extname(file).toLowerCase()]
  if (!mime) throw new CompanionError(`unsupported image type: ${extname(file) || '(none)'}`, file)
  if (!existsSync(file)) throw new CompanionError('image not found', file)
  const [x, y, w, h] = rect.map(Number) as [number, number, number, number]
  const bytes = rect[0] === undefined ? readFileSync(file) : crop(file, x, y, w, h)
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Returns a copy of `screen` with every `{{img:path}}` or `{{img:path@x,y,w,h}}` in a string value
 * replaced by a data URI. Relative paths resolve against `screenDir`; the optional crop is in image
 * pixels. Throws a {@link CompanionError} naming the file when an image is missing or unreadable.
 */
export function inlineImages(screen: unknown, screenDir: string, crop: CropFn = sipsCrop): unknown {
  if (typeof screen === 'string') {
    return screen.replace(PLACEHOLDER, (_match, spec: string, ...rect: Array<string | undefined>) =>
      embedImage(spec, rect.slice(0, 4), crop, screenDir),
    )
  }
  if (Array.isArray(screen)) return screen.map((item) => inlineImages(item, screenDir, crop))
  if (typeof screen === 'object' && screen !== null) {
    return Object.fromEntries(Object.entries(screen).map(([key, value]) => [key, inlineImages(value, screenDir, crop)]))
  }
  return screen
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function usageError(message: string): number {
  emit({ error: 'usage', message })
  return 2
}

function runCompanion(companion: string, args: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync('python3', [companion, ...args], { stdio: 'inherit', env })
  if (result.error) {
    emit({ error: 'python3-failed', message: result.error.message, path: companion })
    return 2
  }
  return result.status ?? 2
}

function buildScreen(sessionDir: string, screenFile: string): string {
  let screen: unknown
  try {
    screen = JSON.parse(readFileSync(screenFile, 'utf8'))
  } catch (error) {
    throw new CompanionError(`cannot read screen JSON: ${(error as Error).message}`, screenFile)
  }
  const built = inlineImages(screen, resolve(screenFile, '..'))
  const text = JSON.stringify(built)
  const builtPath = join(sessionDir, 'built', basename(screenFile))
  if (Buffer.byteLength(text) > MAX_BUILT_BYTES) {
    throw new CompanionError('built screen is over 8 MB; crop or downscale the screenshots', builtPath)
  }
  mkdirSync(join(sessionDir, 'built'), { recursive: true })
  writeFileSync(builtPath, text)
  return builtPath
}

/** Runs one command (`locate`, `start`, `show`, `wait`, `stop`) and returns the process exit code. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [command, ...rest] = argv
  const location = { CLAUDE_PLUGIN_ROOT: env.CLAUDE_PLUGIN_ROOT, HOME: env.HOME ?? '' }
  const search = searchCompanion(location)

  if (command === 'locate') {
    if (rest.length > 0) return usageError('locate takes no arguments')
    if (!search.found) {
      emit({ error: 'companion-not-found', searched: search.searched })
      return 2
    }
    emit({ companion: search.found })
    return 0
  }

  const takesSession = command === 'start' || command === 'wait' || command === 'stop'
  if (!takesSession && command !== 'show') {
    return usageError('usage: companion.ts locate | start <session-dir> | show <session-dir> <screen.json> | wait <session-dir> [--timeout <seconds>] | stop <session-dir>')
  }
  if (takesSession ? rest.length < 1 : rest.length !== 2) {
    return usageError(takesSession ? `${command} needs <session-dir>` : 'show needs <session-dir> <screen.json>')
  }
  if (!search.found) {
    emit({ error: 'companion-not-found', searched: search.searched })
    return 2
  }

  if (takesSession) return runCompanion(search.found, [command, ...rest], env)

  const [sessionDir, screenFile] = rest as [string, string]
  try {
    return runCompanion(search.found, ['show', sessionDir, buildScreen(sessionDir, screenFile)], env)
  } catch (error) {
    if (!(error instanceof CompanionError)) throw error
    emit({ error: error.message, path: error.path })
    return 2
  }
}

if (import.meta.main) process.exitCode = main(Bun.argv.slice(2))
