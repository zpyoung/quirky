import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  // Poll the real filesystem watcher; fake timers cannot advance OS file notifications.
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
