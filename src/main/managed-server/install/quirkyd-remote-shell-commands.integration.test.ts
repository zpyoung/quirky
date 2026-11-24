/**
 * Runs the generated POSIX commands through a real `/bin/sh`.
 *
 * The unit tests assert on command *text*, which is exactly the kind of test that stays
 * green while the shell it produces does not work — a quoting slip, a `case` pattern that
 * never matches, a `tar` invocation that silently captures nothing. These run the strings.
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../../persistence/profile-state/profile-state-documents'
import { openProfileStateDatabase } from '../../persistence/profile-state/profile-state-database'

import {
  quirkydLaunchCommand,
  quirkydLivenessAnswerBlocksGc,
  quirkydLivenessProbeCommand,
  parseQuirkydLiveness,
  parseQuirkydReadinessOutput
} from './quirkyd-remote-launch'
import { QUIRKYD_PID_FILENAME, QUIRKYD_READINESS_FILENAME } from './quirkyd-remote-host-support'
import {
  quirkydStopFreedTheHost,
  parseQuirkydStopOutcome,
  stopQuirkydCommand
} from './quirkyd-remote-process-control'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  quirkydReadinessWaitCommand,
  parseQuirkydReadinessWaitOutput
} from './quirkyd-remote-readiness-wait'
import {
  captureQuirkydStateSnapshotCommand,
  compareQuirkydStateSnapshotCommand,
  quirkydSnapshotIsUnchanged,
  parseQuirkydSnapshotCapture,
  parseQuirkydSnapshotRestore,
  probeQuirkydStateSnapshotCommand,
  restoreQuirkydStateSnapshotCommand
} from '../host-state/quirkyd-state-snapshot'
import {
  newestStateMtimeCommand,
  parseNewestStateMtimeSeconds
} from '../host-state/quirkyd-state-newest-mtime'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { QUIRKYD_STOP_REQUEST_FILENAME } from '../../../shared/quirkyd-stop-request'

const host = getRemoteHostPlatform('linux-x64')
let root = ''
let dataDir = ''
let snapshotDir = ''
// The ~/.quirky-remote stand-in that holds the state-mutation lock.
const baseDir = (): string => join(root, '.quirky-remote')
let versionDir = ''
const launchedPids = new Set<number>()

function sh(command: string): string {
  return execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirkyd-shell-'))
  dataDir = join(root, '.quirky')
  snapshotDir = join(root, 'snapshots', 'pre-0.2.0+bb01-1000')
  versionDir = join(root, '.quirky-remote', 'quirkyd-0.2.0+bb01')
  mkdirSync(join(dataDir, 'profiles', 'p1'), { recursive: true })
  mkdirSync(join(dataDir, 'daemon'), { recursive: true })
  mkdirSync(versionDir, { recursive: true })
  writeFileSync(join(dataDir, 'quirky-profile-index.json'), '{"v":"before"}')
  writeFileSync(join(dataDir, 'profiles', 'p1', 'quirky-data.json'), '{"repos":"before"}')
  writeFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'live-daemon-token')
})

afterEach(() => {
  for (const pid of launchedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Successful stops have already removed their test processes.
    }
  }
  launchedPids.clear()
  rmSync(root, { recursive: true, force: true })
})

async function launchTestRuntime(
  legacyWrapper = false,
  stopRequests = false,
  splitEntry = false
): Promise<{
  runtimePid: number
  recordedPid: number
  terminatedFile: string
}> {
  const terminatedFile = join(versionDir, 'terminated')
  const requestFile = join(versionDir, QUIRKYD_STOP_REQUEST_FILENAME)
  writeFileSync(
    join(versionDir, splitEntry ? 'quirkyd-server.js' : 'quirkyd.js'),
    [
      `const fs = require('node:fs');`,
      `process.on('SIGTERM', () => {`,
      `  fs.writeFileSync(${JSON.stringify(terminatedFile)}, 'terminated');`,
      `  process.exit(0);`,
      `});`,
      ...(stopRequests
        ? [
            // Like quirkyd's listener: consume the slot request, then stop.
            `setInterval(() => {`,
            `  if (fs.existsSync(${JSON.stringify(requestFile)})) {`,
            `    fs.unlinkSync(${JSON.stringify(requestFile)});`,
            `    fs.writeFileSync(${JSON.stringify(terminatedFile)}, 'requested');`,
            `    process.exit(0);`,
            `  }`,
            `}, 20);`
          ]
        : []),
      `console.log(JSON.stringify({type: 'quirky_server_ready', health: {pid: process.pid${
        stopRequests ? ', stopRequests: 1' : ''
      }}}));`,
      `setTimeout(() => process.exit(1), 10_000);`
    ].join('\n')
  )
  if (splitEntry) {
    writeFileSync(join(versionDir, 'quirkyd.js'), 'require("./quirkyd-server.js")')
  }
  let command = quirkydLaunchCommand(host, {
    remoteInstallDir: versionDir,
    nodePath: process.execPath,
    fullVersion: '0.2.0+bb01',
    userDataDir: dataDir,
    bindHost: '127.0.0.1',
    port: 0,
    activationRoot: join(dataDir, '.quirkyd-activation-transaction')
  })
  if (legacyWrapper) {
    // The trailing command retains the old macOS waiting-shell behavior on every POSIX shell.
    command = command
      .replace('exec nohup ', 'nohup ')
      .replace('< /dev/null &', '< /dev/null && : &')
  }
  execFileSync('/bin/sh', ['-c', command], { stdio: 'ignore', timeout: 5_000 })
  const recordedPid = Number(readFileSync(join(versionDir, QUIRKYD_PID_FILENAME), 'utf8').trim())
  expect(recordedPid).toBeGreaterThan(1)
  launchedPids.add(recordedPid)
  const readRuntimePid = (): number => {
    const parsed = parseQuirkydReadinessOutput(
      readFileSync(join(versionDir, QUIRKYD_READINESS_FILENAME), 'utf8')
    )
    return parsed.state === 'ready' ? (parsed.readiness.health?.pid ?? 0) : 0
  }
  await expect.poll(readRuntimePid, { timeout: 2_000, interval: 20 }).toBeGreaterThan(1)
  const runtimePid = readRuntimePid()
  launchedPids.add(runtimePid)
  return { runtimePid, recordedPid, terminatedFile }
}

function stopTestRuntime(justLaunched = false): ReturnType<typeof parseQuirkydStopOutcome> {
  return parseQuirkydStopOutcome(
    execFileSync(
      '/bin/sh',
      [
        '-c',
        stopQuirkydCommand(host, versionDir, {
          waitSeconds: 3,
          ...(justLaunched ? { justLaunched: true as const } : { nodePath: process.execPath })
        })
      ],
      { encoding: 'utf8', timeout: 5_000 }
    )
  )
}

describe('state snapshot commands, run for real', () => {
  it('detects candidate SQLite migration without modifying current state or the snapshot', () => {
    sh(captureQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
    const archive = readFileSync(join(snapshotDir, 'state.tar'))
    const compare = (): boolean =>
      quirkydSnapshotIsUnchanged(
        sh(compareQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    expect(compare()).toBe(true)
    writeFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'live-daemon-after-launch')
    expect(compare()).toBe(true)

    const databasePath = join(dataDir, 'profiles', 'p1', 'profile-state.db')
    const candidate = openProfileStateDatabase(databasePath, 'p1')
    try {
      importProfileStateJson(candidate.db, '{"settings":{"theme":"dark"}}')
    } finally {
      candidate.db.close()
    }
    const databaseBytes = readFileSync(databasePath)

    expect(compare()).toBe(false)
    expect(readFileSync(databasePath)).toEqual(databaseBytes)
    expect(readFileSync(join(snapshotDir, 'state.tar'))).toEqual(archive)
    expect(readFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'utf8')).toBe(
      'live-daemon-after-launch'
    )
  })

  it('requires an intact comparison snapshot before an older build can restart', () => {
    expect(
      quirkydSnapshotIsUnchanged(
        sh(compareQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    ).toBe(false)
    sh(captureQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
    writeFileSync(join(snapshotDir, 'state.tar'), 'not an archive')
    expect(
      quirkydSnapshotIsUnchanged(
        sh(compareQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    ).toBe(false)
    expect(readFileSync(join(dataDir, 'profiles', 'p1', 'quirky-data.json'), 'utf8')).toBe(
      '{"repos":"before"}'
    )
  })

  it('rejects symlinked profile state that a tar snapshot does not preserve', () => {
    const external = join(root, 'external-profile')
    mkdirSync(external)
    writeFileSync(join(external, 'quirky-data.json'), '{"before":true}')
    const profile = join(dataDir, 'profiles', 'linked')
    symlinkSync(external, profile)

    expect(
      parseQuirkydSnapshotCapture(
        sh(captureQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    ).toBe('failed')

    mkdirSync(snapshotDir, { recursive: true })
    execFileSync('tar', ['-C', dataDir, '-cf', join(snapshotDir, 'state.tar'), 'profiles'])
    writeFileSync(join(external, 'quirky-data.json'), '{"candidate":true}')
    expect(
      quirkydSnapshotIsUnchanged(
        sh(compareQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    ).toBe(false)
    expect(readFileSync(join(external, 'quirky-data.json'), 'utf8')).toBe('{"candidate":true}')
  })

  it('captures, then restores state the newer build overwrote', () => {
    expect(
      parseQuirkydSnapshotCapture(
        sh(captureQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    ).toBe('captured')
    expect(sh(probeQuirkydStateSnapshotCommand(host, snapshotDir, baseDir())).trim()).toBe(
      'PRESENT'
    )

    // The new version migrates the store and adds a file of its own.
    writeFileSync(join(dataDir, 'quirky-profile-index.json'), '{"v":"migrated"}')
    writeFileSync(join(dataDir, 'profiles', 'p1', 'new-build-only.json'), '{}')

    expect(
      parseQuirkydSnapshotRestore(
        sh(restoreQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    ).toBe('restored')
    expect(readFileSync(join(dataDir, 'quirky-profile-index.json'), 'utf8')).toBe('{"v":"before"}')
    // Removed before extraction, so the older build never sees a file it cannot interpret.
    expect(() => readFileSync(join(dataDir, 'profiles', 'p1', 'new-build-only.json'))).toThrow()
  })

  it('round-trips a quiescent SQLite profile database with its WAL sidecars', () => {
    const profileDirectory = join(dataDir, 'profiles', 'p1')
    const databasePath = join(profileDirectory, 'profile-state.db')
    const opened = openProfileStateDatabase(databasePath, 'p1')
    try {
      importProfileStateJson(
        opened.db,
        JSON.stringify({ settings: { theme: 'dark' }, snapshotMarker: 'before' })
      )
      // The connection remains open, so WAL/SHM are still part of the archive boundary while
      // the generated command reads the now-quiescent files.
      expect(existsSync(`${databasePath}-wal`)).toBe(true)
      expect(
        parseQuirkydSnapshotCapture(
          sh(captureQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
        )
      ).toBe('captured')
    } finally {
      opened.db.close()
    }

    const changed = openProfileStateDatabase(databasePath, 'p1')
    try {
      importProfileStateJson(
        changed.db,
        JSON.stringify({ settings: { theme: 'light' }, snapshotMarker: 'after' })
      )
    } finally {
      changed.db.close()
    }
    expect(
      parseQuirkydSnapshotRestore(
        sh(restoreQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
      )
    ).toBe('restored')

    const restored = openProfileStateDatabase(databasePath, 'p1')
    try {
      expect(JSON.parse(exportProfileStateJson(restored.db))).toEqual({
        settings: { theme: 'dark' },
        snapshotMarker: 'before'
      })
    } finally {
      restored.db.close()
    }
  })

  it('leaves the live daemon runtime dir untouched through capture and restore', () => {
    sh(captureQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
    // The daemon is running across the rollback and rewrites its token; a restore that
    // reached <root>/daemon would break the fence that keeps its terminals adoptable.
    writeFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'token-after-restart')
    sh(restoreQuirkydStateSnapshotCommand(host, dataDir, snapshotDir, baseDir()))
    expect(readFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'utf8')).toBe(
      'token-after-restart'
    )
  })

  it('reports EMPTY on a data root with nothing to lose, instead of an archive of nothing', () => {
    const emptyRoot = join(root, 'fresh')
    mkdirSync(emptyRoot)
    expect(
      parseQuirkydSnapshotCapture(
        sh(captureQuirkydStateSnapshotCommand(host, emptyRoot, snapshotDir, baseDir()))
      )
    ).toBe('empty')
    expect(sh(probeQuirkydStateSnapshotCommand(host, snapshotDir, baseDir())).trim()).toBe('ABSENT')
  })

  it('reports MISSING rather than claiming a restore it did not perform', () => {
    expect(
      parseQuirkydSnapshotRestore(
        sh(restoreQuirkydStateSnapshotCommand(host, dataDir, join(root, 'nope'), baseDir()))
      )
    ).toBe('missing')
  })

  it('reads a real mtime for the store', () => {
    const seconds = parseNewestStateMtimeSeconds(
      sh(newestStateMtimeCommand(host, dataDir, baseDir()))
    )
    expect(seconds).toBeGreaterThan(1_600_000_000)
    expect(seconds).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5)
  })

  it('survives a data root whose path contains a quote and a space', () => {
    const nasty = join(root, `it's a dir`)
    mkdirSync(join(nasty, 'profiles'), { recursive: true })
    writeFileSync(join(nasty, 'quirky-profile-index.json'), '{"v":"quoted"}')
    expect(
      parseQuirkydSnapshotCapture(
        sh(captureQuirkydStateSnapshotCommand(host, nasty, snapshotDir, baseDir()))
      )
    ).toBe('captured')
    expect(
      quirkydSnapshotIsUnchanged(
        sh(compareQuirkydStateSnapshotCommand(host, nasty, snapshotDir, baseDir()))
      )
    ).toBe(true)
    writeFileSync(join(nasty, 'quirky-profile-index.json'), '{"v":"changed"}')
    expect(
      quirkydSnapshotIsUnchanged(
        sh(compareQuirkydStateSnapshotCommand(host, nasty, snapshotDir, baseDir()))
      )
    ).toBe(false)
    expect(
      parseQuirkydSnapshotRestore(
        sh(restoreQuirkydStateSnapshotCommand(host, nasty, snapshotDir, baseDir()))
      )
    ).toBe('restored')
    expect(readFileSync(join(nasty, 'quirky-profile-index.json'), 'utf8')).toBe('{"v":"quoted"}')
  })
})

describe('liveness and stop commands, run for real', () => {
  it.each([false, true])(
    'records and stops the runtime PID with split entry %s',
    async (splitEntry) => {
      const { runtimePid, recordedPid, terminatedFile } = await launchTestRuntime(
        false,
        false,
        splitEntry
      )
      expect(recordedPid).toBe(runtimePid)
      expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('LIVE')
      // The prior client recognizes only quirkyd.js when deciding whether this PID was reused.
      const legacyIdentity = sh(
        `args=$(ps -o args= -p ${recordedPid}); ` +
          `case "$args" in *${quotePosixShell(join(versionDir, 'quirkyd.js'))}*) echo LIVE;; *) echo DEAD;; esac`
      ).trim()
      expect(legacyIdentity).toBe('LIVE')
      expect(stopTestRuntime()).toBe('stopped')
      expect(readFileSync(terminatedFile, 'utf8')).toBe('terminated')
      // An unreaped zombie has exited even though kill -0 still succeeds.
      expect(sh(`ps -o stat= -p ${runtimePid} || true`).trim()).toMatch(/^(?:Z.*)?$/)
      expect(existsSync(join(versionDir, QUIRKYD_PID_FILENAME))).toBe(true)
      expect(stopTestRuntime()).toBe('already-exited')
    }
  )

  it('stops a build that consumes stop requests by request file, not by signal', async () => {
    const { terminatedFile } = await launchTestRuntime(false, true)
    expect(stopTestRuntime()).toBe('stopped')
    expect(readFileSync(terminatedFile, 'utf8')).toBe('requested')
    expect(existsSync(join(versionDir, QUIRKYD_STOP_REQUEST_FILENAME))).toBe(false)
  })

  it('clears a stop request the previous process never consumed before launching', async () => {
    writeFileSync(join(versionDir, QUIRKYD_STOP_REQUEST_FILENAME), '')
    const { runtimePid } = await launchTestRuntime(false, true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('LIVE')
    expect(runtimePid).toBeGreaterThan(1)
  })

  it('refuses a legacy wrapper PID both before and after its shell exits', async () => {
    const { runtimePid, recordedPid, terminatedFile } = await launchTestRuntime(true)
    expect(recordedPid).not.toBe(runtimePid)
    const beforeWrapperExit = stopTestRuntime()
    expect(beforeWrapperExit).toBe('unknown')
    expect(quirkydStopFreedTheHost(beforeWrapperExit)).toBe(false)
    expect(() => process.kill(recordedPid, 0)).not.toThrow()
    expect(() => process.kill(runtimePid, 0)).not.toThrow()

    process.kill(recordedPid, 'SIGTERM')
    await expect
      .poll(() => sh(`ps -o stat= -p ${recordedPid} || true`).trim(), { timeout: 2_000 })
      .toMatch(/^(?:Z.*)?$/)
    const afterWrapperExit = stopTestRuntime()
    expect(afterWrapperExit).toBe('unknown')
    expect(quirkydStopFreedTheHost(afterWrapperExit)).toBe(false)
    expect(() => process.kill(runtimePid, 0)).not.toThrow()
    expect(existsSync(terminatedFile)).toBe(false)
  })

  it.each(['missing', 'malformed', 'without-health'])(
    'refuses an incumbent with %s readiness proof',
    async (proof) => {
      const { runtimePid, terminatedFile } = await launchTestRuntime()
      const readinessFile = join(versionDir, QUIRKYD_READINESS_FILENAME)
      if (proof === 'missing') {
        rmSync(readinessFile)
      } else {
        writeFileSync(readinessFile, proof === 'malformed' ? '{' : '{"type":"quirky_server_ready"}')
      }
      expect(stopTestRuntime()).toBe('unknown')
      expect(() => process.kill(runtimePid, 0)).not.toThrow()
      expect(existsSync(terminatedFile)).toBe(false)
    }
  )

  it('can stop a candidate just launched with exec without readiness', async () => {
    const { runtimePid, recordedPid, terminatedFile } = await launchTestRuntime()
    expect(recordedPid).toBe(runtimePid)
    rmSync(join(versionDir, QUIRKYD_READINESS_FILENAME))
    expect(stopTestRuntime(true)).toBe('stopped')
    expect(readFileSync(terminatedFile, 'utf8')).toBe('terminated')
    expect(sh(`ps -o stat= -p ${runtimePid} || true`).trim()).toMatch(/^(?:Z.*)?$/)
  })

  it.each(['before', 'after'])('refuses a permission-denied probe %s SIGTERM', async (phase) => {
    const { runtimePid, terminatedFile } = await launchTestRuntime()
    const deniedProbe = [
      'term_sent=0; kill() {',
      'if [ "$1" = -TERM ]; then term_sent=1; return 0; fi;',
      `if [ '${phase}' = before ] || [ "$term_sent" = 1 ]; then`,
      'echo "kill: Operation not permitted" >&2; return 1; fi;',
      'command kill "$@"; };'
    ].join(' ')
    const outcome = parseQuirkydStopOutcome(
      sh(
        `${deniedProbe} ${stopQuirkydCommand(host, versionDir, {
          waitSeconds: 1,
          nodePath: process.execPath
        })}`
      )
    )
    // After a delivered SIGTERM the host may still be changing, so it is not "nothing happened".
    expect(outcome).toBe(phase === 'before' ? 'unknown' : 'unconfirmed')
    expect(quirkydStopFreedTheHost(outcome)).toBe(false)
    expect(() => process.kill(runtimePid, 0)).not.toThrow()
    expect(existsSync(terminatedFile)).toBe(false)
  })

  it('reports NEVER_LAUNCHED with no launch artifacts, UNKNOWN with no pid, DEAD for an exited pid', () => {
    // A slot installed but never launched: proven exit, so GC may remove it and a wake may start it.
    rmSync(join(versionDir, QUIRKYD_READINESS_FILENAME), { force: true })
    const neverLaunched = sh(quirkydLivenessProbeCommand(host, versionDir))
    expect(parseQuirkydLiveness(neverLaunched)).toBe('NEVER_LAUNCHED')
    expect(quirkydLivenessAnswerBlocksGc(neverLaunched)).toBe(false)
    writeFileSync(join(versionDir, QUIRKYD_READINESS_FILENAME), '')
    expect(quirkydLivenessAnswerBlocksGc(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe(
      true
    )
    expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('UNKNOWN')
    writeFileSync(join(versionDir, QUIRKYD_PID_FILENAME), 'not-a-pid')
    expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('UNKNOWN')
    // A pid that has certainly exited: our own `sh` child from the line above.
    const exited = Number(sh('sh -c "echo $$"').trim())
    writeFileSync(join(versionDir, QUIRKYD_PID_FILENAME), String(exited))
    expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('DEAD')
  })

  it('reports a permission-denied liveness probe as UNKNOWN in any locale', () => {
    writeFileSync(join(versionDir, QUIRKYD_PID_FILENAME), '4242')
    // Keep the permission branch independent of unrelated host PID reuse.
    const matchingPs =
      'ps() { [ "$#" = 4 ] && [ "$1" = -o ] && [ "$2" = args= ] && ' +
      '[ "$3" = -p ] && [ "$4" = 4242 ] || return 1; ' +
      `printf 'node %s\\n' ${quotePosixShell(join(versionDir, 'quirkyd.js'))}; };`
    const deniedKill =
      'kill() { if [ "$LC_ALL" = C ]; then echo "kill: Operation not permitted" >&2; ' +
      'else echo "kill: Vorgang nicht zulässig" >&2; fi; return 1; };'
    expect(
      parseQuirkydLiveness(
        sh(
          `LC_ALL=de_DE.UTF-8; ${matchingPs} ${deniedKill} ${quirkydLivenessProbeCommand(host, versionDir)}`
        )
      )
    ).toBe('UNKNOWN')
  })

  it('reports a reused PID running something other than this slot as DEAD', () => {
    const stranger = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    try {
      writeFileSync(join(versionDir, QUIRKYD_PID_FILENAME), String(stranger.pid))
      expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('DEAD')
    } finally {
      stranger.kill('SIGKILL')
    }
  })

  it.each(['quirkyd.js', 'quirkyd-server.js'])(
    'reports LIVE and stops a running %s even without entry files',
    async (entry) => {
      // Stands in for quirkyd: its command line runs this slot's quirkyd.js.
      const child = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30000)', join(versionDir, entry)],
        { stdio: 'ignore' }
      )
      try {
        writeFileSync(join(versionDir, QUIRKYD_PID_FILENAME), String(child.pid))
        expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('LIVE')

        const exited = new Promise<NodeJS.Signals | null>((resolve) =>
          child.once('exit', (_code, signal) => resolve(signal))
        )
        expect(
          parseQuirkydStopOutcome(
            sh(stopQuirkydCommand(host, versionDir, { waitSeconds: 10, justLaunched: true }))
          )
        ).toBe('stopped')
        expect(await exited).toBe('SIGTERM')
        expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('DEAD')
      } finally {
        child.kill('SIGKILL')
      }
    }
  )

  // `kill -0` succeeds on a zombie, so a probe built on it alone calls an exited process
  // live: the stop loop would time out on a process that is already gone, and GC would keep
  // a dead version dir forever. Verified as a real macOS behaviour, not a hypothetical.
  it('reports a zombie as DEAD, not as a running process', () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    try {
      writeFileSync(join(versionDir, QUIRKYD_PID_FILENAME), String(child.pid))
      // Block Node's reaper until the shell observes the required zombie state.
      sh(
        `attempt=0; while [ "$attempt" -lt 100 ]; do ` +
          `case "$(ps -o stat= -p ${child.pid} 2>/dev/null)" in *Z*) exit 0;; esac; ` +
          `attempt=$((attempt + 1)); sleep 0.01; done; exit 1`
      )
      expect(sh(`ps -o stat= -p ${child.pid} || echo GONE`).trim()).toMatch(/^Z/)
      expect(sh(`kill -0 ${child.pid} 2>/dev/null && echo LIVE || echo DEAD`).trim()).toBe('LIVE')
      expect(parseQuirkydLiveness(sh(quirkydLivenessProbeCommand(host, versionDir)))).toBe('DEAD')
      expect(
        parseQuirkydStopOutcome(
          sh(stopQuirkydCommand(host, versionDir, { waitSeconds: 1, justLaunched: true }))
        )
      ).toBe('already-exited')
    } finally {
      child.unref()
    }
  })

  it('reports ALREADY_EXITED for a stale pid file rather than signalling a stranger', () => {
    const exited = Number(sh('sh -c "echo $$"').trim())
    writeFileSync(join(versionDir, QUIRKYD_PID_FILENAME), String(exited))
    expect(
      parseQuirkydStopOutcome(
        sh(stopQuirkydCommand(host, versionDir, { waitSeconds: 1, justLaunched: true }))
      )
    ).toBe('already-exited')
  })

  it('reports NO_PID when the version dir was never launched', () => {
    expect(
      parseQuirkydStopOutcome(
        sh(stopQuirkydCommand(host, versionDir, { waitSeconds: 1, nodePath: process.execPath }))
      )
    ).toBe('no-pid')
  })
})

describe('host-side readiness wait, run for real', () => {
  const readiness = () => join(versionDir, QUIRKYD_READINESS_FILENAME)
  const line = `${JSON.stringify({ type: 'quirky_server_ready', runtimeId: 'r1' })}\n`

  it('returns a finished line without waiting out its bound', () => {
    writeFileSync(readiness(), line)
    const started = Date.now()
    const result = parseQuirkydReadinessWaitOutput(
      host,
      sh(quirkydReadinessWaitCommand(host, versionDir, 10))
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result).toMatchObject({ state: 'ready', readiness: { runtimeId: 'r1' } })
  })

  it('waits for a line still being written, and answers pending when its bound ends', () => {
    writeFileSync(readiness(), line.slice(0, 10))
    // The writer finishes after the wait starts; the shell must pick it up mid-wait.
    sh(
      `(sleep 1; printf '%s\\n' ${quotePosixShell(line.trimEnd().slice(10))} >> ${quotePosixShell(readiness())}) >/dev/null 2>&1 &`
    )
    expect(
      parseQuirkydReadinessWaitOutput(host, sh(quirkydReadinessWaitCommand(host, versionDir, 10)))
    ).toMatchObject({ state: 'ready' })
    writeFileSync(readiness(), '{"type":"quirky_ser')
    expect(
      parseQuirkydReadinessWaitOutput(host, sh(quirkydReadinessWaitCommand(host, versionDir, 1)))
    ).toEqual({ state: 'pending' })
  })

  it('reads a missing file as pending', () => {
    expect(
      parseQuirkydReadinessWaitOutput(
        host,
        sh(quirkydReadinessWaitCommand(host, `${versionDir}-none`, 0))
      )
    ).toEqual({ state: 'pending' })
  })
})
