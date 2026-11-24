#!/usr/bin/env node

/**
 * Runs the test suite in throwaway containers, optionally on a remote Docker host.
 *
 * Each shard gets its own container built from config/docker/test-sandbox, fed the
 * current working tree over stdin. Nothing is mounted from the host, so a shard
 * cannot see another shard's temp files, git config, or build output.
 *
 * Usage:
 *   node config/scripts/run-sandboxed-test-shards.mjs [options] [-- extra vitest args]
 *
 * Options:
 *   --lane=unit|shell|e2e   Which suite to run (default: unit)
 *   --shards=N              Shard count for the unit and e2e lanes (default: 16)
 *   --jobs=N                Containers to run concurrently (default: shards)
 *   --only=1,4,9            Run just these shard numbers
 *   --node=24               Node major version baked into the image (default: 24)
 *   --docker-host=URL       Docker endpoint, e.g. ssh://user@buildbox
 *                           (defaults to $QUIRKY_SANDBOX_DOCKER_HOST)
 *   --docker-socket         Mount the host Docker socket (git-compat and ssh e2e lanes)
 *   --logs=DIR              Where to write per-shard logs (default: .quirky-sandbox-logs)
 *   --env KEY=VALUE         Extra environment variable for every shard (repeatable)
 *   --rebuild               Rebuild the image even if the tag already exists
 *   --keep-failed           Leave failed containers behind for inspection
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PROJECT_DIR = path.resolve(import.meta.dirname, '../..')

/** Files the image build needs; everything else reaches the container at run time. */
const IMAGE_CONTEXT_ROOTS = [
  '.npmrc',
  'config/docker/test-sandbox',
  'config/patches',
  // pnpm-workspace.yaml names it, so install fails without it.
  'config/pnpmfile.cjs',
  'config/scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  // install-electron-package-binary.mjs re-exports its zip extractor from here.
  'src/shared/zip-extractor-command.ts',
  // Workspace packages: pnpm install links them, and image-build scripts import @quirky/process-host.
  'src/packages',
  'native/windows-registry/package.json',
  'native/windows-security/package.json'
]

/** The real-shell contracts the unit shards exclude, run serially. */
const SHELL_CONTRACT_SPECS = [
  'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts',
  'src/main/daemon/shell-ready.test.ts',
  'src/main/daemon/node-pty-fd-leak.test.ts',
  'src/main/providers/local-pty-shell-ready-zsh-launch-environment.test.ts',
  'src/main/providers/__tests__/shell-ready-framework-example.test.ts',
  'src/main/pty/codex-shell-launch-preflight.test.ts',
  'src/main/pty/codex-shell-no-daemon.test.ts',
  'src/main/pty/omp-shell-wrapper-alias-safety.test.ts',
  'src/main/pty/omp-shell-wrapper.node-pty.test.ts',
  'src/main/fish-xdg-data-dirs-handoff.test.ts',
  'src/main/shell-startup-feature-channel.test.ts',
  'src/main/zsh-deferred-startup-line-init.live-shell.test.ts',
  'src/main/terminal-history-fish-session.node-pty.test.ts',
  'src/main/zsh-scoped-histfile.live-shell.test.ts',
  'src/main/zsh-startup-hook-user-config-equivalence.live-shell.test.ts',
  'src/main/runtime/structured-session-cli-login-shell.live-shell.test.ts',
  'src/renderer/src/components/terminal-pane/fish-color-scheme-child-stdin.node-pty.test.ts',
  'src/shared/fish-query-reply-child-stdin.node-pty.test.ts',
  'src/shared/pty-reply-echo-shapes.node-pty.test.ts',
  'src/shared/startup-shell-portability.live-shell.test.ts',
  'src/shared/posix-command-path-lookup.test.ts'
]

/** CI's unit shards set this so the vitest config applies UNIT_EXCLUDE (shell contracts, relay regions, cross-version). */
const UNIT_SHARD_ENV = 'QUIRKY_BALANCE_UNIT_SHARDS=1'

const LANES = new Set(['unit', 'shell', 'e2e'])

/** related/files selection above this file count splits across buckets instead of one container. */
export const RELATED_SINGLE_CONTAINER_MAX = 300

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

function main() {
  const options = readOptions()
  const dockerEnv = options.dockerHost
    ? { ...process.env, DOCKER_HOST: options.dockerHost }
    : process.env

  requireDocker(dockerEnv)

  const imageTag = `quirky-test-sandbox:${computeImageDigest(options.nodeMajor)}`
  if (options.rebuild || !imageExists(imageTag, dockerEnv)) {
    buildImage(imageTag, options, dockerEnv)
  } else {
    console.log(`Reusing image ${imageTag}`)
  }

  const sourceTarPath = options.sourceRef
    ? createSourceRefTar(options.sourceRef)
    : createSourceTar()
  mkdirSync(options.logsDir, { recursive: true })

  const workItems = options.select ? selectionWorkItems(options) : shardWorkItems(options)
  console.log(
    `Running lane "${options.lane}" as ${workItems.length} shard(s), ${options.jobs} at a time` +
      `${options.dockerHost ? ` on ${options.dockerHost}` : ''}`
  )

  runShards({ workItems, options, imageTag, sourceTarPath, dockerEnv })
    .then((results) => {
      rmSync(path.dirname(sourceTarPath), { recursive: true, force: true })
      report(results, options.logsDir)
      process.exit(results.some((result) => result.code !== 0) ? 1 : 0)
    })
    .catch((error) => {
      rmSync(path.dirname(sourceTarPath), { recursive: true, force: true })
      console.error(error)
      process.exit(1)
    })
}

function readOptions() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      lane: { type: 'string', default: 'unit' },
      shards: { type: 'string', default: '16' },
      jobs: { type: 'string' },
      only: { type: 'string' },
      node: { type: 'string', default: '24' },
      'docker-host': { type: 'string' },
      'docker-socket': { type: 'boolean', default: false },
      logs: { type: 'string', default: '.quirky-sandbox-logs' },
      env: { type: 'string', multiple: true, default: [] },
      rebuild: { type: 'boolean', default: false },
      'keep-failed': { type: 'boolean', default: false },
      select: { type: 'string' },
      'files-from': { type: 'string' },
      'source-ref': { type: 'string' }
    }
  })

  if (!LANES.has(values.lane)) {
    fail(`--lane must be one of ${[...LANES].join(', ')}`)
  }

  let selectionMode
  try {
    selectionMode = parseSelectMode(values)
  } catch (error) {
    fail(error.message)
  }

  let selection = null
  if (selectionMode.select) {
    try {
      selection = readSelectionList(path.resolve(process.cwd(), selectionMode.filesFrom))
    } catch (error) {
      fail(error.message)
    }
  }

  const shardTotal = values.lane === 'shell' ? 1 : readPositiveInteger(values.shards, '--shards')
  const jobs = values.jobs ? readPositiveInteger(values.jobs, '--jobs') : shardTotal

  return {
    lane: values.lane,
    shardTotal,
    jobs: Math.min(jobs, shardTotal),
    only: values.only
      ? values.only.split(',').map((entry) => readPositiveInteger(entry, '--only'))
      : null,
    nodeMajor: readPositiveInteger(values.node, '--node'),
    dockerHost: resolveDockerHost(values['docker-host']),
    mountDockerSocket: values['docker-socket'],
    logsDir: path.resolve(PROJECT_DIR, values.logs),
    extraEnv: values.env.map(readEnvPair),
    rebuild: values.rebuild,
    keepFailed: values['keep-failed'],
    select: selectionMode.select,
    selection,
    sourceRef: values['source-ref'] || null,
    extraArgs: positionals
  }
}

/**
 * Validates that `--select` and `--files-from` are used together, since the new
 * modes need both to know what to run and where the path list lives.
 */
export function parseSelectMode(values) {
  const rawSelect = values.select
  const filesFrom = values['files-from']

  if (rawSelect === undefined && filesFrom === undefined) {
    return { select: null, filesFrom: null }
  }
  if (rawSelect === undefined) {
    throw new Error('--files-from requires --select=related or --select=files')
  }
  if (rawSelect !== 'related' && rawSelect !== 'files') {
    throw new Error(`--select must be "related" or "files", got "${rawSelect}"`)
  }
  if (filesFrom === undefined) {
    throw new Error('--select requires --files-from')
  }
  if (values.lane !== undefined && values.lane !== 'unit') {
    throw new Error(`--select applies only to the unit lane, not --lane=${values.lane}`)
  }
  return { select: rawSelect, filesFrom }
}

/**
 * Reads and validates a `--files-from` list: every entry must be a repo-relative
 * path inside PROJECT_DIR, since the container has no notion of the host filesystem.
 */
export function readSelectionList(filesFromPath) {
  if (!existsSync(filesFromPath)) {
    throw new Error(`--files-from file not found: ${filesFromPath}`)
  }
  const paths = readFileSync(filesFromPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (paths.length === 0) {
    throw new Error(`--files-from file has no paths after trimming blank lines: ${filesFromPath}`)
  }

  for (const file of paths) {
    if (file.startsWith('-')) {
      throw new Error(`--files-from entries must not start with "-", got "${file}"`)
    }
    if (path.isAbsolute(file)) {
      throw new Error(`--files-from entries must be repo-relative, got "${file}"`)
    }
    const resolved = path.resolve(PROJECT_DIR, file)
    if (resolved !== PROJECT_DIR && !resolved.startsWith(`${PROJECT_DIR}${path.sep}`)) {
      throw new Error(`--files-from entry escapes the project directory: "${file}"`)
    }
  }
  return paths
}

/**
 * Resolves the Docker endpoint, refusing to default to the local daemon — an unset host
 * would otherwise run every shard on the workstation the sandbox exists to keep free.
 */
function resolveDockerHost(flagValue) {
  const host = flagValue || process.env.QUIRKY_SANDBOX_DOCKER_HOST
  if (host) {
    return host
  }
  if (process.env.DOCKER_HOST) {
    return null
  }
  fail(
    'no Docker host resolved. Set QUIRKY_SANDBOX_DOCKER_HOST, or pass --docker-host explicitly ' +
      '(config/docker/test-sandbox/README.md). Refusing to fall back to the local daemon.'
  )
}

function readPositiveInteger(raw, flag) {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${flag} must be a positive integer, got "${raw}"`)
  }
  return parsed
}

function readEnvPair(raw) {
  const separator = raw.indexOf('=')
  if (separator < 1) {
    fail(`--env expects KEY=VALUE, got "${raw}"`)
  }
  return raw
}

function requireDocker(dockerEnv) {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    env: dockerEnv
  })
  if (probe.status !== 0) {
    fail(`cannot reach the Docker daemon: ${(probe.stderr || probe.error?.message || '').trim()}`)
  }
  console.log(`Docker daemon ${probe.stdout.trim()}`)
}

/** Tags the image by its inputs so a dependency bump cannot be tested against a stale tree. */
function computeImageDigest(nodeMajor) {
  const hash = createHash('sha256')
  hash.update(`node:${nodeMajor}\0`)
  for (const file of listContextFiles()) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(path.join(PROJECT_DIR, file)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

function listContextFiles() {
  return trackedFiles().filter((file) =>
    IMAGE_CONTEXT_ROOTS.some((root) => file === root || file.startsWith(`${root}/`))
  )
}

/**
 * Tracked plus untracked-but-not-ignored files, so uncommitted work is what runs.
 * Ignoring gitignored paths is what keeps a stale local out/ from reaching the sandbox.
 */
function trackedFiles() {
  const listing = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )
  if (listing.status !== 0) {
    fail(`git ls-files failed: ${(listing.stderr || '').trim()}`)
  }
  return listing.stdout
    .split('\0')
    .filter((file) => file.length > 0 && existsSync(path.join(PROJECT_DIR, file)))
}

function imageExists(imageTag, dockerEnv) {
  const probe = spawnSync('docker', ['image', 'inspect', imageTag], {
    stdio: 'ignore',
    env: dockerEnv
  })
  return probe.status === 0
}

function buildImage(imageTag, options, dockerEnv) {
  console.log(`Building ${imageTag} (node ${options.nodeMajor})`)
  const contextTar = writeTar(listContextFiles(), 'quirky-sandbox-context-')
  addRootDockerfile(contextTar)
  const stdin = openSync(contextTar, 'r')
  const build = spawnSync(
    'docker',
    ['build', '--tag', imageTag, '--build-arg', `NODE_MAJOR=${options.nodeMajor}`, '-'],
    { stdio: [stdin, 'inherit', 'inherit'], env: dockerEnv }
  )
  rmSync(path.dirname(contextTar), { recursive: true, force: true })
  if (build.status !== 0) {
    fail('image build failed')
  }
}

/**
 * Copies the Dockerfile to the context root so `docker build -` finds it by default,
 * because --file against a stdin context is what makes buildx misread the archive.
 */
function addRootDockerfile(tarPath) {
  const stagingDir = path.dirname(tarPath)
  copyFileSync(
    path.join(PROJECT_DIR, 'config/docker/test-sandbox/Dockerfile'),
    path.join(stagingDir, 'Dockerfile')
  )
  const append = spawnSync(
    'tar',
    ['-r', '--format', 'ustar', '-f', tarPath, '-C', stagingDir, 'Dockerfile'],
    {
      encoding: 'utf8',
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    }
  )
  if (append.status !== 0) {
    fail(`could not add the Dockerfile to the build context: ${(append.stderr || '').trim()}`)
  }
}

function createSourceTar() {
  return writeTar(trackedFiles(), 'quirky-sandbox-source-')
}

/** Tars a git tree-ish (e.g. the merge base) for the base-check leg, unrelated to the working tree. */
function createSourceRefTar(sourceRef) {
  const stagingDir = mkdtempSync(path.join(tmpdir(), 'quirky-sandbox-ref-'))
  const tarPath = path.join(stagingDir, 'context.tar')
  // A file, not a pipe, so this matches writeTar()'s stdin-fd pattern for runShard().
  const archive = spawnSync('git', ['archive', '--format=tar', '--output', tarPath, sourceRef], {
    cwd: PROJECT_DIR,
    encoding: 'utf8'
  })
  if (archive.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true })
    fail(`git archive failed for "${sourceRef}": ${(archive.stderr || '').trim()}`)
  }
  return tarPath
}

/**
 * Copies a source tar and appends the selection list at the fixed container path
 * `.quirky-sandbox/selection.txt`, so the path list travels inside stdin rather than argv
 * (argv hits ARG_MAX for a large selection).
 */
export function buildSelectionTar(baseTarPath, paths) {
  const stagingDir = mkdtempSync(path.join(tmpdir(), 'quirky-sandbox-selection-'))
  const tarPath = path.join(stagingDir, 'context.tar')
  copyFileSync(baseTarPath, tarPath)
  const selectionDir = path.join(stagingDir, '.quirky-sandbox')
  mkdirSync(selectionDir, { recursive: true })
  writeFileSync(path.join(selectionDir, 'selection.txt'), `${paths.join('\n')}\n`)
  const append = spawnSync(
    'tar',
    ['-r', '--format', 'ustar', '-f', tarPath, '-C', stagingDir, '.quirky-sandbox/selection.txt'],
    {
      encoding: 'utf8',
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    }
  )
  if (append.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true })
    fail(`could not add the selection list to the sandbox tar: ${(append.stderr || '').trim()}`)
  }
  return tarPath
}

function writeTar(files, prefix) {
  const stagingDir = mkdtempSync(path.join(tmpdir(), prefix))
  const listPath = path.join(stagingDir, 'files.txt')
  const tarPath = path.join(stagingDir, 'context.tar')
  writeFileSync(listPath, `${files.join('\0')}\0`)
  const archive = spawnSync(
    'tar',
    ['-c', '--format', 'ustar', '-f', tarPath, '--null', '-T', listPath],
    {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      // Otherwise bsdtar stores xattrs as AppleDouble entries that extract on Linux as
      // real ._ files, and Vitest collects every ._*.test.ts as an unparseable suite.
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    }
  )
  if (archive.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true })
    fail(`tar failed: ${(archive.stderr || '').trim()}`)
  }
  return tarPath
}

function resolveShards(options) {
  const all = Array.from({ length: options.shardTotal }, (_, index) => index + 1)
  if (!options.only) {
    return all
  }
  const invalid = options.only.filter((shard) => shard > options.shardTotal)
  if (invalid.length > 0) {
    fail(`--only refers to shard(s) beyond --shards=${options.shardTotal}: ${invalid.join(', ')}`)
  }
  return options.only
}

/**
 * Splits a related/files selection into containers: one container for a selection at or
 * under RELATED_SINGLE_CONTAINER_MAX, otherwise up to 3 (the host's proven limit).
 */
export function resolveSelectionBuckets(paths, jobs) {
  if (paths.length === 0) {
    return []
  }
  if (paths.length <= RELATED_SINGLE_CONTAINER_MAX) {
    return [paths]
  }
  const bucketCount = Math.min(jobs, 3)
  const buckets = Array.from({ length: bucketCount }, () => [])
  paths.forEach((file, index) => buckets[index % bucketCount].push(file))
  return buckets
}

function shardWorkItems(options) {
  return resolveShards(options).map((shard) => ({
    id: shard,
    total: options.shardTotal,
    logPath: path.join(options.logsDir, `${options.lane}-shard-${shard}.log`),
    selectionPaths: null
  }))
}

function selectionWorkItems(options) {
  const buckets = resolveSelectionBuckets(options.selection, options.jobs)
  return buckets.map((paths, index) => ({
    id: index + 1,
    total: buckets.length,
    logPath: path.join(options.logsDir, `unit-bucket-${index + 1}.log`),
    selectionPaths: paths
  }))
}

async function runShards({ workItems, options, imageTag, sourceTarPath, dockerEnv }) {
  const results = []
  const queue = [...workItems]
  const workers = Array.from({ length: options.jobs }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      results.push(await runShard({ item, options, imageTag, sourceTarPath, dockerEnv }))
    }
  })
  await Promise.all(workers)
  return results.sort((left, right) => left.shard - right.shard)
}

function runShard({ item, options, imageTag, sourceTarPath, dockerEnv }) {
  const containerName = `quirky-test-${options.lane}-${item.id}-${process.pid}`
  const logFd = openSync(item.logPath, 'w')
  const startedAt = Date.now()
  const stdinTarPath = item.selectionPaths
    ? buildSelectionTar(sourceTarPath, item.selectionPaths)
    : sourceTarPath

  const dockerArgs = [
    'run',
    '--interactive',
    // Without an init as PID 1, orphaned descendants stay zombies, and process-group tests read them as alive.
    '--init',
    // CI sets this for every test; without it browser and real-process suites try to show windows.
    '--env',
    'QUIRKY_BACKGROUND_LAUNCH=1',
    ...(options.keepFailed ? ['--name', containerName] : ['--rm']),
    ...laneEnvArgs(options.lane),
    ...options.extraEnv.flatMap((pair) => ['--env', pair]),
    ...(options.mountDockerSocket ? ['--volume', '/var/run/docker.sock:/var/run/docker.sock'] : []),
    imageTag,
    ...laneCommand(options, item.id)
  ]

  return new Promise((resolve) => {
    const child = spawn('docker', dockerArgs, {
      stdio: [openSync(stdinTarPath, 'r'), logFd, logFd],
      env: dockerEnv
    })
    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt
      console.log(
        `${code === 0 ? 'pass' : 'FAIL'}  shard ${item.id}/${item.total}  ` +
          `${formatDuration(durationMs)}  ${path.relative(PROJECT_DIR, item.logPath)}`
      )
      if (item.selectionPaths) {
        rmSync(path.dirname(stdinTarPath), { recursive: true, force: true })
      }
      resolve({ shard: item.id, code: code ?? 1, durationMs, logPath: item.logPath })
    })
  })
}

export function laneEnvArgs(lane) {
  if (lane === 'unit') {
    return ['--env', UNIT_SHARD_ENV]
  }
  if (lane === 'shell') {
    // Otherwise the fish tests skip themselves and the lane reports green having run nothing.
    return ['--env', 'QUIRKY_REQUIRE_FISH=1']
  }
  if (lane === 'e2e') {
    return ['--env', 'QUIRKY_E2E_FORWARD_APP_LOGS=1', '--env', 'QUIRKY_E2E_WEB_CLIENT=1']
  }
  return []
}

export function laneCommand(options, shard) {
  if (options.lane === 'shell') {
    return [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'config/vitest.config.ts',
      '--maxWorkers=1',
      ...SHELL_CONTRACT_SPECS,
      ...options.extraArgs
    ]
  }

  if (options.lane === 'e2e') {
    return [
      'xvfb-run',
      '--auto-servernum',
      'pnpm',
      'run',
      'test:e2e',
      `--shard=${shard}/${options.shardTotal}`,
      ...options.extraArgs
    ]
  }

  if (options.select === 'related') {
    return selectionLaneCommand('related', ['--run', ...options.extraArgs])
  }
  if (options.select === 'files') {
    return selectionLaneCommand('run', options.extraArgs)
  }

  return [
    'pnpm',
    'exec',
    'vitest',
    'run',
    '--config',
    'config/vitest.config.ts',
    `--shard=${shard}/${options.shardTotal}`,
    ...options.extraArgs
  ]
}

/**
 * Builds the unit-lane related/files command as a shell script: the selected paths are
 * read from `.quirky-sandbox/selection.txt` at runtime rather than passed as argv, so a
 * large selection cannot hit ARG_MAX on `docker run`.
 */
function selectionLaneCommand(vitestSubcommand, tailArgs) {
  const headArgs = [
    'pnpm',
    'exec',
    'vitest',
    vitestSubcommand,
    '--config',
    'config/vitest.config.ts'
  ]
  const head = headArgs.map(shellSingleQuote).join(' ')
  const tail = tailArgs.map(shellSingleQuote).join(' ')
  const script = [
    'set -e',
    'set --',
    // POSIX-safe read of a possibly-unterminated last line, appending each path as a positional arg.
    'while IFS= read -r selected_path || [ -n "$selected_path" ]; do',
    '  [ -z "$selected_path" ] || set -- "$@" "$selected_path"',
    'done < .quirky-sandbox/selection.txt',
    `exec ${head} "$@"${tail ? ` ${tail}` : ''}`
  ].join('\n')
  return ['sh', '-c', script]
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function report(results, logsDir) {
  const failures = results.filter((result) => result.code !== 0)
  const slowest = [...results].sort((left, right) => right.durationMs - left.durationMs)[0]
  console.log('')
  console.log(`${results.length - failures.length}/${results.length} shard(s) passed`)
  if (slowest) {
    console.log(`slowest shard ${slowest.shard} at ${formatDuration(slowest.durationMs)}`)
  }
  if (failures.length > 0) {
    console.log(`failed shard(s): ${failures.map((result) => result.shard).join(', ')}`)
    console.log(`logs: ${path.relative(PROJECT_DIR, logsDir)}`)
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000)
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`
}

function fail(message) {
  console.error(`run-sandboxed-test-shards: ${message}`)
  process.exit(2)
}
