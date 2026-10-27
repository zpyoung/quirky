import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { PluginInfo, UiModel } from '@quirky/protocol'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { SESSION_PLUGINS, startPluginHarness } from './support'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

describe('the session plugin in the window', () => {
  test('its module bundles for the browser with React left to the window', async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, '..', 'src', 'ui.tsx')],
      target: 'browser',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    expect(result.logs.filter((log) => log.level === 'error')).toEqual([])
    expect(result.success).toBe(true)
    const code = await result.outputs[0]!.text()
    expect(code).toContain('react-dom/client')
    expect(code).toMatch(/export\s*\{[^}]*activate/)
  })

  test('the daemon takes the manifest, serves the module and lists the commands and shortcuts', async () => {
    h = await startPluginHarness(SESSION_PLUGINS)
    const client = await h.connect('ui')
    const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
    const info = plugins.find((plugin) => plugin.id === 'quirky.session')!
    expect(info.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    const model = (await client.call('ui.contributions', {})) as UiModel
    expect(model.views.map((view) => view.id)).toEqual(expect.arrayContaining(['view:quirky.session/worktree', 'view:quirky.session/structured']))
    expect(model.views.find((view) => view.id === 'view:quirky.session/structured')).toMatchObject({ title: 'Structured session' })
    expect(model.commands.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        'command:quirky.session/new-shell',
        'command:quirky.session/close-session',
        'command:quirky.session/select-tab'
      ])
    )
    const chords = model.keybindings.filter((binding) => binding.plugin === 'quirky.session').map((binding) => binding.key)
    expect(chords.sort()).toEqual(['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9', 'mod+t', 'mod+w'])
    expect(model.modules['quirky.session']!.provides).toEqual(
      expect.arrayContaining(['view:quirky.session/worktree', 'view:quirky.session/structured'])
    )
  })
})
