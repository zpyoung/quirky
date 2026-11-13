import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git as fixtureGit, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { compare, worktreeChangeList } from '../src/compare'
import { saveWorkingFile } from '../src/diffs'
import { appendIgnore } from '../src/huge'
import { GitError, listWorktrees, stage, status } from '../src/index'
import { getConfig, hasCommits, listRegistrations, showFile } from '../src/ops'
import * as runner from '../src/run'
import { statusV2 } from '../src/status'

const { scratch } = isolateGitConfig()
const realGit = Bun.which('git')!
const originalPath = process.env.PATH
const releases: string[] = []
const pending: Promise<unknown>[] = []

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise)
  promise.catch(() => {})
  return promise
}

afterEach(async () => {
  for (const release of releases.splice(0)) writeFileSync(release, '')
  await Promise.allSettled(pending.splice(0))
  process.env.PATH = originalPath
})

function wrapper(script = 'exec "$REAL_GIT" "$@"') {
  const bin = scratch()
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls.log')
  const entered = join(bin, 'entered')
  const release = join(bin, 'release')
  const claimed = join(bin, 'claimed')
  releases.push(release)
  const executable = join(bin, 'git')
  writeFileSync(executable, `#!/bin/sh\nREAL_GIT='${realGit}'\nLOG='${log}'\nENTERED='${entered}'\nRELEASE='${release}'\nCLAIMED='${claimed}'\necho "$@" >> "$LOG"\n${script}\n`)
  chmodSync(executable, 0o755)
  process.env.PATH = `${bin}:${originalPath}`
  return {
    entered, release, bin,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  }
}

// real child processes signal through gate files, outside fake-timer control.
async function until(condition: () => boolean) {
  const deadline = Date.now() + 4000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('git wrapper did not reach its gate')
    await Bun.sleep(5)
  }
}

const pauseFirstStatus = `if [ "$3" = status ] && mkdir "$CLAIMED" 2>/dev/null; then
  "$REAL_GIT" "$@"
  touch "$ENTERED"
  while [ ! -f "$RELEASE" ]; do sleep 0.01; done
  exit 0
fi
exec "$REAL_GIT" "$@"`

describe('scheduled git execution', () => {
  test('same-turn reads spawn once, isolate bytes, and do not cache completed results', async () => {
    const repo = makeRepo(scratch())
    const fake = wrapper()
    const [first, second] = await Promise.all([
      runner.runGit(repo, ['rev-parse', 'HEAD'], { readOnly: true }),
      runner.runGit(repo, ['rev-parse', 'HEAD'], { readOnly: true })
    ])
    expect(fake.calls()).toHaveLength(1)
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toEqual(second.stdout)
    const byte = second.stdout[0]
    first.stdout[0]! ^= 0xff
    expect(second.stdout[0]).toBe(byte)
    await runner.runGit(repo, ['rev-parse', 'HEAD'], { readOnly: true })
    expect(fake.calls()).toHaveLength(2)
  })

  test('a same-turn 200-status burst shares one composite snapshot', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    writeFileSync(join(repo, 'a.txt'), 'staged\n')
    fixtureGit(repo, 'add', 'a.txt')
    writeFileSync(join(repo, 'b.txt'), 'unstaged\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    const fake = wrapper()
    const results = await Promise.all(Array.from({ length: 200 }, () => statusV2(repo)))
    expect(fake.calls().length).toBeLessThanOrEqual(7)
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true)
    expect(runner.gitScheduler.peakActive).toBeLessThanOrEqual(8)
    expect(runner.gitScheduler.active).toBe(0)
    const entryCount = results[1]!.entries.length
    const fileCount = results[1]!.files.length
    results[0]!.entries.pop()
    results[0]!.files.pop()
    expect(results[1]!.entries).toHaveLength(entryCount)
    expect(results[1]!.files).toHaveLength(fileCount)
  })
})

describe('scheduled git freshness', () => {
  test('git and filesystem writes advance epochs, while pure helper reads leave them alone', async () => {
    const repo = makeRepo(scratch())
    let epoch = runner.gitScheduler.writeEpoch
    await Promise.all([getConfig(repo, 'user.name'), listRegistrations(repo), hasCommits(repo), listWorktrees(repo), status(repo)])
    expect(runner.gitScheduler.writeEpoch).toBe(epoch)
    for (const mutate of [
      () => stage(repo, ['a.txt']),
      () => saveWorkingFile(repo, 'a.txt', 'updated\n'),
      () => appendIgnore(repo, 'dist')
    ]) {
      await mutate()
      expect(runner.gitScheduler.writeEpoch).toBeGreaterThanOrEqual(epoch + 2)
      epoch = runner.gitScheduler.writeEpoch
    }
  })

  for (const mutation of ['stage', 'save', 'ignore'] as const) {
    test(`${mutation} lets a post-write status pass a paused pre-write status`, async () => {
      const repo = makeRepo(scratch())
      writeFileSync(join(repo, 'a.txt'), 'changed\n')
      mkdirSync(join(repo, 'dist'))
      writeFileSync(join(repo, 'dist', 'out'), 'build\n')
      const fake = wrapper(pauseFirstStatus)
      const before = track(statusV2(repo))
      await until(() => existsSync(fake.entered))
      if (mutation === 'stage') await stage(repo, ['a.txt'])
      else if (mutation === 'save') await saveWorkingFile(repo, 'new.txt', 'updated\n')
      else await appendIgnore(repo, 'dist')
      let finished = false
      const after = track(statusV2(repo).then((value) => { finished = true; return value }))
      await until(() => finished)
      const result = await after
      if (mutation === 'stage') expect(result.entries.some((e) => e.path === 'a.txt' && e.area === 'staged')).toBe(true)
      else if (mutation === 'save') expect(result.entries.some((e) => e.path === 'new.txt')).toBe(true)
      else expect(result.entries.some((e) => e.path.startsWith('dist/'))).toBe(false)
      expect(existsSync(fake.release)).toBe(false)
      writeFileSync(fake.release, '')
      const old = await before
      expect(old.entries.some((e) => e.path === 'a.txt' && e.area === 'unstaged')).toBe(true)
      expect(old.entries.some((e) => e.path === 'new.txt')).toBe(false)
      expect(old.entries.some((e) => e.path === 'dist/out')).toBe(true)
    })
  }

  test('external file and index edits join a trailing cohort, never an active snapshot', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    const fake = wrapper(pauseFirstStatus)
    const before = track(statusV2(repo))
    await until(() => existsSync(fake.entered))
    writeFileSync(join(repo, 'ext.txt'), 'new\n')
    const added = Bun.spawnSync([realGit, '-C', repo, 'add', 'a.txt'], { env: process.env })
    expect(added.exitCode).toBe(0)
    let settled = 0
    const second = track(statusV2(repo).then((value) => { settled++; return value }))
    const third = track(statusV2(repo).then((value) => { settled++; return value }))
    // a child that starts too early needs real event-loop time to reach the wrapper.
    await Bun.sleep(150)
    expect(settled).toBe(0)
    expect(fake.calls().filter((call) => call.includes('status --porcelain=v2'))).toHaveLength(1)
    writeFileSync(fake.release, '')
    const [old, next, shared] = await Promise.all([before, second, third])
    expect(old.entries.some((e) => e.path === 'a.txt' && e.area === 'unstaged')).toBe(true)
    expect(old.entries.some((e) => e.path === 'ext.txt')).toBe(false)
    expect(next.entries.some((e) => e.path === 'a.txt' && e.area === 'staged')).toBe(true)
    expect(next.entries.some((e) => e.path === 'ext.txt' && e.area === 'untracked')).toBe(true)
    expect(next).toEqual(shared)
    const count = shared.entries.length
    next.entries.pop()
    expect(shared.entries).toHaveLength(count)
    expect(fake.calls().filter((call) => call.includes('status --porcelain=v2'))).toHaveLength(2)
  })
})

describe('git scheduler compatibility', () => {
  for (const difference of ['cwd', 'args', 'env', 'timeout', 'stall', 'input', 'unshared', 'write'] as const) {
    test(`${difference} does not share distinct subprocess calls`, async () => {
      const repo = makeRepo(scratch())
      const other = difference === 'cwd' ? makeRepo(scratch()) : repo
      const fake = wrapper()
      const options: runner.RunGitOptions = { readOnly: true }
      const secondOptions: runner.RunGitOptions = { readOnly: true }
      let secondArgs = ['rev-parse', 'HEAD']
      if (difference === 'args') secondArgs = ['rev-parse', '--verify', 'HEAD']
      if (difference === 'env') secondOptions.env = { G2_TEST: 'different' }
      if (difference === 'timeout') secondOptions.timeoutMs = 10000
      if (difference === 'stall') secondOptions.stallMs = 200
      if (difference === 'input') secondOptions.input = ''
      if (difference === 'unshared') secondOptions.share = false
      if (difference === 'write') delete secondOptions.readOnly
      const results = await Promise.all([
        runner.runGit(repo, ['rev-parse', 'HEAD'], options),
        runner.runGit(other, secondArgs, secondOptions)
      ])
      expect(results.map((result) => result.exitCode)).toEqual([0, 0])
      expect(fake.calls()).toHaveLength(2)
    })
  }

  test('resolved cwd and environment order do not split an identical cohort', async () => {
    const repo = makeRepo(scratch())
    const fake = wrapper()
    await Promise.all([
      runner.runGit(repo, ['rev-parse', 'HEAD'], { readOnly: true, env: { A: '1', B: '2' } }),
      runner.runGit(`${repo}/.`, ['rev-parse', 'HEAD'], { readOnly: true, env: { B: '2', A: '1' } })
    ])
    expect(fake.calls()).toHaveLength(1)
  })

  test('queue timeout returns the existing timeout result without spawning', async () => {
    const repo = makeRepo(scratch())
    const fake = wrapper()
    const held = Promise.withResolvers<void>()
    const holders = Array.from({ length: 8 }, () => runner.gitScheduler.withSlot('read', undefined, () => held.promise))
    let result: runner.GitResult
    try {
      result = await runner.runGit(repo, ['rev-parse', 'HEAD'], { readOnly: true, timeoutMs: 20 })
    } finally {
      held.resolve()
      await Promise.all(holders)
    }
    expect(result).toEqual({ stdout: new Uint8Array(0), stderr: '', exitCode: 143, timedOut: true })
    expect(fake.calls()).toHaveLength(0)
    expect(runner.gitScheduler.active).toBe(0)
  })

  test('network environment lookup and composite reads settle with only one free slot', async () => {
    const repo = makeRepo(scratch())
    fixtureGit(repo, 'config', 'core.sshCommand', 'ssh -F /dev/null')
    const held = Promise.withResolvers<void>()
    const holders = Array.from({ length: 7 }, () => runner.gitScheduler.withSlot('read', undefined, () => held.promise))
    try {
      const result = await runner.runGit(repo, ['status'], { network: true, readOnly: true })
      expect(result.exitCode).toBe(0)
      expect((await statusV2(repo)).branch).toBe('main')
      expect((await compare(repo, 'main')).status).toBe('ready')
      expect((await worktreeChangeList(repo, 'main')).changes).toEqual([])
    } finally {
      held.resolve()
      await Promise.all(holders)
    }
    expect(runner.gitScheduler.active).toBe(0)
  })

  test('streaming limits reap children before releasing slots', async () => {
    const repo = makeRepo(scratch())
    for (let i = 0; i < 30; i++) writeFileSync(join(repo, `untracked-${i}`), 'new\n')
    runner.gitScheduler.resetPeakActive()
    const status = await statusV2(repo, { limit: 5 })
    expect(status.capped).toBe(true)
    expect(status.entries).toHaveLength(5)
    expect(runner.gitScheduler.active).toBe(0)
    const changes = await worktreeChangeList(repo, 'HEAD', { limit: 5 })
    expect(changes.capped).toBe(true)
    expect(changes.changes).toHaveLength(5)
    expect(runner.gitScheduler.active).toBe(0)
  })

  test('worktree changes and branch compares share composite runs and isolate results', async () => {
    const repo = makeRepo(scratch())
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(repo, 'a.txt'), 'committed\n')
    fixtureGit(repo, 'commit', '-qam', 'feature')
    writeFileSync(join(repo, 'extra.txt'), 'untracked\n')
    const fake = wrapper()
    const changes = await Promise.all(Array.from({ length: 20 }, () => worktreeChangeList(repo, 'main')))
    expect(changes.every((value) => JSON.stringify(value) === JSON.stringify(changes[0]))).toBe(true)
    expect(fake.calls().filter((call) => call.startsWith('ls-files '))).toHaveLength(1)
    const count = changes[1]!.changes.length
    changes[0]!.changes.pop()
    expect(changes[1]!.changes).toHaveLength(count)
    const baseline = fake.calls().length
    const comparisons = await Promise.all(Array.from({ length: 20 }, () => compare(repo, 'main')))
    expect(comparisons.every((value) => JSON.stringify(value) === JSON.stringify(comparisons[0]))).toBe(true)
    const entryCount = comparisons[1]!.entries.length
    comparisons[0]!.entries.pop()
    expect(comparisons[1]!.entries).toHaveLength(entryCount)
    const firstCount = fake.calls().length - baseline
    const secondBaseline = fake.calls().length
    await compare(repo, 'main')
    expect(fake.calls().length - secondBaseline).toBe(firstCount)
    expect(runner.gitScheduler.peakActive).toBeLessThanOrEqual(8)
    expect(runner.gitScheduler.active).toBe(0)
  })

  test('failed shared composite reads reject every caller and the next cohort retries', async () => {
    const repo = scratch()
    mkdirSync(repo, { recursive: true })
    const fake = wrapper()
    const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)
    const errors = await Promise.all([failure(statusV2(repo)), failure(statusV2(repo))])
    expect(errors.every((error) => error instanceof GitError)).toBe(true)
    expect(fake.calls().filter((call) => call.includes('status --porcelain=v2'))).toHaveLength(1)
    expect(await failure(statusV2(repo))).toBeInstanceOf(GitError)
    expect(fake.calls().filter((call) => call.includes('status --porcelain=v2'))).toHaveLength(2)
    expect(runner.gitScheduler.active).toBe(0)
  })

  test('one-shot reads keep the full 20 MiB stdout contract', async () => {
    const repo = makeRepo(scratch())
    wrapper(`if [ \"$1\" = show ]; then\n  head -c 20971520 /dev/zero | tr '\\\\000' a\n  exit 0\nfi\nexec \"$REAL_GIT\" \"$@\"`)
    const result = await runner.runGit(repo, ['show', 'HEAD:big.txt'], { readOnly: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.byteLength).toBe(20971520)
    expect((await runner.git(repo, ['show', 'HEAD:big.txt'], { readOnly: true })).length).toBe(20971520)
    expect((await showFile(repo, 'HEAD', 'big.txt'))?.length).toBe(20971520)
    expect(runner.gitScheduler.active).toBe(0)
  }, 30000)
})

test('write settlement bypasses a status cohort started during the write', async () => {
  const repo = makeRepo(scratch())
  writeFileSync(join(repo, 'a.txt'), 'changed\n')
  const gates = scratch()
  mkdirSync(gates, { recursive: true })
  const writeEntered = join(gates, 'write-entered')
  const writeRelease = join(gates, 'write-release')
  const midEntered = join(gates, 'mid-entered')
  const midRelease = join(gates, 'mid-release')
  releases.push(writeRelease, midRelease)
  wrapper(`if [ "$1" = --literal-pathspecs ] || [ "$1" = add ]; then\n  touch '${writeEntered}'\n  while [ ! -f '${writeRelease}' ]; do sleep 0.01; done\nfi\nif [ "$3" = status ] && mkdir "$CLAIMED" 2>/dev/null; then\n  "$REAL_GIT" "$@"\n  touch '${midEntered}'\n  while [ ! -f '${midRelease}' ]; do sleep 0.01; done\n  exit 0\nfi\nexec "$REAL_GIT" "$@"`)
  const write = track(stage(repo, ['a.txt']))
  await until(() => existsSync(writeEntered))
  const mid = track(statusV2(repo))
  await until(() => existsSync(midEntered))
  writeFileSync(writeRelease, '')
  await write
  let settled = false
  const after = track(statusV2(repo).then((value) => { settled = true; return value }))
  await until(() => settled)
  expect((await after).entries.some((e) => e.path === 'a.txt' && e.area === 'staged')).toBe(true)
  expect(existsSync(midRelease)).toBe(false)
  writeFileSync(midRelease, '')
  expect((await mid).entries.some((e) => e.path === 'a.txt' && e.area === 'unstaged')).toBe(true)
})

test('waiting read cohorts spend their timeout budget before they can spawn', async () => {
  const repo = makeRepo(scratch())
  const fake = wrapper(`echo snapshot\ntouch "$ENTERED"\nwhile [ ! -f "$RELEASE" ]; do sleep 0.01; done`)
  const started = Date.now()
  const spawns = spyOn(Bun, 'spawn')
  try {
    setSystemTime(started)
    const first = track(runner.runGit(repo, ['status'], { readOnly: true, timeoutMs: 10000 }))
    await until(() => existsSync(fake.entered))
    const waiting = track(runner.runGit(repo, ['status'], { readOnly: true, timeoutMs: 10000 }))
    setSystemTime(started + 20000)
    writeFileSync(fake.release, '')
    const [activeResult, waitingResult] = await Promise.all([first, waiting])
    expect(activeResult.exitCode).toBe(0)
    expect(waitingResult).toEqual({ stdout: new Uint8Array(0), stderr: '', exitCode: 143, timedOut: true })
    expect(fake.calls()).toHaveLength(1)
    // a one-millisecond kill can beat the wrapper log, but it cannot hide an actual child spawn.
    expect(spawns).toHaveBeenCalledTimes(1)
    expect(runner.gitScheduler.active).toBe(0)
  } finally {
    spawns.mockRestore()
    setSystemTime()
  }
})

describe('git child admission', () => {
  for (const operation of ['runGit', 'statusV2', 'worktreeChangeList'] as const) {
    test(`${operation} waits behind all eight occupied slots before spawning`, async () => {
      const repo = makeRepo(scratch())
      const fake = wrapper()
      const held = Promise.withResolvers<void>()
      const holders = Array.from({ length: 8 }, () => runner.gitScheduler.withSlot('read', undefined, () => held.promise))
      const spawns = spyOn(Bun, 'spawn')
      let settled = false
      const call = track((operation === 'runGit'
        ? runner.runGit(repo, ['rev-parse', 'HEAD'], { readOnly: true, share: false })
        : operation === 'statusV2'
          ? statusV2(repo)
          : worktreeChangeList(repo, 'HEAD')).then((result) => { settled = true; return result }))
      try {
        // admission crosses the OS process boundary; fake time cannot prove that no child starts.
        await Bun.sleep(150)
        expect(fake.calls()).toHaveLength(0)
        expect(settled).toBe(false)
        expect(spawns).toHaveBeenCalledTimes(0)
      } finally {
        held.resolve()
        try {
          await Promise.all([...holders, call])
        } finally {
          spawns.mockRestore()
        }
      }
      const result = await call
      if ('exitCode' in result) {
        expect(result.exitCode).toBe(0)
        expect(result.timedOut).toBeUndefined()
      } else if ('branch' in result) {
        expect(result.branch).toBe('main')
        expect(result.entries).toEqual([])
      } else {
        expect(result.changes).toEqual([])
      }
      expect(settled).toBe(true)
      expect(fake.calls().length).toBeGreaterThan(0)
      expect(runner.gitScheduler.active).toBe(0)
    })
  }

  test('runGit grants a queued write before an earlier queued read', async () => {
    const repo = makeRepo(scratch())
    const fake = wrapper(`touch "$ENTERED"\nwhile [ ! -f "$RELEASE" ]; do sleep 0.01; done\nexec "$REAL_GIT" "$@"`)
    const gates = Array.from({ length: 8 }, () => Promise.withResolvers<void>())
    const holders = gates.map((gate) => runner.gitScheduler.withSlot('read', undefined, () => gate.promise))
    const read = track(runner.runGit(repo, ['rev-parse', 'HEAD'], { readOnly: true, share: false }))
    const write = track(runner.runGit(repo, ['config', '--local', 'scheduler.priority', 'write']))
    try {
      // both commands must reach the admission queue while no slot can be granted.
      await Bun.sleep(150)
      expect(fake.calls()).toHaveLength(0)
      gates[0].resolve()
      await holders[0]
      await until(() => existsSync(fake.entered))
      expect(fake.calls()).toEqual(['config --local scheduler.priority write'])
    } finally {
      writeFileSync(fake.release, '')
      for (const gate of gates) gate.resolve()
      await Promise.all(holders)
    }
    const [readResult, writeResult] = await Promise.all([read, write])
    expect(readResult.exitCode).toBe(0)
    expect(writeResult.exitCode).toBe(0)
    expect(fake.calls()).toEqual(['config --local scheduler.priority write', 'rev-parse HEAD'])
    expect(runner.gitScheduler.active).toBe(0)
  })
})

describe('composite read key isolation', () => {
  test('statusV2 keeps same-turn repositories separate', async () => {
    const firstRepo = makeRepo(scratch())
    const secondRepo = makeRepo(scratch())
    writeFileSync(join(firstRepo, 'first.txt'), 'first\n')
    writeFileSync(join(secondRepo, 'second.txt'), 'second\n')
    const [first, second] = await Promise.all([statusV2(firstRepo), statusV2(secondRepo)])
    expect(first.entries.map((entry) => entry.path)).toEqual(['first.txt'])
    expect(second.entries.map((entry) => entry.path)).toEqual(['second.txt'])
  })

  test('statusV2 keeps same-turn limits separate', async () => {
    const repo = makeRepo(scratch())
    for (const name of ['first.txt', 'second.txt', 'third.txt']) writeFileSync(join(repo, name), 'new\n')
    const [limited, full] = await Promise.all([statusV2(repo, { limit: 1 }), statusV2(repo)])
    expect(limited.capped).toBe(true)
    expect(limited.entries).toHaveLength(1)
    expect(full.capped).toBe(false)
    expect(full.entries.map((entry) => entry.path)).toEqual(['first.txt', 'second.txt', 'third.txt'])
  })

  test('statusV2 keeps same-turn shared symlink exclusions separate', async () => {
    const repo = makeRepo(scratch())
    symlinkSync('a.txt', join(repo, 'shared'))
    const [excluded, included] = await Promise.all([
      statusV2(repo, { sharedSymlinks: ['shared'] }),
      statusV2(repo)
    ])
    expect(excluded.entries).toEqual([])
    expect(included.entries.map((entry) => entry.path)).toEqual(['shared'])
  })

  test('compare keeps same-turn repositories separate', async () => {
    const firstRepo = makeRepo(scratch())
    const secondRepo = makeRepo(scratch())
    for (const [repo, name] of [[firstRepo, 'first.txt'], [secondRepo, 'second.txt']]) {
      fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(repo, name), 'new\n')
      fixtureGit(repo, 'add', name)
      fixtureGit(repo, 'commit', '-qm', name)
    }
    const [first, second] = await Promise.all([compare(firstRepo, 'main'), compare(secondRepo, 'main')])
    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    expect(first.entries.map((entry) => entry.path)).toEqual(['first.txt'])
    expect(second.entries.map((entry) => entry.path)).toEqual(['second.txt'])
  })

  test('compare keeps same-turn bases separate', async () => {
    const repo = makeRepo(scratch())
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(repo, 'first.txt'), 'first\n')
    fixtureGit(repo, 'add', 'first.txt')
    fixtureGit(repo, 'commit', '-qm', 'first')
    fixtureGit(repo, 'branch', 'middle')
    writeFileSync(join(repo, 'second.txt'), 'second\n')
    fixtureGit(repo, 'add', 'second.txt')
    fixtureGit(repo, 'commit', '-qm', 'second')
    const [fromMain, fromMiddle] = await Promise.all([compare(repo, 'main'), compare(repo, 'middle')])
    expect(fromMain.status).toBe('ready')
    expect(fromMiddle.status).toBe('ready')
    expect(fromMain.entries.map((entry) => entry.path)).toEqual(['first.txt', 'second.txt'])
    expect(fromMiddle.entries.map((entry) => entry.path)).toEqual(['second.txt'])
    expect(fromMain.ahead).toBe(2)
    expect(fromMiddle.ahead).toBe(1)
  })

  test('worktreeChangeList keeps same-turn from commits separate', async () => {
    const repo = makeRepo(scratch())
    const original = fixtureGit(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'first.txt'), 'first\n')
    fixtureGit(repo, 'add', 'first.txt')
    fixtureGit(repo, 'commit', '-qm', 'first')
    const latest = fixtureGit(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'second.txt'), 'second\n')
    const [fromOriginal, fromLatest] = await Promise.all([
      worktreeChangeList(repo, original),
      worktreeChangeList(repo, latest)
    ])
    expect(fromOriginal.changes.map((change) => change.path)).toEqual(['first.txt', 'second.txt'])
    expect(fromLatest.changes.map((change) => change.path)).toEqual(['second.txt'])
  })
})

describe('streaming early-stop child lifetime', () => {
  for (const operation of ['statusV2', 'worktreeChangeList'] as const) {
    test(`${operation} kills its capped child while the wrapper gate stays closed`, async () => {
      const repo = makeRepo(scratch())
      for (let i = 0; i < 30; i++) writeFileSync(join(repo, `untracked-${i}`), 'new\n')
      const condition = operation === 'statusV2' ? '[ "$3" = status ]' : '[ "$1" = ls-files ]'
      const fake = wrapper(`if ${condition}; then\n  touch "$ENTERED"\n  "$REAL_GIT" "$@"\n  while [ ! -f "$RELEASE" ]; do sleep 0.01; done\n  exit 0\nfi\nexec "$REAL_GIT" "$@"`)
      let settled = false
      const call = track((operation === 'statusV2'
        ? statusV2(repo, { limit: 5 }).then((result) => ({ entries: result.entries, capped: result.capped }))
        : worktreeChangeList(repo, 'HEAD', { limit: 5 }).then((result) => ({ entries: result.changes, capped: result.capped })))
        .then((result) => { settled = true; return result }))
      await until(() => settled)
      const result = await call
      expect(existsSync(fake.entered)).toBe(true)
      expect(existsSync(fake.release)).toBe(false)
      expect(result.capped).toBe(true)
      expect(result.entries).toHaveLength(5)
      expect(runner.gitScheduler.active).toBe(0)
    })
  }
})
