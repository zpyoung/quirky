import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcErrorCode, type CliContext } from '@quirky/protocol'
import { formatRecord, formatTable } from '../../../packages/cli/src/output'
import { commands } from '../cli'
import { call, failure, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { testCliContext } from '../../quirky.repo/test/harness'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { addExternalWorktree, startRealProject, type RealProject } from './fixtures/real-project'
import { setSetting } from './fixtures/repos'
import { isPortFree } from '../src/daemon/ports'
import { join } from 'node:path'

setDefaultTimeout(60_000)
const { scratch } = isolateGitConfig()
let project: RealProject | undefined
afterEach(async () => { await project?.t.cleanup(); project = undefined })

type Blocks = { blocks: Array<{ worktreeId: string; name: string; path: string | null; base: number; count: number; last: number }> }
async function start() {
  project = await startRealProject(scratch)
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 42000 + Math.floor(Math.random() * 59) * 100
    let free = true
    for (let port = base; port < base + 200; port++) {
      if (!await isPortFree(port)) { free = false; break }
    }
    if (!free) continue
    await setSetting(project.client, 'portRangeStart', base)
    await setSetting(project.client, 'portRangeEnd', base + 199)
    return base
  }
  throw new Error('no free test port range')
}

function context(result: unknown, json = false) {
  const calls: Array<{ method: string; params: unknown }> = []
  const lines: string[] = []
  const ctx: CliContext = {
    requestBase: crypto.randomUUID(),
    call: async (method, params) => { calls.push({ method, params }); return result },
    out: { json, result: (value, text) => lines.push(json ? JSON.stringify(value) : text()), line: (text) => lines.push(text), jsonLine: (value) => lines.push(JSON.stringify(value)) },
    format: { table: formatTable, record: formatRecord }, env: {}, cwd: '/',
    readFile: async () => '', sleep: async () => {}, now: () => 0,
    usage: (message) => new Error(message), fail: (message) => new Error(message), reconnect: async () => {}
  }
  return { ctx, calls, lines }
}

const result = { blocks: [{ worktreeId: 'wt_a', name: 'API', path: '/work/api', base: 42000, count: 10, last: 42009 }] }
test('ports prints the block range, worktree name and ID', async () => {
  const t = context(result)
  await commands.ports!({ positionals: [], flags: {} }, t.ctx)
  expect(t.calls).toEqual([{ method: 'quirky.worktree/ports', params: {} }])
  expect(t.lines).toEqual([formatTable(['PORTS', 'WORKTREE', 'ID'], [['42000-42009', 'API', 'wt_a']])])
})

test('ports prints an empty report and preserves JSON and selector', async () => {
  const empty = context({ blocks: [] })
  await commands.ports!({ positionals: [], flags: {} }, empty.ctx)
  expect(empty.lines).toEqual(['no port blocks'])
  const json = context(result, true)
  await commands.ports!({ positionals: [], flags: { worktree: 'id:wt_a' } }, json.ctx)
  expect(json.calls).toEqual([{ method: 'quirky.worktree/ports', params: { worktree: 'id:wt_a' } }])
  expect(JSON.parse(json.lines[0]!)).toEqual(result)
})

test('method lazily allocates a selector, lists by base, reports names and rejects unknown selectors', async () => {
  const base = await start()
  const p = project!
  expect(await call(p.client, 'quirky.worktree/ports')).toEqual({ blocks: [] })
  const external = addExternalWorktree(p.repoDir, join(scratch(), 'external'), 'external')
  const first = await call(p.client, 'quirky.worktree/ports', { worktree: `path:${external}` }) as Blocks
  const a = first.blocks[0]!
  expect(a).toMatchObject({ name: 'external', path: external, base, count: 10, last: base + 9 })
  await call(p.client, 'quirky.worktree/set', { worktree: a.worktreeId, displayName: 'Backend' })
  const second = await call(p.client, 'quirky.worktree/ports', { worktree: `path:${p.repoDir}` }) as Blocks
  expect(second.blocks[0]).toMatchObject({ name: 'api', base: base + 10, last: base + 19 })
  const listed = await call(p.client, 'quirky.worktree/ports') as Blocks
  expect(listed.blocks).toEqual([{ ...a, name: 'Backend' }, second.blocks[0]!])
  const one = testCliContext(p.client)
  await commands.ports!({ positionals: [], flags: { worktree: a.worktreeId } }, one.ctx)
  expect(one.lines).toEqual([formatTable(['PORTS', 'WORKTREE', 'ID'], [[`${base}-${base + 9}`, 'Backend', a.worktreeId]])])
  expect(await failure(call(p.client, 'quirky.worktree/ports', { worktree: 'id:missing' }))).toMatchObject({ code: RpcErrorCode.NotFound })
  const process = spawnCli(['wt', 'ports', '--json'], { home: p.t.h.home })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  expect({ stderr, exitCode }).toEqual({ stderr: '', exitCode: 0 })
  expect(JSON.parse(stdout)).toEqual(listed)
})

test('method returns Conflict for exhausted and invalid settings but preserves a held block', async () => {
  const base = await start()
  const p = project!
  await setSetting(p.client, 'portRangeEnd', base + 9)
  const primary = await call(p.client, 'quirky.worktree/ports', { worktree: `path:${p.repoDir}` }) as Blocks
  const external = addExternalWorktree(p.repoDir, join(scratch(), 'external'), 'external')
  expect(await failure(call(p.client, 'quirky.worktree/ports', { worktree: `path:${external}` }))).toMatchObject({
    code: RpcErrorCode.Conflict, message: `no free block of 10 ports between ${base} and ${base + 9}`
  })
  await setSetting(p.client, 'portBlockSize', 2.5)
  expect(await failure(call(p.client, 'quirky.worktree/ports', { worktree: `path:${external}` }))).toMatchObject({
    code: RpcErrorCode.Conflict, message: 'port range is invalid: portBlockSize must be a whole number'
  })
  expect(await call(p.client, 'quirky.worktree/ports', { worktree: `path:${p.repoDir}` })).toEqual(primary)
})
