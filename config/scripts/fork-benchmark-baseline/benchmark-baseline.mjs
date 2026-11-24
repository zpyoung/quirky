import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcessSync } from '@quirky/process-host'

function git(root, args) {
  const result = runProcessSync({ program: 'git', args, cwd: root })
  if (result.code !== 0 || result.outputTruncated) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Whether the baseline commit has no copy of the benchmarked script.
 *
 * A sync PR adds scripts that its first parent (the fork's main) never had, so there is nothing
 * to compare them with. That is reported and recorded, not failed; a baseline that exists is never
 * skipped, and a git error still throws.
 */
export function announceMissingBaseline({ root, output, comparison, ref, file }) {
  if (git(root, ['ls-tree', '--name-only', ref, '--', file]) !== '') {
    return false
  }
  const sha = git(root, ['rev-parse', `${ref}^{commit}`])
  const message = `No baseline at ${sha}: ${file} is new in this PR, so ${comparison} has nothing to compare against.`
  console.log(`::notice title=No benchmark baseline::${message}`)
  console.log(message)
  mkdirSync(output, { recursive: true })
  writeFileSync(
    path.join(output, `no-baseline-${comparison}.json`),
    `${JSON.stringify({ comparison, baselineSha: sha, file, reason: message }, null, 2)}\n`
  )
  return true
}

/**
 * Clears `out/` before a timed smoke run, keeping the mobile web bundle: quirkyd refuses to build
 * without it, and building it is not part of what the smoke comparison measures.
 */
export function clearBuildOutputKeepingMobileWeb(root) {
  const output = path.join(root, 'out')
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.name !== 'mobile-web') {
      rmSync(path.join(output, entry.name), { recursive: true, force: true })
    }
  }
}

/**
 * Peak memory of the native TypeScript compiler per project on this repo, measured on 4 CPUs.
 * The node project alone needs about 13 GiB, so on a 16 GB runner no other project may run beside
 * it; the estimates in older typecheck scripts (7, 6, 2) let node run beside cli and kill the runner.
 */
const NATIVE_HEAP_GIB = {
  'tsconfig.node.json': 13,
  'tsconfig.tc.web.json': 10,
  'tsconfig.tc.cli.json': 3
}

/** Soft ceiling for the Go-based compiler so it collects garbage before the runner runs out. */
export const NATIVE_COMPILER_MEMORY_LIMIT = '10GiB'

/** The project list with the native compiler's measured heap in place of the registry's estimate. */
export function withNativeHeapEstimates(projects) {
  return projects.map((project) => {
    const estimate = NATIVE_HEAP_GIB[path.basename(project.config)]
    return estimate === undefined ? project : { ...project, heapGib: estimate }
  })
}

/** An older typecheck script's source, admitting projects by the measured heap instead of its own. */
export function withNativeHeapEstimatesInSource(source) {
  return Object.entries(NATIVE_HEAP_GIB).reduce(
    (current, [name, heapGib]) =>
      current.replace(
        new RegExp(`(config:\\s*'[^']*${name.replaceAll('.', '\\.')}',\\s*heapGib:\\s*)\\d+`),
        `$1${heapGib}`
      ),
    source
  )
}
