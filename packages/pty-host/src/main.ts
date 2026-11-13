import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'
import {
  ensureHome,
  installProcessErrorGuards,
  isPidAlive,
  quirkyHome,
  tryHomeLock,
  type HomeLock
} from '@quirky/protocol/node'
import { probeHost } from './client'
import { startPtyServer } from './server'

installProcessErrorGuards({ label: 'quirky-pty' })

let homeLock: HomeLock | null = null

function releaseHomeLock(): void {
  const lock = homeLock
  homeLock = null
  lock?.release()
}

process.once('exit', () => {
  try {
    releaseHomeLock()
  } catch {}
})

function finishShutdown(error?: unknown): never {
  let failure = error
  try {
    releaseHomeLock()
  } catch (lockError) {
    failure ??= lockError
  }
  if (failure === undefined) process.exit(0)
  process.stderr.write(`[quirky-pty] shutdown failed: ${inspect(failure)}\n`)
  process.exit(1)
}

try {
  const home = ensureHome(quirkyHome())
  const lock = tryHomeLock(home, 'pty')
  homeLock = lock
  if (!lock) {
    console.log(`quirky-pty already running for ${home}`)
    process.exit(0)
  }

  const probe = await probeHost(home)
  if (probe !== 'absent') {
    console.log(`quirky-pty already running for ${home}`)
    releaseHomeLock()
    process.exit(0)
  }

  const pidPath = join(home, 'pty.pid')
  const previousPid = readPid(pidPath)
  if (previousPid !== null && isPidAlive(previousPid) && previousPid !== lock.lastHolderPid) {
    console.log(
      `quirky-pty ${previousPid} owns ${home} but its socket accepts no connection; ` +
        `if process ${previousPid} is not quirky-pty, remove ${pidPath}`
    )
    releaseHomeLock()
    process.exit(0)
  }

  rmSync(pidPath, { force: true })
  lock.recordHolder()
  const server = startPtyServer({ home, onShutdown: finishShutdown })

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void server.stop().then(
        () => finishShutdown(),
        (error: unknown) => finishShutdown(error ?? new Error('unknown shutdown error'))
      )
    })
  }
} catch (error) {
  try {
    releaseHomeLock()
  } catch (releaseError) {
    process.stderr.write(`[quirky-pty] lock release failed: ${inspect(releaseError)}\n`)
  }
  process.stderr.write(`[quirky-pty] startup failed: ${inspect(error)}\n`)
  process.exit(1)
}

function readPid(path: string): number | null {
  try {
    const value = readFileSync(path, 'utf8').trim()
    if (!/^[1-9]\d*$/.test(value)) return null
    const pid = Number(value)
    return Number.isSafeInteger(pid) ? pid : null
  } catch {
    return null
  }
}
