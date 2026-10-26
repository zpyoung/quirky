import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
