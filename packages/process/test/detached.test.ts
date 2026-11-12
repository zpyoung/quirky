import { afterEach, expect, test } from 'bun:test'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchDetached, liveProcesses, stopAllProcesses } from '../src/api'

const fixture = fileURLToPath(new URL('./fixtures/launch-detached.ts', import.meta.url))
const groups: number[] = []
const parents: Array<{ pid: number; exited: Promise<number> }> = []
const directories: string[] = []

function newLog(): string {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-detached-'))
  directories.push(directory)
  const path = join(directory, 'child.log')
  writeFileSync(path, '')
  return path
}

function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL') } catch {}
}

async function readPid(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error('fixture parent exited before printing the child pid')
      text += new TextDecoder().decode(value)
      const newline = text.indexOf('\n')
      if (newline !== -1) return Number(text.slice(0, newline).trim())
    }
  } finally {
    reader.releaseLock()
  }
}

function launchFixtureParent(mode: 'exit' | 'wait', log: string, beats: number) {
  const startedAt = Date.now()
  const parent = Bun.spawn([process.execPath, fixture, mode, log, String(beats)], {
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore'
  } as unknown as Bun.SpawnOptions.OptionsObject<'pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'>)
  groups.push(parent.pid)
  parents.push(parent)
  const childPid = readPid(parent.stdout).then(pid => {
    groups.push(pid)
    return pid
  })
  return { parent, childPid, startedAt }
}

function launchChild(log: string, beats: number): number {
  const fd = openSync(log, 'a')
  try {
    const child = launchDetached([process.execPath, fixture, 'child', log, String(beats)], {
      stdout: fd,
      stderr: fd
    })
    groups.push(child.pid)
    return child.pid
  } finally {
    closeSync(fd)
  }
}


function beatCount(path: string): number {
  const matches = [...readFileSync(path, 'utf8').matchAll(/^beat (\d+)$/gm)]
  return Number(matches.at(-1)?.[1] ?? 0)
}

function processStatus(pid: number): string {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'stat=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
  return new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim()
}

function processGroupId(pid: number): number {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'pgid=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
  return Number.parseInt(new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim(), 10)
}

function expectAlive(pid: number): void {
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  expect(alive).toBe(true)
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} did not happen within ${timeoutMs}ms`)
    // These checks observe real detached OS processes, so fake time cannot advance their lifecycle.
    await Bun.sleep(20)
  }
}

afterEach(async () => {
  const pids = [...new Set(groups.splice(0))]
  for (const pid of pids) killGroup(pid)
  await Promise.all(parents.splice(0).map(parent => parent.exited))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('D1: the child outlives its exiting parent and leads its own group', async () => {
  const log = newLog()
  const started = launchFixtureParent('exit', log, 200)
  const childPid = await started.childPid
  expect(await started.parent.exited).toBe(0)
  expect(Date.now() - started.startedAt).toBeLessThan(3_000)

  await waitFor(() => {
    const lines = readFileSync(log, 'utf8').split('\n')
    return lines.includes(`out ${childPid}`) && lines.includes('err')
  }, 2_000, 'child output')
  expectAlive(childPid)
  expect(processGroupId(childPid)).toBe(childPid)
}, 15_000)

test('D2: the child survives SIGKILL of its parent process group', async () => {
  const log = newLog()
  const started = launchFixtureParent('wait', log, 200)
  const childPid = await started.childPid
  await waitFor(() => beatCount(log) > 0, 2_000, 'first child beat')
  const previousBeat = beatCount(log)

  killGroup(started.parent.pid)
  await started.parent.exited
  await waitFor(() => beatCount(log) > previousBeat, 2_000, 'child beat after parent group kill')
  expectAlive(childPid)
}, 15_000)

test('D3: the child is absent from the live table and survives stopAllProcesses', async () => {
  const log = newLog()
  const childPid = launchChild(log, 200)
  expect(liveProcesses().some(entry => entry.pid === childPid)).toBe(false)
  await waitFor(() => beatCount(log) > 0, 2_000, 'first child beat')
  const previousBeat = beatCount(log)

  await stopAllProcesses()
  await waitFor(() => beatCount(log) > previousBeat, 2_000, 'child beat after stopAllProcesses')
  expectAlive(childPid)
}, 15_000)

test('D4: an exited detached child leaves no zombie process row', async () => {
  const log = newLog()
  const childPid = launchChild(log, 2)
  await waitFor(() => processStatus(childPid) === '', 3_000, 'detached child reaping')

  expect(processStatus(childPid)).toBe('')
  expect(readFileSync(log, 'utf8').split('\n')).toContain(`out ${childPid}`)
  expect(readFileSync(log, 'utf8').split('\n')).toContain('err')
}, 15_000)

test('D5: invalid commands and working directories throw synchronously', () => {
  function expectErrno(action: () => unknown): void {
    let error: unknown
    try { action() } catch (caught) { error = caught }
    expect(error).toBeDefined()
    if (!error || typeof error !== 'object' || !('code' in error)) {
      throw new Error('expected an ENOENT error')
    }
    expect(error.code).toBe('ENOENT')
  }

  expectErrno(() => launchDetached(['/no/such/binary']))
  expectErrno(() => launchDetached([process.execPath], { cwd: '/no/such/dir' }))
  expect(() => launchDetached([])).toThrow(TypeError)
  expect(() => launchDetached([''])).toThrow(TypeError)
})
