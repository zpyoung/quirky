import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const tempDirs: string[] = []

/** Creates a scratch directory that `removeTempDirs` deletes; never touches the real `~/.quirky`. */
export function makeTempDir(prefix = 'qd-plugins-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Deletes every directory created by `makeTempDir`; call from `afterEach`. */
export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Writes `<rootDir>/<dirName>/quirky-plugin.json` plus any extra files (paths relative to the
 * plugin directory) and returns the plugin directory. `dirName` defaults to the manifest's `id`;
 * pass it explicitly to test a directory that doesn't match the ID. A string manifest is written
 * verbatim, so tests can supply malformed JSON.
 */
export function writePlugin(
  rootDir: string,
  manifest: object | string,
  files: Record<string, string> = {},
  options: { dirName?: string } = {},
): string {
  const dirName = options.dirName ?? manifestId(manifest)
  const dir = join(rootDir, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'quirky-plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2))
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

function manifestId(manifest: object | string): string {
  const parsed = typeof manifest === 'string' ? tryParse(manifest) : manifest
  const id = (parsed as { id?: unknown } | null)?.id
  if (typeof id !== 'string') throw new Error('writePlugin needs options.dirName when the manifest has no string id')
  return id
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Statements spliced into the generated fixture module's `activate` and `deactivate`. */
export type ModuleBehavior = {
  /** Runs inside `activate(context)`, after the marker line. */
  activate?: string
  /** Runs inside `deactivate()`, after the marker line. */
  deactivate?: string
  omitActivate?: boolean
  omitDeactivate?: boolean
}

/** Statements that block an async function until `file` exists. */
export function waitForFile(file: string): string {
  return `while (!existsSync(${JSON.stringify(file)})) await Bun.sleep(5)`
}

/**
 * Source of a plugin main module that imports only node built-ins. It appends `import <id>`,
 * `activate <id>` and `deactivate <id>` lines to the marker file as each happens.
 */
export function moduleSource(marker: string, id: string, behavior: ModuleBehavior = {}): string {
  const lines = [
    "import { appendFileSync, existsSync } from 'node:fs'",
    `const record = (line: string) => appendFileSync(${JSON.stringify(marker)}, line + '\\n')`,
    `record('import ${id}')`,
  ]
  if (!behavior.omitActivate) {
    lines.push(
      'export async function activate(context: any) {',
      `  record('activate ${id}')`,
      `  ${behavior.activate ?? ''}`,
      '}',
    )
  }
  if (!behavior.omitDeactivate) {
    lines.push('export async function deactivate() {', `  record('deactivate ${id}')`, `  ${behavior.deactivate ?? ''}`, '}')
  }
  return lines.join('\n') + '\n'
}

/**
 * Writes a plugin whose `main.ts` is a `moduleSource` fixture. The manifest defaults to name
 * `id`, version 1.0.0 and `main: 'main.ts'`; `manifest` fields override them.
 */
export function writeModulePlugin(
  rootDir: string,
  marker: string,
  manifest: { id: string } & Record<string, unknown>,
  behavior: ModuleBehavior = {},
): string {
  return writePlugin(
    rootDir,
    { name: manifest.id, version: '1.0.0', main: 'main.ts', ...manifest },
    { 'main.ts': moduleSource(marker, manifest.id, behavior) },
  )
}

/** The marker file's lines in order, or an empty list when nothing has been recorded. */
export function readMarker(marker: string): string[] {
  try {
    return readFileSync(marker, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
