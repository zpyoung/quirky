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
      .filter((plugin) => ['quirky.editor', 'quirky.session-info'].includes(plugin.id))
      .map((plugin) => [plugin.id, plugin])
  )
  const editorFloor = adopters.get('quirky.editor')?.apiVersion
  const sessionInfoFloor = adopters.get('quirky.session-info')?.apiVersion

  expect(adopters.get('quirky.editor')?.state).not.toBe('invalid')
  expect(adopters.get('quirky.session-info')?.state).not.toBe('invalid')
  for (const floor of [editorFloor, sessionInfoFloor]) {
    expect(floor).toBe('1.3.0')
    expect(pluginApiCompatibilityError(floor, '1.2.0')).not.toBeNull()
    expect(pluginApiCompatibilityError(floor)).toBeNull()
  }

  const eventMetadata = description.events
    .filter((event) =>
      ['quirky.editor/changed', 'quirky.editor/explorerChanged', 'quirky.session-info/changed'].includes(event.name)
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
    { name: 'quirky.session-info/changed', plugin: 'quirky.session-info', coalesce: ['sessionId'] }
  ])
})
