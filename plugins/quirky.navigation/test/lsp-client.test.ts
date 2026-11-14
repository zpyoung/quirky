import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NavigationServer, ServerLocation } from '../src/servers'
import { LspStartError, startLspServer } from '../src/lsp-client'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'

const fakePath = join(import.meta.dir, 'fixtures', 'fake-lsp.ts')
type Context = { root: string; runner: OwnedProcessRunner; server?: NavigationServer }
const active: Context[] = []

afterEach(async () => {
  for (const context of active.splice(0)) {
    if (context.server) await context.server.stop()
    await context.runner.dispose()
    rmSync(context.root, { recursive: true, force: true })
  }
})

function makeContext(): Context {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nav lsp é-')))
  writeFileSync(join(root, 'source.py'), 'source\n')
  writeFileSync(join(root, 'target.py'), 'target\n')
  const context = {
    root,
    runner: createProcessRunner({ owner: `lsp-client-test-${crypto.randomUUID()}` }),
  }
  active.push(context)
  return context
}

async function start(
  context: Context,
  behavior: string,
  options: { readyTimeoutMs?: number; shutdownTimeoutMs?: number } = {},
): Promise<NavigationServer> {
  const server = await startLspServer({
    process: context.runner,
    argv: [process.execPath, fakePath, behavior],
    root: context.root,
    runtime: process.execPath,
    serverPath: fakePath,
    ...options,
  })
  context.server = server
  return server
}

function location(
  path: string,
  line: number,
  column: number,
  endLine: number,
  endColumn: number,
): ServerLocation {
  return { path, line, column, endLine, endColumn }
}

function expectProcessGone(pid: number): void {
  let error: unknown
  try {
    process.kill(pid, 0)
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ code: 'ESRCH' })
}

function recordedPid(root: string): number {
  const pid = Number(readFileSync(join(root, '.fake-lsp.pid'), 'utf8'))
  expect(Number.isInteger(pid)).toBe(true)
  return pid
}

test('initializes with the worktree URI and UTF-16 before making navigation requests', async () => {
  const context = makeContext()
  const server = await start(context, 'normal')

  expect(await server.definition(join(context.root, 'source.py'), 5, 21)).toEqual([
    location(join(context.root, 'target.py'), 4, 17, 4, 22),
  ])
  expect(await server.references(join(context.root, 'source.py'), 5, 21)).toEqual([])
  await server.stop()

  const methods = (await server.exited).stderrTail.trim().split('\n')
  expect(methods.indexOf('initialized')).toBeGreaterThanOrEqual(0)
  expect(methods.indexOf('initialized')).toBeLessThan(methods.indexOf('textDocument/definition'))
})

test('maps Location, Location[], LocationLink[] and null results in order', async () => {
  const context = makeContext()
  const server = await start(context, 'shapes')
  const source = join(context.root, 'source.py')
  const target = join(context.root, 'target.py')
  const other = join(context.root, 'other.py')

  expect(await server.definition(source, 1, 1)).toEqual([location(target, 4, 17, 4, 22)])
  expect(await server.definition(source, 1, 1)).toEqual([
    location(target, 4, 17, 4, 22),
    location(other, 2, 3, 2, 5),
  ])
  expect(await server.definition(source, 1, 1)).toEqual([location(target, 6, 3, 6, 7)])
  expect(await server.definition(source, 1, 1)).toEqual([])
  expect(await server.definition(source, 1, 1)).toEqual([location(target, 4, 17, 4, 22)])
})

test('rejects a server error without poisoning the next request', async () => {
  const context = makeContext()
  const server = await start(context, 'error')
  const pid = server.pid

  await expect(server.definition(join(context.root, 'source.py'), 1, 1)).rejects.toThrow('kaput')
  expect(await server.definition(join(context.root, 'source.py'), 1, 1)).toEqual([
    location(join(context.root, 'target.py'), 4, 17, 4, 22),
  ])
  expect(server.pid).toBe(pid)
})

test('answers server requests before completing initialization', async () => {
  const context = makeContext()
  const server = await start(context, 'asks')

  expect(await server.definition(join(context.root, 'source.py'), 5, 21)).toEqual([
    location(join(context.root, 'target.py'), 4, 17, 4, 22),
  ])
})

test('rejects a server that selects a non-UTF-16 position encoding and stops it', async () => {
  const context = makeContext()

  await expect(start(context, 'utf8')).rejects.toThrow('utf-8')
  expectProcessGone(recordedPid(context.root))
})

test('reports early process exit with its exit code and stderr', async () => {
  const context = makeContext()
  const error = await start(context, 'die').catch((value: unknown) => value)

  expect(error).toBeInstanceOf(LspStartError)
  expect((error as LspStartError).exitCode).toBe(7)
  expect((error as Error).message).toContain('boom')
  expect((error as LspStartError).stderrTail).toContain('boom')
  expectProcessGone(recordedPid(context.root))
})

test('stops a server that does not answer initialize before the ready timeout', async () => {
  const context = makeContext()

  await expect(start(context, 'silent', { readyTimeoutMs: 300 })).rejects.toThrow('did not answer initialize')
  expectProcessGone(recordedPid(context.root))
})

test('rejects an in-flight request when the server exits', async () => {
  const context = makeContext()
  const server = await start(context, 'exit-on-request')

  await expect(server.definition(join(context.root, 'source.py'), 1, 1)).rejects.toThrow(/exited.*9/)
  expect(await server.exited).toMatchObject({ exitCode: 9 })
})

test('shuts down gracefully and force-stops an unresponsive server after its timeout', async () => {
  const gracefulContext = makeContext()
  const graceful = await start(gracefulContext, 'normal')
  const gracefulPid = graceful.pid!

  await graceful.stop()
  expect(await graceful.exited).toMatchObject({ exitCode: 0 })
  expect((await graceful.exited).stderrTail.trim().split('\n').slice(-2)).toEqual(['shutdown', 'exit'])
  expectProcessGone(gracefulPid)

  const stubbornContext = makeContext()
  const stubborn = await start(stubbornContext, 'stubborn', { shutdownTimeoutMs: 200 })
  const stubbornPid = stubborn.pid!
  const startedAt = Date.now()

  await stubborn.stop()
  expect(Date.now() - startedAt).toBeLessThan(3_000)
  expectProcessGone(stubbornPid)
})
