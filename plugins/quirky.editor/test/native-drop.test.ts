import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyClient, UiPluginContext } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import type { droppedFileTargets as DroppedFileTargets } from '../src/window/DocumentSurface'
import type { EditorOpenResult } from '../src/types'
import { registerIsolatedEditorFixtures } from './isolated-environment'

type Fixture = { harness: Harness; client: QuirkyClient; root: string; worktreeId: string; external: string }

let droppedFileTargets: typeof DroppedFileTargets
const fixtures = new Set<Fixture>()

registerIsolatedEditorFixtures(async () => {
  for (const fixture of fixtures) {
    fixtures.delete(fixture)
    try {
      await fixture.harness.cleanup()
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
      rmSync(fixture.external, { recursive: true, force: true })
    }
  }
})

beforeAll(async () => {
  // DocumentSurface's editor modules read browser globals when they load.
  GlobalRegistrator.register()
  ;({ droppedFileTargets } = await import('../src/window/DocumentSurface'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function makeFixture(): Promise<Fixture> {
  const repo = mkdtempSync(join(tmpdir(), 'quirky-editor-native-drop-'))
  const external = mkdtempSync(join(tmpdir(), 'quirky-editor-native-drop-outside-'))
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`)
  mkdirSync(join(repo, 'notes'))
  writeFileSync(join(repo, 'notes', 'plan.md'), 'inside\n')
  writeFileSync(join(repo, 'notes', 'report.txt'), 'existing\n')
  writeFileSync(join(external, 'report.txt'), 'external\n')

  const harness = await startHarness({ home: makeHomeWithoutAutoHooks('quirky-editor-native-drop-home-'), builtinPluginsDir: builtinsDir() })
  const client = await harness.connect('cli', 'editor-native-drop-test')
  await client.callAny('quirky.repo/add', { path: repo })
  const worktree = await client.callAny('quirky.worktree/resolve', { selector: `path:${repo}` }) as { id: string }
  // the editor reports the realpath'd root, as Finder reports dropped paths
  const documentRoot = await client.callAny('quirky.editor/documentRoot', { worktree: worktree.id }) as { path: string }
  const fixture = { harness, client, root: documentRoot.path, worktreeId: worktree.id, external }
  fixtures.add(fixture)
  return fixture
}

function dropContext(fixture: Fixture, sourcePaths: string[] | null): UiPluginContext {
  return {
    call: (method: string, params: Record<string, unknown> = {}) => fixture.client.callAny(method, params),
    nativeDropPaths: async () => sourcePaths
  } as unknown as UiPluginContext
}

const notesFiles = (fixture: Fixture) => readdirSync(join(fixture.root, 'notes')).sort()

test('SC-9: a native Finder drop opens a worktree file in place and imports an outside file collision-safely', async () => {
  const fixture = await makeFixture()
  const buffer = { root: fixture.root, worktreeId: fixture.worktreeId, relativePath: 'notes/plan.md' }
  const files = [new File(['inside\n'], 'plan.md'), new File(['external\n'], 'report.txt')]
  const context = dropContext(fixture, [join(fixture.root, 'notes', 'plan.md'), join(fixture.external, 'report.txt')])

  const targets = await droppedFileTargets(context, buffer, files)

  expect(targets).toEqual(['notes/plan.md', 'notes/report copy.txt'])
  expect(notesFiles(fixture)).toEqual(['plan.md', 'report copy.txt', 'report.txt'])
  expect(readFileSync(join(fixture.root, 'notes', 'report copy.txt'), 'utf8')).toBe('external\n')
  const opened = await fixture.client.callAny('quirky.editor/open', { worktree: fixture.worktreeId, path: targets[0], focus: true, preview: false }) as EditorOpenResult
  expect(opened.path).toBe(join(fixture.root, 'notes', 'plan.md'))
}, 30_000)

test('m2-editor D19 fallback: without native source paths every dropped file is imported, even one already in the worktree', async () => {
  const fixture = await makeFixture()
  const buffer = { root: fixture.root, worktreeId: fixture.worktreeId, relativePath: 'notes/plan.md' }

  const targets = await droppedFileTargets(dropContext(fixture, null), buffer, [new File(['inside\n'], 'plan.md')])

  expect(targets).toEqual(['notes/plan copy.md'])
  expect(existsSync(join(fixture.root, 'notes', 'plan copy.md'))).toBe(true)
}, 30_000)
