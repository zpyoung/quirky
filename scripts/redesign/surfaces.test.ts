import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { SurfaceResolution } from './contracts'
import { resolveSurfaces } from './surfaces'

const entry = join(import.meta.dir, 'surfaces.ts')

test('"changes" resolves to source control through the host tool title and carries its aliases', () => {
  const result = resolveSurfaces('changes')
  expect(result.status).toBe('one')
  const top = result.candidates[0]
  expect(top.pluginId).toBe('quirky.git')
  expect(top.score).toBe(3)
  expect(top.alsoPlugins).toEqual(['quirky.sidebar-extras'])
  const surfaces = new Map(top.surfaces.map((surface) => [surface.id, surface]))
  expect(surfaces.get('panel:quirky.git/source-control')).toMatchObject({ kind: 'panel', scoreable: true })
  expect(surfaces.get('command:quirky.git/open-changes')).toMatchObject({ title: 'View All Changes', scoreable: false })
  expect(surfaces.get('view:quirky.git/ai-settings')).toMatchObject({ kind: 'view', scoreable: true })
  expect(surfaces.get('activity-item:quirky.sidebar-extras/source-control')).toMatchObject({ kind: 'activity-item', scoreable: true })
  expect(result.candidates.map((candidate) => candidate.pluginId)).not.toContain('quirky.sidebar-extras')
})

test('"source control" matches the plugin name exactly', () => {
  const result = resolveSurfaces('Source Control')
  expect(result.status).toBe('one')
  expect(result.candidates[0].pluginId).toBe('quirky.git')
})

test('a plugin id segment matches exactly', () => {
  const result = resolveSurfaces('git')
  expect(result.status).toBe('one')
  expect(result.candidates[0]).toMatchObject({ pluginId: 'quirky.git', score: 3 })
})

test('a nonsense word gives none with the five closest plugins', () => {
  const result = resolveSurfaces('zzzqqq')
  expect(result.status).toBe('none')
  expect(result.candidates).toHaveLength(5)
  expect(result.candidates.map((candidate) => candidate.pluginId)).toEqual(
    [...result.candidates.map((candidate) => candidate.pluginId)].sort()
  )
})

test('a word shared by two plugins gives many', () => {
  const result = resolveSurfaces('settings')
  expect(result.status).toBe('many')
  const top = result.candidates[0].score
  expect(top).toBeGreaterThanOrEqual(2)
  expect(result.candidates.filter((candidate) => candidate.score === top).length).toBeGreaterThanOrEqual(2)
})

test('candidates are ordered by score then plugin id', () => {
  const { candidates } = resolveSurfaces('settings')
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]
    const current = candidates[index]
    expect(previous.score > current.score || (previous.score === current.score && previous.pluginId < current.pluginId)).toBe(true)
  }
})

test('the CLI exits 0 for one, 1 for none, and 2 without a query', () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const one = run('changes')
  expect(one.exitCode).toBe(0)
  expect((JSON.parse(one.stdout.toString()) as SurfaceResolution).status).toBe('one')
  const none = run('zzzqqq')
  expect(none.exitCode).toBe(1)
  expect((JSON.parse(none.stdout.toString()) as SurfaceResolution).status).toBe('none')
  const multi = run('source', 'control')
  expect(multi.exitCode).toBe(0)
  expect(run().exitCode).toBe(2)
})
