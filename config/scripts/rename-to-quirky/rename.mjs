#!/usr/bin/env node
/**
 * Renames Orca to Quirky across the tracked tree, deterministically.
 *
 *   node config/scripts/rename-to-quirky/rename.mjs [--dry-run] [--report <file>]
 *        [--root <dir>] [--allowlist <file>]
 *
 * Rewrites the content of tracked text files and `git mv`s every tracked path
 * containing `orca`, using mapping.mjs. Files matching the allowlist's skipPaths
 * are neither edited nor moved; keepTokens are never rewritten. Binary files are
 * never edited. A second run changes nothing.
 *
 * Writes a JSON report ({ filesChanged, matchesByFile, pathMoves,
 * suspiciousMatches, skippedByAllowlist }) to --report, else to stdout. With
 * --dry-run nothing on disk changes.
 *
 * Everything is planned in memory first; a collision exits 1 before anything on
 * disk changes. Path moves are applied before content edits, and a failure
 * part-way prints the command that restores the tree and exits 1.
 *
 * Exit codes: 0 success, 1 path collision or failure part-way, 2 bad arguments
 * or allowlist.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  REPO_ROOT,
  UsageError,
  createGlobMatcher,
  isRegularFile,
  listTrackedFiles,
  loadAllowlist,
  readTextFile,
  resolveAllowlistFile
} from './allowlist.mjs'
import { applyMapping } from './mapping.mjs'
import { planPathMoves } from './plan-moves.mjs'

function parseArgs(argv) {
  const options = { dryRun: false, report: null, root: REPO_ROOT, allowlist: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--report' || arg === '--root' || arg === '--allowlist') {
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

function pathExists(absPath) {
  try {
    lstatSync(absPath)
    return true
  } catch {
    return false
  }
}

function removeEmptyParents(root, relDir) {
  let dir = relDir
  while (dir && dir !== '.') {
    try {
      if (readdirSync(join(root, dir)).length > 0) {
        return
      }
      rmdirSync(join(root, dir))
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

function run(options) {
  const root = resolve(options.root)
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new UsageError(`root is not a directory: ${root}`)
  }
  const allowlist = loadAllowlist(resolveAllowlistFile(root, options.allowlist))
  let tracked
  try {
    tracked = listTrackedFiles(root)
  } catch {
    throw new UsageError(`root is not a git repository: ${root}`)
  }
  const onDisk = tracked.filter((path) => pathExists(join(root, path)))
  const isSkipped = createGlobMatcher(allowlist.skipPaths)
  const skipped = onDisk.filter(isSkipped)
  const candidates = onDisk.filter((path) => !isSkipped(path))
  const { keepTokens } = allowlist

  let keepTokenHits = 0
  const edits = []
  const matchesByFile = {}
  const suspiciousMatches = []

  for (const path of candidates) {
    const abs = join(root, path)
    if (!isRegularFile(abs)) {
      continue
    }
    const text = readTextFile(abs)
    if (text === null) {
      continue
    }
    const result = applyMapping(text, { relPath: path, keepTokens })
    keepTokenHits += result.keepHits
    if (result.text === text) {
      continue
    }
    edits.push({ path, text: result.text })
    matchesByFile[path] = result.count
    for (const { line, text: lineText } of result.suspicious) {
      suspiciousMatches.push({ file: path, line, text: lineText })
    }
  }

  const mapPath = (path) => applyMapping(path, { keepTokens }).text
  const trackedSet = new Set(tracked)
  const plan = planPathMoves(candidates, mapPath, (path) => {
    if (trackedSet.has(path)) {
      return 'file'
    }
    try {
      return lstatSync(join(root, path)).isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  })
  for (const { from } of plan.moves) {
    for (const { line, text } of applyMapping(from, { keepTokens }).suspicious) {
      suspiciousMatches.push({ file: from, line: line - 1, text })
    }
  }

  const report = {
    filesChanged: edits.length,
    matchesByFile,
    pathMoves: plan.moves,
    suspiciousMatches,
    skippedByAllowlist: { paths: skipped.length, keepTokenHits }
  }

  if (plan.collisions.length > 0) {
    for (const { from, to, reason } of plan.collisions) {
      console.error(`collision: ${from} -> ${to} (${reason})`)
    }
    return { report, exitCode: 1 }
  }

  if (!options.dryRun) {
    const movedTo = new Map(plan.moves.map(({ from, to }) => [from, to]))
    try {
      for (const { from, to } of plan.moves) {
        mkdirSync(dirname(join(root, to)), { recursive: true })
        execFileSync('git', ['-C', root, 'mv', '--', from, to], { stdio: ['ignore', 'ignore', 'pipe'] })
        removeEmptyParents(root, dirname(from))
      }
      for (const edit of edits) {
        writeFileSync(join(root, movedTo.get(edit.path) ?? edit.path), edit.text)
      }
    } catch (error) {
      const quoted = `'${root.replaceAll("'", `'\\''`)}'`
      console.error(`rename failed part-way: ${error.stderr?.toString().trim() || error.message}`)
      console.error(`restore the tree with: git -C ${quoted} reset --hard && git -C ${quoted} clean -fd`)
      return { report, exitCode: 1 }
    }
  }
  return { report, exitCode: 0 }
}

function main() {
  let options
  let outcome
  try {
    options = parseArgs(process.argv.slice(2))
    outcome = run(options)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
  const json = `${JSON.stringify(outcome.report, null, 2)}\n`
  if (options.report) {
    writeFileSync(options.report, json)
    const { filesChanged, pathMoves } = outcome.report
    console.log(`${options.dryRun ? 'dry run: ' : ''}${filesChanged} files changed, ${pathMoves.length} paths moved`)
  } else {
    process.stdout.write(json)
  }
  process.exit(outcome.exitCode)
}

main()
