import { afterEach, expect, test } from 'bun:test'
import { pluginApiCompatibilityError, type ApiDescription, type PluginInfo } from '@quirky/protocol'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../helpers'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

test('SC-29: adopted event metadata is cataloged and API floors stay compatible', async () => {
  h = await startHarness({ home: makeTempHome(), builtinPluginsDir: builtinsDir() })
  const client = await h.connect()
  const description = (await client.call('api.describe', {})) as ApiDescription
  const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
  const adopters = new Map(
    plugins
      .filter((plugin) => ['quirky.git', 'quirky.editor', 'quirky.session-info'].includes(plugin.id))
      .map((plugin) => [plugin.id, plugin])
  )
  const gitFloor = adopters.get('quirky.git')?.apiVersion
  const editorFloor = adopters.get('quirky.editor')?.apiVersion
  const sessionInfoFloor = adopters.get('quirky.session-info')?.apiVersion

  expect(adopters.get('quirky.git')?.state).not.toBe('invalid')
  expect(adopters.get('quirky.editor')?.state).not.toBe('invalid')
  expect(adopters.get('quirky.session-info')?.state).not.toBe('invalid')
  for (const floor of [gitFloor, editorFloor]) {
    expect(floor).toBe('1.4.0')
    expect(pluginApiCompatibilityError(floor, '1.2.0')).not.toBeNull()
    expect(pluginApiCompatibilityError(floor)).toBeNull()
  }
  expect(sessionInfoFloor).toBe('1.3.0')
  expect(pluginApiCompatibilityError(sessionInfoFloor, '1.2.0')).not.toBeNull()
  expect(pluginApiCompatibilityError(sessionInfoFloor)).toBeNull()

  const eventMetadata = description.events
    .filter((event) =>
      [
        'quirky.git/changed',
        'quirky.git/reviewChanged',
        'quirky.git/notesChanged',
        'quirky.git/aiChanged',
        'quirky.editor/changed',
        'quirky.editor/explorerChanged',
        'quirky.session-info/changed'
      ].includes(event.name)
    )
    .map(({ name, plugin, coalesce, worktree }) => ({
      name,
      plugin,
      coalesce,
      ...(worktree === undefined ? {} : { worktree })
    }))
  expect(eventMetadata).toEqual([
    { name: 'quirky.editor/changed', plugin: 'quirky.editor', coalesce: undefined },
    { name: 'quirky.editor/explorerChanged', plugin: 'quirky.editor', coalesce: undefined, worktree: 'worktreeId' },
    { name: 'quirky.git/aiChanged', plugin: 'quirky.git', coalesce: undefined },
    { name: 'quirky.git/changed', plugin: 'quirky.git', coalesce: [], worktree: 'worktreeId' },
    { name: 'quirky.git/notesChanged', plugin: 'quirky.git', coalesce: [], worktree: 'worktreeId' },
    { name: 'quirky.git/reviewChanged', plugin: 'quirky.git', coalesce: [], worktree: 'worktreeId' },
    { name: 'quirky.session-info/changed', plugin: 'quirky.session-info', coalesce: ['sessionId'] }
  ])
  const aiChanged = description.events.find((event) => event.name === 'quirky.git/aiChanged')
  expect(aiChanged).toBeDefined()
  expect(aiChanged).not.toHaveProperty('coalesce')
  expect(aiChanged).not.toHaveProperty('worktree')
})
