import { expect, test } from 'bun:test'
import type { ProcessRunner, PtySessionInfo, RunOptions, RunResult } from '@quirky/protocol'
import {
  collectMemorySnapshot,
  parseMemoryProcessTable,
  readMemoryProcessTable,
  type MemoryDeps
} from '../src/memory'

const KIB = 1024

function session(
  sessionId: string,
  pid: number,
  state: PtySessionInfo['state'] = 'running',
  options: { cwd?: string; title?: string | null } = {}
): PtySessionInfo {
  return {
    sessionId,
    state,
    pid,
    alive: state === 'running',
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    cols: 80,
    rows: 24,
    argv: ['/bin/zsh'],
    cwd: options.cwd ?? '/repo',
    title: options.title ?? null,
    shellState: 'ready',
    createdAt: 1,
    offset: 0
  }
}

function deps(overrides: Partial<MemoryDeps> = {}): MemoryDeps {
  return {
    daemonPid: 100,
    memoryUsage: () => ({ heapUsed: 11, heapTotal: 22, external: 33 }),
    pty: { hostPid: 200, connected: true, list: async () => [] },
    readProcessTable: async () => ({ readerPid: 9000, text: '' }),
    now: () => 1234,
    ...overrides
  }
}

function runResult(stdoutText: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

test('builds the daemon, PTY host and per-session trees from one process table and counts each process once in the totals', async () => {
  const text = [
    '100 1 1000 quirkyd',
    '101 100 50 git',
    '102 101 25 ssh',
    '200 1 300 quirky-pty',
    '300 1 40 zsh',
    '301 300 400 node',
    '400 1 30 bash',
    '999 1 12 unrelated'
  ].join('\n')
  const report = await collectMemorySnapshot(
    deps({
      pty: {
        hostPid: 200,
        connected: true,
        list: async () => [
          session('s1', 300, 'running', { cwd: '/repo/one', title: 'One' }),
          session('s2', 400, 'running', { cwd: '/repo/two' }),
          session('restorable', 500, 'restorable'),
          session('zero', 0),
          session('missing', 600)
        ]
      },
      readProcessTable: async () => ({ readerPid: 9000, text })
    })
  )

  expect(report.schemaVersion).toBe(1)
  expect(report.takenAt).toBe(1234)
  expect(report.daemon).toEqual({
    pid: 100,
    rssBytes: 1000 * KIB,
    heapUsedBytes: 11,
    heapTotalBytes: 22,
    externalBytes: 33,
    descendants: {
      processCount: 2,
      rssBytes: 75 * KIB,
      processes: [
        { pid: 101, ppid: 100, rssBytes: 50 * KIB, name: 'git' },
        { pid: 102, ppid: 101, rssBytes: 25 * KIB, name: 'ssh' }
      ],
      omitted: 0
    }
  })
  expect(report.ptyHost).toEqual({ pid: 200, alive: true, rssBytes: 300 * KIB })
  expect(report.sessions).toEqual([
    {
      sessionId: 's1',
      pid: 300,
      title: 'One',
      cwd: '/repo/one',
      tree: {
        processCount: 2,
        rssBytes: 440 * KIB,
        processes: [
          { pid: 301, ppid: 300, rssBytes: 400 * KIB, name: 'node' },
          { pid: 300, ppid: 1, rssBytes: 40 * KIB, name: 'zsh' }
        ],
        omitted: 0
      }
    },
    {
      sessionId: 's2',
      pid: 400,
      title: null,
      cwd: '/repo/two',
      tree: {
        processCount: 1,
        rssBytes: 30 * KIB,
        processes: [{ pid: 400, ppid: 1, rssBytes: 30 * KIB, name: 'bash' }],
        omitted: 0
      }
    },
    {
      sessionId: 'missing',
      pid: 600,
      title: null,
      cwd: '/repo',
      tree: { processCount: 0, rssBytes: 0, processes: [], omitted: 0 }
    }
  ])
  expect(report.totals).toEqual({ processCount: 7, rssBytes: (1000 + 75 + 300 + 440 + 30) * KIB })
  expect(JSON.stringify(report)).not.toContain('999')

  const hostSubtree = await collectMemorySnapshot(
    deps({
      pty: { hostPid: 200, connected: true, list: async () => [session('nested', 300)] },
      readProcessTable: async () => ({
        readerPid: 9000,
        text: ['100 1 1000 quirkyd', '101 100 50 git', '200 100 300 quirky-pty', '300 200 40 zsh', '301 300 400 node'].join('\n')
      })
    })
  )
  expect(hostSubtree.daemon.descendants).toMatchObject({ processCount: 1, rssBytes: 50 * KIB })
  expect(hostSubtree.ptyHost.rssBytes).toBe(300 * KIB)
  expect(hostSubtree.sessions[0]?.tree).toMatchObject({ processCount: 2, rssBytes: 440 * KIB })
  expect(hostSubtree.totals).toEqual({ processCount: 5, rssBytes: (1000 + 50 + 300 + 440) * KIB })

  const withReader = await collectMemorySnapshot(
    deps({
      pty: {
        hostPid: 200,
        connected: true,
        list: async () => [session('s1', 300), session('s2', 400)]
      },
      readProcessTable: async () => ({ readerPid: 150, text: `${text}\n150 100 900 ps\n160 100 80 ps` })
    })
  )
  expect(withReader.daemon.descendants).toMatchObject({ processCount: 3, rssBytes: (50 + 25 + 80) * KIB })
  expect(withReader.totals).toEqual({ processCount: 8, rssBytes: (1000 + 75 + 80 + 300 + 440 + 30) * KIB })
  expect(withReader.daemon.descendants?.processes.map(({ pid }) => pid)).not.toContain(150)
  expect(withReader.sessions.flatMap(({ tree }) => tree?.processes.map(({ pid }) => pid) ?? [])).not.toContain(150)

  const readerMissingFromTable = await collectMemorySnapshot(
    deps({
      pty: {
        hostPid: 200,
        connected: true,
        list: async () => [session('s1', 300), session('s2', 400)]
      },
      readProcessTable: async () => ({ readerPid: 150, text })
    })
  )
  expect(readerMissingFromTable.daemon.descendants).toEqual(report.daemon.descendants)
  expect(readerMissingFromTable.totals).toEqual(report.totals)

  const cyclic = await collectMemorySnapshot(
    deps({
      pty: { hostPid: 200, connected: true, list: async () => [session('cycle', 300)] },
      readProcessTable: async () => ({
        readerPid: 9000,
        text: ['100 1 1000 quirkyd', '200 1 300 quirky-pty', '300 301 40 zsh', '301 300 50 child'].join('\n')
      })
    })
  )
  expect(cyclic.sessions[0]?.tree).toMatchObject({ processCount: 2, rssBytes: 90 * KIB })
  expect(cyclic.totals).toEqual({ processCount: 4, rssBytes: (1000 + 300 + 90) * KIB })
})

test('lists at most 50 processes per tree by size and reports the rest as omitted', async () => {
  const children = Array.from({ length: 60 }, (_, index) => `${301 + index} 300 ${index + 1} child-${index + 1}`)
  const report = await collectMemorySnapshot(
    deps({
      pty: {
        hostPid: 200,
        connected: true,
        list: async () => [session('large', 300)]
      },
      readProcessTable: async () => ({
        readerPid: 9000,
        text: ['100 1 1000 quirkyd', '200 1 300 quirky-pty', '300 1 100 root', ...children].join('\n')
      })
    })
  )

  const tree = report.sessions[0]!.tree!
  expect(tree.processCount).toBe(61)
  expect(tree.processes).toHaveLength(50)
  expect(tree.processes.map(({ rssBytes }) => rssBytes)).toEqual([
    100 * KIB,
    ...Array.from({ length: 49 }, (_, index) => (60 - index) * KIB)
  ])
  expect(tree.omitted).toBe(11)
  expect(tree.rssBytes).toBe((100 + (60 * 61) / 2) * KIB)
})

test('reports process names only, never arguments', async () => {
  const longName = 'x'.repeat(200)
  const parsed = parseMemoryProcessTable(
    [
      '120 100 42 /usr/bin/sleep',
      '121 100 43 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `122 100 44 ${longName}`
    ].join('\n')
  )
  expect(parsed).toEqual([
    { pid: 120, ppid: 100, rssBytes: 42 * KIB, name: 'sleep' },
    { pid: 121, ppid: 100, rssBytes: 43 * KIB, name: 'Google Chrome' },
    { pid: 122, ppid: 100, rssBytes: 44 * KIB, name: longName.slice(0, 64) }
  ])
  expect(JSON.stringify(parsed)).not.toMatch(/argv|arguments/)

  const calls: { argv: readonly string[]; options?: RunOptions }[] = []
  const runner: Pick<ProcessRunner, 'run'> = {
    async run(argv, options) {
      calls.push({ argv, options })
      return runResult('4321\n100 1 100 quirkyd\n')
    }
  }
  expect(await readMemoryProcessTable(runner)).toEqual({ readerPid: 4321, text: '100 1 100 quirkyd\n' })
  expect(calls).toEqual([
    {
      argv: ['/bin/sh', '-c', 'echo $$; exec ps -A -o pid=,ppid=,rss=,comm='],
      options: { env: { LC_ALL: 'C' }, timeoutMs: 5000, share: true, rerunnable: true }
    }
  ])

  for (const outcome of [
    runResult('4321\n100 1 100 quirkyd\n', { exitCode: 1 }),
    runResult('4321\n100 1 100 quirkyd\n', { exitCode: null, stopped: 'timeout' }),
    runResult('0\n100 1 100 quirkyd\n'),
    runResult('-1\n100 1 100 quirkyd\n'),
    runResult('not-a-pid\n100 1 100 quirkyd\n')
  ]) {
    expect(await readMemoryProcessTable({ run: async () => outcome })).toBeNull()
  }
})

test('a disconnected PTY host is reported without listing sessions or reconnecting', async () => {
  let listCalls = 0
  const report = await collectMemorySnapshot(
    deps({
      pty: {
        hostPid: 200,
        connected: false,
        async list() {
          listCalls++
          return [session('ignored', 300)]
        }
      },
      readProcessTable: async () => ({ readerPid: 9000, text: '100 1 1000 quirkyd\n200 100 300 quirky-pty\n' })
    })
  )

  expect(listCalls).toBe(0)
  expect(report.ptyHost).toEqual({ pid: 200, alive: false, rssBytes: 300 * KIB })
  expect(report.sessions).toEqual([])
  expect(report.unavailable).toEqual([{ part: 'pty-host', reason: 'PTY host is not connected' }])
})

test('a missing process table leaves memory figures null and names the part that was unavailable', async () => {
  const report = await collectMemorySnapshot(
    deps({
      pty: { hostPid: 200, connected: true, list: async () => [session('s1', 300)] },
      readProcessTable: async () => null
    })
  )

  expect(report.daemon.rssBytes).toBeNull()
  expect(report.daemon.descendants).toBeNull()
  expect(report.daemon.heapUsedBytes).toBe(11)
  expect(report.daemon.heapTotalBytes).toBe(22)
  expect(report.daemon.externalBytes).toBe(33)
  expect(report.ptyHost.rssBytes).toBeNull()
  expect(report.sessions).toHaveLength(1)
  expect(report.sessions[0]?.tree).toBeNull()
  expect(report.totals).toBeNull()
  expect(report.unavailable.some(({ part }) => part === 'process-table')).toBe(true)
  expect(() =>
    parseMemoryProcessTable(['invalid 100 10 bad-pid', '123 100 -1 negative-rss', '124 100 5 valid'].join('\n'))
  ).not.toThrow()
  expect(parseMemoryProcessTable(['invalid 100 10 bad-pid', '123 100 -1 negative-rss', '124 100 5 valid'].join('\n'))).toEqual([
    { pid: 124, ppid: 100, rssBytes: 5 * KIB, name: 'valid' }
  ])
})

test('a failed session list keeps the daemon and host figures and names pty-sessions as unavailable', async () => {
  const report = await collectMemorySnapshot(
    deps({
      pty: {
        hostPid: 200,
        connected: true,
        async list() {
          throw new Error('PTY session listing failed')
        }
      },
      readProcessTable: async () => ({
        readerPid: 9000,
        text: '100 1 1000 quirkyd\n101 100 50 git\n200 1 300 quirky-pty\n'
      })
    })
  )

  expect(report.daemon.rssBytes).toBe(1000 * KIB)
  expect(report.daemon.descendants).toMatchObject({ processCount: 1, rssBytes: 50 * KIB })
  expect(report.ptyHost).toEqual({ pid: 200, alive: true, rssBytes: 300 * KIB })
  expect(report.sessions).toEqual([])
  expect(report.unavailable).toContainEqual({ part: 'pty-sessions', reason: 'PTY session listing failed' })
  expect(report.totals).not.toBeNull()
})
