import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, type OwnedProcessRunner } from '../src/api'
import type { RunOptions } from '@quirky/protocol'

const runners: OwnedProcessRunner[] = []
const dirs: string[] = []
const argv = ['/bin/sh', '-c', 'echo x >> counter; if mkdir stagger 2>/dev/null; then sleep 0.15; else rmdir stagger; sleep 0.35; fi; echo done']
function runner() {
  const value = createProcessRunner({ owner: 'share' })
  runners.push(value)
  return value
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'quirky-process-share-'))
  dirs.push(path)
  return path
}
async function count(cwd: string) {
  return (await readFile(join(cwd, 'counter'), 'utf8')).trim().split('\n').length
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('20: identical simultaneous shared calls start one child and return the same result', async () => {
  const process = runner()
  const cwd = await directory()
  const options = { cwd, share: true, timeoutMs: 5_000 }
  const [first, second] = await Promise.all([process.run(argv, options), process.run(argv, options)])
  expect(first).toBe(second)
  expect(first.stdoutText).toBe('done\n')
  expect(await count(cwd)).toBe(1)
}, 15_000)

test('21: a settled shared call is not cached', async () => {
  const process = runner()
  const cwd = await directory()
  const options = { cwd, share: true, timeoutMs: 5_000 }
  const first = await process.run(argv, options)
  const second = await process.run(argv, options)
  expect(second).not.toBe(first)
  expect(await count(cwd)).toBe(2)
}, 15_000)

test('22: every effective execution option separates calls and runner instances never share', async () => {
  const cwd = await directory()
  const otherCwd = await directory()
  const pairs: [left: RunOptions, right: RunOptions, argv?: readonly string[]][] = [
    [{}, {}, ['/bin/sh', '-c', 'echo x >> counter; sleep 0.35; echo other']],
    [{ cwd }, { cwd: otherCwd }],
    [{ env: { PATH: '/bin:/usr/bin', A: '1' } }, { env: { PATH: '/bin:/usr/bin', A: '2' } }],
    [{ timeoutMs: 4_000 }, { timeoutMs: 5_000 }],
    [{ killGraceMs: 10 }, { killGraceMs: 20 }],
    [{ maxOutputBytes: 100 }, { maxOutputBytes: 200 }],
    [{ rerunnable: false }, { rerunnable: true }]
  ]
  for (const [left, right, otherArgv] of pairs) {
    const process = runner()
    const [first, second] = await Promise.all([
      process.run(argv, { cwd, timeoutMs: 5_000, share: true, ...left }),
      process.run(otherArgv ?? argv, { cwd, timeoutMs: 5_000, share: true, ...right })
    ])
    expect(first).not.toBe(second)
  }
  expect(await count(cwd)).toBe(13)
  expect(await count(otherCwd)).toBe(1)
  const options = { cwd, timeoutMs: 5_000, share: true }
  const [first, second] = await Promise.all([runner().run(argv, options), runner().run(argv, options)])
  expect(first).not.toBe(second)
  expect(await count(cwd)).toBe(15)
}, 15_000)

test('23: identical unshared calls start separate children', async () => {
  const process = runner()
  const cwd = await directory()
  const options = { cwd, timeoutMs: 5_000 }
  const [first, second] = await Promise.all([process.run(argv, options), process.run(argv, options)])
  expect(first).not.toBe(second)
  expect(await count(cwd)).toBe(2)
}, 15_000)

test('24: sharing rejects input or a signal before a child starts', async () => {
  const process = runner()
  const cwd = await directory()
  for (const options of [{ input: '' }, { signal: new AbortController().signal }]) {
    const error = await process.run(argv, { cwd, share: true, timeoutMs: 5_000, ...options }).then(() => null, error => error)
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toBe('share cannot be combined with input or signal')
  }
  const exists = await Bun.file(join(cwd, 'counter')).exists()
  expect(exists).toBe(false)
  expect(process.live()).toEqual([])
}, 15_000)

test('sharing canonicalizes environment entry order and snapshots the current inherited environment', async () => {
  const process = runner()
  const cwd = await directory()
  const [first, second] = await Promise.all([
    process.run(argv, { cwd, timeoutMs: 5_000, share: true, env: { PATH: '/bin:/usr/bin', A: '1' } }),
    process.run(argv, { cwd, timeoutMs: 5_000, share: true, env: { A: '1', PATH: '/bin:/usr/bin' } })
  ])
  expect(first).toBe(second)
  expect(await count(cwd)).toBe(1)
  const previous = globalThis.process.env.QUIRKY_PROCESS_SHARE_TEST
  try {
    globalThis.process.env.QUIRKY_PROCESS_SHARE_TEST = '0.1'
    const command = ['/bin/sh', '-c', 'sleep "$QUIRKY_PROCESS_SHARE_TEST"; printf "$QUIRKY_PROCESS_SHARE_TEST"']
    const pending = process.run(command, { share: true, timeoutMs: 5_000 })
    globalThis.process.env.QUIRKY_PROCESS_SHARE_TEST = '0.25'
    const next = process.run(command, { share: true, timeoutMs: 5_000 })
    const results = await Promise.all([pending, next])
    expect(results.map(result => result.stdoutText)).toEqual(['0.1', '0.25'])
  } finally {
    if (previous === undefined) delete globalThis.process.env.QUIRKY_PROCESS_SHARE_TEST
    else globalThis.process.env.QUIRKY_PROCESS_SHARE_TEST = previous
  }
}, 15_000)

test('a rejected shared run is removed before the next identical call', async () => {
  let starts = 0
  const process = createProcessRunner({
    owner: 'share-stall',
    stallMs: 1,
    start: () => {
      starts++
      return {
        pid: 2_000_000_000,
        stdout: starts === 1 ? new ReadableStream() : new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('ok'))
            controller.close()
          }
        }),
        stderr: new ReadableStream({ start(controller) { controller.close() } }),
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        killGroup() {}
      }
    }
  })
  runners.push(process)
  const error = await process.run(['fake'], { share: true, timeoutMs: 1_000 }).then(() => null, error => error)
  expect(error).toBeInstanceOf(Error)
  const result = await process.run(['fake'], { share: true, timeoutMs: 1_000 })
  expect(result.stdoutText).toBe('ok')
  expect(starts).toBe(2)
}, 15_000)
