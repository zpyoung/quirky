import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { COPIED_ACCOUNT_DIRS } from './constants'

/** Paths this run created, so a failed run can remove exactly what it wrote. */
export type WrittenPaths = string[]

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to)
    } else if (entry.isFile()) {
      await copyFile(from, to)
      await chmod(to, 0o600)
    }
  }
}

/**
 * Copies each `claude-accounts/<id>`, `codex-accounts/<id>` and `claude-profiles/<id>` folder
 * that Quirky does not have yet. Each folder lands under a temporary name first, so a crash
 * leaves no half-copied account. Folders in `alreadyCopied` were brought over by an earlier run
 * and are never copied again, even if the owner has since deleted them. Returns the folders
 * copied, relative to their roots.
 */
export async function copyAccountDirs(
  sourceRoot: string,
  userDataPath: string,
  written: WrittenPaths,
  alreadyCopied: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const copied: string[] = []
  for (const root of COPIED_ACCOUNT_DIRS) {
    const sourceDir = join(sourceRoot, root)
    if (!existsSync(sourceDir)) {
      continue
    }
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }
      const destination = join(userDataPath, root, entry.name)
      if (alreadyCopied.has(join(root, entry.name)) || existsSync(destination)) {
        continue
      }
      if (!existsSync(join(userDataPath, root))) {
        written.push(join(userDataPath, root))
      }
      const staging = `${destination}.importing`
      await rm(staging, { recursive: true, force: true })
      written.push(staging)
      await copyTree(join(sourceDir, entry.name), staging)
      await rename(staging, destination)
      written.push(destination)
      copied.push(join(root, entry.name))
    }
  }
  return copied
}

/**
 * Copies `keybindings.json` into Quirky's home dir unless one is already there or an earlier
 * run already copied it.
 */
export async function copyKeybindings(
  sourceHome: string,
  quirkyHome: string,
  written: WrittenPaths,
  alreadyCopied: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const source = join(sourceHome, 'keybindings.json')
  const destination = join(quirkyHome, 'keybindings.json')
  if (alreadyCopied.has('keybindings.json') || !existsSync(source) || existsSync(destination)) {
    return []
  }
  const stat = await lstat(source)
  if (!stat.isFile()) {
    return []
  }
  if (!existsSync(quirkyHome)) {
    written.push(quirkyHome)
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const bytes = await readFile(source)
  await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' })
  written.push(destination)
  return ['keybindings.json']
}

/** Writes an already-sealed credential file into Quirky's home dir unless one is already there. */
export async function writeSealedFile(
  quirkyHome: string,
  name: string,
  content: string,
  written: WrittenPaths
): Promise<boolean> {
  const destination = join(quirkyHome, name)
  if (existsSync(destination)) {
    return false
  }
  if (!existsSync(quirkyHome)) {
    written.push(quirkyHome)
  }
  await mkdir(quirkyHome, { recursive: true, mode: 0o700 })
  await writeFile(destination, content, { mode: 0o600, flag: 'wx' })
  written.push(destination)
  return true
}

/** Removes everything a failed run wrote, newest first. */
export async function removeWritten(written: WrittenPaths): Promise<void> {
  for (const path of written.toReversed()) {
    await rm(path, { recursive: true, force: true })
  }
}
