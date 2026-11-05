#!/usr/bin/env bun
/**
 * Reports where a redesign run stands: which checkout it is in and which phase its spec folder
 * says to resume at. Prints one `SpecFolderStatus` JSON object on stdout; diagnostics go to stderr.
 * Exit 0 for a valid slug, 2 for bad arguments or when the working directory is not a git checkout.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SpecFolderStatus } from './contracts'

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const SPECS_DIR = 'docs/quirk/specs'
const SPEC_FILES = ['current-state.md', 'goals.json', 'seed.sh', 'logic.md', 'tech.md', 'comparison.md'] as const
const REQUIRED_BY_PHASE = [
  ['current-state.md', 'before-pass'],
  ['logic.md', 'brainstorm'],
  ['comparison.md', 'build']
] as const

class EnvironmentError extends Error {}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new EnvironmentError(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function findFolder(root: string, slug: string): string | null {
  const suffix = `-${slug}-redesign`
  const specsRoot = join(root, SPECS_DIR)
  if (!existsSync(specsRoot)) return null
  const dated = readdirSync(specsRoot)
    .filter((name) => name.endsWith(suffix) && DATE_PATTERN.test(name.slice(0, -suffix.length)))
    .sort()
  return dated.length > 0 ? dated[dated.length - 1] : null
}

/**
 * The status of `slug`'s spec folder, as seen from the git checkout containing `cwd`. `folder` is
 * relative to the checkout root: the newest existing `<date>-<slug>-redesign` folder, or the path
 * a new one would take with `date`. Throws when `cwd` is not inside a git checkout.
 */
export function specFolderStatus(cwd: string, slug: string, date: string): SpecFolderStatus {
  const root = git(cwd, 'rev-parse', '--show-toplevel')
  const gitDir = resolve(cwd, git(cwd, 'rev-parse', '--git-dir'))
  const commonDir = resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir'))
  const existing = findFolder(root, slug)
  const name = existing ?? `${date}-${slug}-redesign`
  const dir = join(root, SPECS_DIR, name)
  const files = Object.fromEntries(SPEC_FILES.map((file) => [file, existing !== null && existsSync(join(dir, file))])) as SpecFolderStatus['files']
  const missing = REQUIRED_BY_PHASE.find(([file]) => !files[file])
  return {
    checkout: gitDir === commonDir ? 'main' : 'worktree',
    branch: git(cwd, 'branch', '--show-current') || 'HEAD',
    folder: `${SPECS_DIR}/${name}`,
    exists: existing !== null,
    files,
    resumeAt: missing ? missing[1] : 'done'
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.stdout.write(`${JSON.stringify({ error: message })}\n`)
  process.exit(2)
}

function parseArguments(argv: string[]): { slug: string; date: string } {
  let slug: string | undefined
  let date = localDate()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--date') {
      const value = argv[index + 1]
      if (value === undefined || !DATE_PATTERN.test(value)) fail('--date needs a value like 2026-11-05')
      date = value
      index += 1
    } else if (argument.startsWith('--')) {
      fail(`unknown option ${argument}`)
    } else if (slug === undefined) {
      slug = argument
    } else {
      fail('expected one feature slug')
    }
  }
  if (slug === undefined) fail('usage: spec-folder.ts <feature-slug> [--date YYYY-MM-DD]')
  if (!SLUG_PATTERN.test(slug)) fail(`slug must be kebab-case (${SLUG_PATTERN.source}), got ${JSON.stringify(slug)}`)
  return { slug, date }
}

if (import.meta.main) {
  const { slug, date } = parseArguments(process.argv.slice(2))
  try {
    process.stdout.write(`${JSON.stringify(specFolderStatus(process.cwd(), slug, date))}\n`)
  } catch (error) {
    if (error instanceof EnvironmentError) fail(error.message)
    throw error
  }
}
