import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FixtureWorktree } from '../ui-review/fixtures'
import type { WindowRequestObservation } from './contracts.ts'
import { isPanelRefreshRequest } from './verdict.ts'
import { assignWorktrees, attachMetrics, chromiumArgs } from './windows.ts'

function fixtureWorktrees(): FixtureWorktree[] {
  return [
    { id: 'fixture-main', path: '/fixture', repoId: 'repo-ui', name: 'ui-review-fixture', isMain: true, status: 'idle' },
    { id: 'ready', path: '/ready', repoId: 'repo-ui', name: 'ui-review-ready', isMain: false, status: 'working' },
    { id: 'notes', path: '/notes', repoId: 'repo-ui', name: 'ui-review-notes', isMain: false, status: 'needs-you' },
    { id: 'harbor-main', path: '/harbor', repoId: 'repo-harbor', name: 'harbor-api', isMain: true, status: 'idle' },
    { id: 'retry', path: '/retry', repoId: 'repo-harbor', name: 'retry-queue', isMain: false, status: 'failing' },
    { id: 'ledger-main', path: '/ledger', repoId: 'repo-ledger', name: 'ledger-web', isMain: true, status: 'idle' },
    { id: 'export', path: '/export', repoId: 'repo-ledger', name: 'export-csv', isMain: false, status: 'done' }
  ]
}

type EventListener = (event: unknown) => void

class FakeEmitter {
  private readonly listeners = new Map<string, EventListener[]>()

  on(event: string, listener: EventListener): void {
    const handlers = this.listeners.get(event) ?? []
    handlers.push(listener)
    this.listeners.set(event, handlers)
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

function metricsForTest(): Parameters<typeof attachMetrics>[1] {
  return {
    closed: false,
    crashed: false,
    requests: new Map(),
    sockets: 0,
    lastRequestAt: null,
    pageErrors: 0,
    pageErrorExamples: [],
  }
}

function fakeSocket(url: string): FakeEmitter & { url(): string } {
  const socket = new FakeEmitter() as FakeEmitter & { url(): string }
  socket.url = () => url
  return socket
}

function sendFrame(socket: FakeEmitter, payload: unknown): void {
  socket.emit('framesent', { payload })
}

test('observes outgoing /rpc attempts across sockets without altering aggregate request metrics', () => {
  const page = new FakeEmitter()
  const metrics = metricsForTest()
  const allRequests = new Map<string, number>()
  const observed: WindowRequestObservation[] = []
  attachMetrics(
    page as never,
    metrics,
    allRequests,
    '/tmp/soak-home',
    {
      index: 3,
      worktree: 'assigned-worktree',
      onRequest: (request) => observed.push(request),
    },
  )

  const first = fakeSocket('ws://127.0.0.1/rpc')
  page.emit('websocket', first)
  const target = { jsonrpc: '2.0', id: 1, method: 'quirky.git/status', params: { worktree: 'different' } }
  sendFrame(first, JSON.stringify(target))
  sendFrame(first, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'quirky.reviews/checksRefresh', params: { force: true } }))
  sendFrame(first, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'quirky.reviews/checksRefresh', params: { force: false } }))
  sendFrame(first, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'quirky.reviews/state' }))

  const ignoredPath = fakeSocket('ws://127.0.0.1/not-rpc')
  page.emit('websocket', ignoredPath)
  sendFrame(ignoredPath, JSON.stringify(target))

  const reopened = fakeSocket('ws://127.0.0.1/rpc')
  page.emit('websocket', reopened)
  sendFrame(reopened, JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'soak.faults/feedbackRefresh',
    params: { owner: 'another-worktree' },
  }))

  expect(observed.map(({ method }) => method)).toEqual([
    'quirky.git/status',
    'quirky.reviews/checksRefresh',
    'quirky.reviews/checksRefresh',
    'quirky.reviews/state',
    'soak.faults/feedbackRefresh',
  ])
  const counted = observed.filter((request) => isPanelRefreshRequest(request.method, request.params))
  expect(counted.map(({ method }) => method)).toEqual([
    'quirky.git/status',
    'quirky.reviews/checksRefresh',
    'soak.faults/feedbackRefresh',
  ])
  expect(observed.every((request) => request.index === 3 && request.worktree === 'assigned-worktree')).toBe(true)
  expect(observed.every((request) => Number.isFinite(request.at) && request.at >= 0)).toBe(true)
  const observationTimes = observed.map((request) => request.at)
  expect(observationTimes).toEqual([...observationTimes].sort((left, right) => left - right))
  expect(observed[0]).toMatchObject({ method: 'quirky.git/status', params: target.params })
  expect(metrics.requests.get('quirky.git/status')).toBe(1)
  expect(metrics.requests.get('quirky.reviews/checksRefresh')).toBe(2)
  expect(allRequests.get('quirky.git/status')).toBe(1)
  expect(metrics.lastRequestAt).toBeGreaterThan(0)
  expect(metrics.sockets).toBe(2)
})

test('ignores malformed, array, binary and response frames while retaining large and low-ranked requests', () => {
  const page = new FakeEmitter()
  const metrics = metricsForTest()
  const observed: WindowRequestObservation[] = []
  attachMetrics(
    page as never,
    metrics,
    new Map(),
    '/tmp/soak-home',
    { index: 0, worktree: 'a', onRequest: (request) => observed.push(request) },
  )
  const socket = fakeSocket('ws://127.0.0.1/rpc')
  page.emit('websocket', socket)
  for (let index = 0; index < 20; index++) {
    sendFrame(socket, JSON.stringify({ jsonrpc: '2.0', id: index, method: `other.method${index}` }))
  }
  sendFrame(socket, '{')
  sendFrame(socket, JSON.stringify([{ jsonrpc: '2.0', method: 'quirky.git/status' }]))
  sendFrame(socket, new Uint8Array([1, 2, 3]))
  sendFrame(socket, JSON.stringify({ jsonrpc: '2.0', id: 21, result: {}, method: undefined }))
  const padded = {
    jsonrpc: '2.0',
    id: 22,
    method: 'quirky.git/status',
    params: { note: 'x'.repeat(65_536) },
  }
  sendFrame(socket, JSON.stringify(padded))

  expect(observed).toHaveLength(21)
  expect(observed.filter((request) => isPanelRefreshRequest(request.method, request.params)))
    .toHaveLength(1)
  expect(observed.at(-1)?.method).toBe('quirky.git/status')
  expect(observed.at(-1)).toMatchObject({ method: 'quirky.git/status', params: padded.params })
  expect(metrics.requests.get('quirky.git/status')).toBe(1)
  expect(metrics.requests.size).toBe(21)
  const aggregateTop15 = [...metrics.requests.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15)
  expect(aggregateTop15.some(([method]) => method === 'quirky.git/status')).toBe(false)
})

test('keeps platform isolation arguments before caller browser arguments', () => {
  const isolation = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
  expect(chromiumArgs('darwin', ['--disable-gpu'])).toEqual([isolation, '--disable-gpu'])
  expect(chromiumArgs('linux', [])).toEqual([isolation, '--no-sandbox'])
  expect(chromiumArgs('linux', ['--disable-gpu'])).toEqual([isolation, '--no-sandbox', '--disable-gpu'])
  expect(chromiumArgs('darwin', [])).toEqual([isolation])
})

test('assigns one non-main worktree from each project first', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 3)

  expect(assigned.map((worktree) => worktree.name)).toEqual([
    'ui-review-ready', 'retry-queue', 'export-csv'
  ])
})

test('continues assignment round-robin with remaining worktrees and project mains', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 7)

  expect(assigned.map((worktree) => worktree.name)).toEqual([
    'ui-review-ready', 'retry-queue', 'export-csv', 'ui-review-notes',
    'harbor-api', 'ledger-web', 'ui-review-fixture'
  ])
})

test('assigns no worktrees when the requested count is zero', () => {
  expect(assignWorktrees(fixtureWorktrees(), 0)).toEqual([])
})

test('chooses different repositories before repeating a repository', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 2)

  expect(assigned).toHaveLength(2)
  expect(new Set(assigned.map((worktree) => worktree.repoId)).size).toBe(2)
})

test('chromiumPath returns null when Playwright has no installed browsers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-chromium-path-'))
  const home = join(root, 'home')
  const browsers = join(root, 'browsers')
  mkdirSync(home)
  mkdirSync(browsers)
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, 'windows.ts')).href
  const source = `import { chromiumPath } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(chromiumPath()))`
  const child = Bun.spawn([process.execPath, '-e', source], {
    env: { ...process.env, QUIRKY_HOME: home, PLAYWRIGHT_BROWSERS_PATH: browsers },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe('null')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
