import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { homeLockPath, isPidAlive, tryHomeLock, type HomeLock } from '../src/node'

const HOLDER_FIXTURE = join(import.meta.dir, 'fixtures', 'hold-home-lock.ts')
const scopes: ProcessScope[] = []
const heldLocks = new Set<HomeLock>()

afterEach(async () => {
  for (const lock of heldLocks) {
    heldLocks.delete(lock)
    lock.release()
  }
  for (const scope of scopes.splice(0).reverse()) await scope.cleanup()
})

function scopedHome(): ProcessScope {
  const scope = createProcessScope()
  scopes.push(scope)
  return scope
}

function takeLock(home: string, name: 'daemon' | 'pty'): HomeLock | null {
  const lock = tryHomeLock(home, name)
  if (lock) heldLocks.add(lock)
  return lock
}

function releaseLock(lock: HomeLock): void {
  heldLocks.delete(lock)
  lock.release()
}

function capture(stream: ReadableStream<Uint8Array>) {
  let output = ''
  const done = (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
    }
    output += decoder.decode()
  })()
  return { text: () => output, done }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${description}`)
}

describe('home lock', () => {
  test('excludes a second owner, records holders, and unlocks on child death', async () => {
    const scope = scopedHome()
    const child = scope.spawn(
      [process.execPath, HOLDER_FIXTURE, scope.home, 'pty', 'recordHolder'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const stdout = capture(child.stdout)
    await waitFor(
      () => (stdout.text().includes(`locked pid=${child.pid} lastHolder=null`) ? true : undefined),
      5000,
      'child lock holder with no previous holder'
    )

    expect(tryHomeLock(scope.home, 'pty')).toBeNull()
    const daemonLock = takeLock(scope.home, 'daemon')
    expect(daemonLock).not.toBeNull()
    expect(daemonLock!.lastHolderPid).toBeNull()
    releaseLock(daemonLock!)

    const ptyPath = homeLockPath(scope.home, 'pty')
    expect(readFileSync(join(scope.home, 'pty.oslock.pid'), 'utf8')).toBe(String(child.pid))
    expect(statSync(ptyPath).mode & 0o777).toBe(0o600)
    expect(isPidAlive(process.pid)).toBe(true)

    child.kill('SIGKILL')
    const lock = await waitFor(
      () => takeLock(scope.home, 'pty') ?? undefined,
      1000,
      'lock release after child death'
    )
    expect(lock.path).toBe(ptyPath)
    expect(lock.lastHolderPid).toBe(child.pid)
    expect(tryHomeLock(scope.home, 'pty')).toBeNull()
    expect(statSync(ptyPath).mode & 0o777).toBe(0o600)

    lock.recordHolder()
    const holderPath = join(scope.home, 'pty.oslock.pid')
    expect(readFileSync(holderPath, 'utf8')).toBe(String(process.pid))
    expect(statSync(holderPath).mode & 0o777).toBe(0o600)
    releaseLock(lock)

    expect(readFileSync(holderPath, 'utf8')).toBe('')
    expect(statSync(ptyPath).mode & 0o777).toBe(0o600)
    const nextLock = takeLock(scope.home, 'pty')
    expect(nextLock!.lastHolderPid).toBeNull()
    releaseLock(nextLock!)
    expect(readFileSync(holderPath, 'utf8')).toBe('')
    expect(statSync(ptyPath).mode & 0o777).toBe(0o600)

    writeFileSync(join(scope.home, 'daemon.oslock.pid'), 'not a pid', { mode: 0o600 })
    const malformedPidLock = takeLock(scope.home, 'daemon')
    expect(malformedPidLock!.lastHolderPid).toBeNull()
    releaseLock(malformedPidLock!)

  })

  test('repairs a corrupt lock file in place', () => {
    const scope = scopedHome()
    const path = homeLockPath(scope.home, 'daemon')
    writeFileSync(path, 'x'.repeat(1500), { mode: 0o600 })
    const inode = statSync(path).ino

    const lock = takeLock(scope.home, 'daemon')
    expect(lock).not.toBeNull()
    expect(statSync(path).size).toBe(0)
    expect(statSync(path).ino).toBe(inode)
    releaseLock(lock!)
  })
})
