import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { GitStatus } from '@quirky/protocol'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import { diverge, isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const rows = (status: GitStatus) => status.entries.map((entry) => `${entry.area}:${entry.path}`)

/** Waits for one more `quirky.git/changed` than `before`, then checks no second one follows. */
async function expectOneChange(scenario: Scenario, before: number): Promise<void> {
  await waitFor(() => scenario.changedEvents() > before)
  await Bun.sleep(60)
  expect(scenario.changedEvents()).toBe(before + 1)
}

describe('staging', () => {
  test('SC-12: rows and renames stage and unstage, each call announcing one change (CLI)', async () => {
    s = await startScenario(scratch)
    s.write('math.ts', 'a\nb\nc\nd\ne\nf\n')
    s.gitIn('mv', 'old.ts', 'new.ts')
    s.write('notes.txt', 'x\n')

    let before = s.changedEvents()
    const stage = await s.cli(['git', 'stage', '--paths', 'math.ts', '--paths', 'notes.txt'])
    expect(stage.code).toBe(0)
    await expectOneChange(s, before)
    expect(rows(await s.api('status'))).toEqual(['staged:math.ts', 'staged:new.ts', 'staged:notes.txt'])

    before = s.changedEvents()
    const unstage = await s.cli(['git', 'unstage', '--paths', 'new.ts'])
    expect(unstage.code).toBe(0)
    await expectOneChange(s, before)
    const status: GitStatus = await s.api('status')
    expect(rows(status)).toEqual(['staged:math.ts', 'staged:notes.txt', 'unstaged:old.ts', 'untracked:new.ts'].sort((a, b) => a.split(':')[1]!.localeCompare(b.split(':')[1]!)))
    expect(status.entries.find((entry) => entry.path === 'old.ts')).toMatchObject({ area: 'unstaged', status: 'deleted' })
  })

  test('stage takes exactly one of paths and scope, and a failure announces nothing', async () => {
    s = await startScenario(scratch)
    expect((await s.fails(s.api('stage'))).message).toBe('Pass exactly one of paths or scope.')
    expect((await s.fails(s.api('stage', { paths: ['a.ts'], scope: 'all' }))).code).toBe(-32602)
    expect((await s.fails(s.api('stage', { paths: [] }))).code).toBe(-32602)
    const before = s.changedEvents()
    const failure = await s.fails(s.api('stage', { paths: ['missing.txt'] }))
    expect(failure).toMatchObject({ code: -32009, data: { reason: 'failed' } })
    await Bun.sleep(60)
    expect(s.changedEvents()).toBe(before)
  })

  test('SC-7: a submodule root is refused with "Stage inside submodule" and nothing is staged (CLI)', async () => {
    s = await startScenario(scratch)
    s.addSubmodule()

    const status = JSON.parse((await s.cli(['git', 'status', '--json'])).stdout) as GitStatus
    expect(status.entries).toMatchObject([{ path: 'vendor/lib', submodule: { trackedChanges: true } }])
    const inside = JSON.parse((await s.cli(['git', 'submoduleStatus', '--path', 'vendor/lib', '--json'])).stdout)
    expect(inside.entries).toMatchObject([{ path: 'x.c', area: 'unstaged', status: 'modified' }])

    const refused = await s.cli(['git', 'stage', '--paths', 'vendor/lib', '--json'])
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stderr || refused.stdout)).toMatchObject({ error: { message: 'Stage inside submodule' } })
    expect(s.gitIn('diff', '--cached', '--name-only')).toBe('')
    const other = await s.fails(s.api('submoduleStatus', { path: 'math.ts' }))
    expect(other).toMatchObject({ code: -32602, data: { reason: 'not-allowed' } })
  })

  test('SC-13: a conflict is staged only once its markers are gone, a deleted one as a deletion', async () => {
    s = await startScenario(scratch)
    s.addSubmodule()
    diverge(s, { 'a.ts': 'theirs\n', 'b.ts': 'theirs\n', 'c.ts': null }, { 'a.ts': 'ours\n', 'b.ts': 'ours\n', 'c.ts': 'ours\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)
    s.write('b.ts', 'resolved\n')
    rmSync(join(s.feat.path, 'c.ts'))

    const refused = await s.fails(s.api('stage', { paths: ['a.ts'] }))
    expect(refused).toMatchObject({
      code: -32602,
      message: 'Resolve the conflict markers in a.ts before staging it.',
      data: { reason: 'not-stageable' }
    })
    expect(s.gitIn('diff', '--name-only', '--diff-filter=U').split('\n')).toEqual(['a.ts', 'b.ts', 'c.ts'])

    await s.api('stage', { paths: ['b.ts'] })
    await s.api('stage', { paths: ['c.ts'] })
    expect(s.gitIn('diff', '--name-only', '--diff-filter=U')).toBe('a.ts')
    expect(s.gitIn('status', '--porcelain', '--', 'c.ts')).toBe('D  c.ts')

    const submodule = await s.fails(s.api('stage', { paths: ['vendor/lib'] }))
    expect(submodule).toMatchObject({ message: 'Stage inside submodule', data: { reason: 'not-stageable' } })
  })

  test('unstage adds the old path of a staged rename on any caller', async () => {
    s = await startScenario(scratch)
    s.gitIn('mv', 'old.ts', 'new.ts')
    await s.api('unstage', { paths: ['new.ts'] })
    expect(rows(await s.api('status'))).toEqual(['untracked:new.ts', 'unstaged:old.ts'])
  })
})
