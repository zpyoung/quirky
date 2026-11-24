#!/usr/bin/env node
/**
 * CI guard: fails when a tracked text file still says `orca` (any case).
 *
 *   node config/scripts/check-no-orca-strings.mjs [--root <dir>] [--allowlist <file>]
 *
 * Prints `file:line: text` per offending line. Files in the allowlist's
 * skipPaths are not scanned, keepTokens are ignored wherever they appear, and a
 * creditLines entry allows lines in its path that contain its match.
 *
 * Exit codes: 0 clean, 1 matches found, 2 bad arguments.
 */
import { join, resolve } from 'node:path'
import {
  REPO_ROOT,
  UsageError,
  createGlobMatcher,
  isRegularFile,
  listTrackedFiles,
  loadAllowlist,
  readTextFile,
  resolveAllowlistFile
} from './rename-to-quirky/allowlist.mjs'

function parseArgs(argv) {
  const options = { root: REPO_ROOT, allowlist: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root' || arg === '--allowlist') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${arg} needs a value`)
      }
      options[arg.slice(2)] = value
    } else {
      throw new UsageError(`unknown argument: ${arg}`)
    }
  }
  return options
}

function stripKeepTokens(line, keepTokens) {
  let stripped = line
  for (const token of keepTokens) {
    stripped = stripped.split(token).join('')
  }
  return stripped
}

function findViolations(options) {
  const root = resolve(options.root)
  const allowlist = loadAllowlist(resolveAllowlistFile(root, options.allowlist))
  const isSkipped = createGlobMatcher(allowlist.skipPaths)
  const creditsByPath = new Map()
  for (const { path, match } of allowlist.creditLines) {
    creditsByPath.set(path, [...(creditsByPath.get(path) ?? []), match])
  }

  let tracked
  try {
    tracked = listTrackedFiles(root)
  } catch {
    throw new UsageError(`root is not a git repository: ${root}`)
  }

  const violations = []
  for (const path of tracked) {
    const abs = join(root, path)
    if (isSkipped(path) || !isRegularFile(abs)) {
      continue
    }
    const text = readTextFile(abs)
    if (text === null) {
      continue
    }
    const credits = creditsByPath.get(path) ?? []
    text.split('\n').forEach((line, index) => {
      if (!/orca/i.test(stripKeepTokens(line, allowlist.keepTokens))) {
        return
      }
      if (credits.some((match) => line.includes(match))) {
        return
      }
      violations.push(`${path}:${index + 1}: ${line.trim().slice(0, 200)}`)
    })
  }
  return violations
}

function main() {
  let violations
  try {
    violations = findViolations(parseArgs(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
  if (violations.length > 0) {
    console.log(violations.join('\n'))
    console.error(`${violations.length} line(s) still mention orca`)
    process.exit(1)
  }
}

main()
