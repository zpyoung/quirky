import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { TsServer } from '../src/tsserver'
import type { ServerLocation } from '../src/servers'

const fixturePath = join(import.meta.dir, 'fixtures', 'ts')
const worktrees: string[] = []
const children: Array<{ server: TsServer; runner: OwnedProcessRunner }> = []

afterEach(async () => {
  const active = children.splice(0)
  for (const { server } of active) await server.stop()
  for (const { runner } of active) await runner.dispose()
  for (const worktree of worktrees.splice(0)) rmSync(worktree, { recursive: true, force: true })
})

async function startServer() {
  const worktreePath = mkdtempSync(join(tmpdir(), 'nav ts é-'))
  worktrees.push(worktreePath)
  cpSync(fixturePath, worktreePath, { recursive: true })
  const runner = createProcessRunner({ owner: `tsserver-test-${crypto.randomUUID()}` })
  const server = new TsServer({
    process: runner,
    worktreePath,
    serverPath: Bun.resolveSync('typescript/lib/tsserver.js', import.meta.dir),
    runtime: process.execPath,
  })
  children.push({ server, runner })
  return { worktreePath, server }
}

function location(worktreePath: string, relativePath: string, line: number, column: number, endLine: number, endColumn: number) {
  return { path: join(worktreePath, relativePath), line, column, endLine, endColumn }
}

test('answers definitions and references and follows disk changes', async () => {
  const { worktreePath, server } = await startServer()
  const usePath = join(worktreePath, 'src', 'use.ts')
  const greetPath = join(worktreePath, 'src', 'greet.ts')
  const originalUse = readFileSync(usePath, 'utf8')

  expect(await server.definition(usePath, 4, 27)).toEqual([
    location(worktreePath, 'src/greet.ts', 3, 17, 3, 22),
  ])
  const references = await server.references(usePath, 4, 27)
  references.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.column - b.column)
  expect(references).toEqual([
    location(worktreePath, 'src/greet.ts', 3, 17, 3, 22),
    location(worktreePath, 'src/greet.ts', 11, 30, 11, 35),
    location(worktreePath, 'src/index.ts', 1, 10, 1, 15),
    location(worktreePath, 'src/use.ts', 1, 10, 1, 15),
    location(worktreePath, 'src/use.ts', 4, 27, 4, 32),
    location(worktreePath, 'src/use.ts', 7, 23, 7, 28),
  ])

  writeFileSync(usePath, `\n\n${originalUse}`)
  expect(await server.definition(usePath, 6, 27)).toEqual([
    location(worktreePath, 'src/greet.ts', 3, 17, 3, 22),
  ])

  writeFileSync(usePath, originalUse)
  expect(await server.definition(usePath, 4, 27)).toEqual([
    location(worktreePath, 'src/greet.ts', 3, 17, 3, 22),
  ])
  writeFileSync(greetPath, `\n\n${readFileSync(greetPath, 'utf8')}`)
  // fake timers cannot advance tsserver's filesystem watcher in another process.
  const deadline = Date.now() + 10_000
  let movedDefinition: ServerLocation[] = []
  while (Date.now() < deadline) {
    movedDefinition = await server.definition(usePath, 4, 27)
    if (movedDefinition[0]?.line === 5) break
    await Bun.sleep(100)
  }
  expect(movedDefinition).toEqual([
    location(worktreePath, 'src/greet.ts', 5, 17, 5, 22),
  ])
}, 60_000)

test('refreshes dependencies retained as open files before navigating a caller', async () => {
  const { worktreePath, server } = await startServer()
  const greetPath = join(worktreePath, 'src/greet.ts')
  await server.definition(greetPath, 3, 17)
  writeFileSync(greetPath, `\n\n${readFileSync(greetPath, 'utf8')}`)
  expect(await server.definition(join(worktreePath, 'src/use.ts'), 4, 27)).toEqual([
    location(worktreePath, 'src/greet.ts', 5, 17, 5, 22),
  ])
}, 60_000)

test('closing a deleted retained file does not poison navigation in the worktree', async () => {
  const { worktreePath, server } = await startServer()
  const extraPath = join(worktreePath, 'src/extra.ts')
  writeFileSync(extraPath, 'function extra() {}\nextra()\n')
  await server.definition(extraPath, 2, 1)
  rmSync(extraPath)
  expect(await server.definition(join(worktreePath, 'src/use.ts'), 4, 27)).toEqual([
    location(worktreePath, 'src/greet.ts', 3, 17, 3, 22),
  ])
}, 60_000)

test('stops the child without waiting for an in-flight stdin write', async () => {
  let stopCalled = false
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<SpawnExit>()
  const exit = { exitCode: 0, signal: null, durationMs: 0 } satisfies SpawnExit
  const child: SpawnedProcess = {
    pid: 1,
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    stderrTail: () => '',
    write: () => new Promise<boolean>(() => {}),
    closeInput: async () => {},
    exited,
    stop: async () => {
      stopCalled = true
      resolveExited(exit)
      return exit
    },
  }
  const spawner: ProcessSpawner = { spawn: () => child }
  const server = new TsServer({
    process: spawner,
    worktreePath: fixturePath,
    serverPath: 'unused',
    runtime: process.execPath,
  })

  const stopping = server.stop()
  expect(stopCalled).toBe(true)
  await stopping
  expect(await server.exited).toEqual({ exitCode: 0, stderrTail: '' })
})
