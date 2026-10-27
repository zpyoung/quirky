import { afterEach, describe, expect, test } from 'bun:test'
import type { ApiDescription, PluginInfo } from '@quirky/protocol'
import { cleanupAll, startAsk } from './support'

afterEach(cleanupAll)

describe('SC-17/SC-18: quirky.ask as a built-in plugin', () => {
  test('SC-17: is listed as a valid built-in with no dependencies and the questions panel', async () => {
    const h = await startAsk()
    const client = await h.connect('cli')
    const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
    const info = plugins.find((plugin) => plugin.id === 'quirky.ask')!
    expect(info).toMatchObject({ source: 'builtin', activation: 'lazy', dependencies: [] })
    expect(info.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(info.state).not.toBe('invalid')
    const contributions = await client.call('plugin.contributions', { kind: 'panel' } as never)
    expect(JSON.stringify(contributions)).toContain('panel:quirky.ask/questions')
  })

  test('SC-18: the catalog lists its methods, events and CLI commands', async () => {
    const h = await startAsk()
    const client = await h.connect('cli')
    const api = (await client.call('api.describe', {})) as ApiDescription
    const methods = api.methods.filter((method) => method.plugin === 'quirky.ask')
    expect(methods.map((method) => method.name)).toEqual([
      'quirky.ask/answer',
      'quirky.ask/cancel',
      'quirky.ask/create',
      'quirky.ask/expire',
      'quirky.ask/list',
      'quirky.ask/updatePartial',
      'quirky.ask/wait'
    ])
    expect(methods.filter((method) => method.readOnly).map((method) => method.name)).toEqual(['quirky.ask/list', 'quirky.ask/wait'])
    expect(api.events.filter((event) => event.plugin === 'quirky.ask').map((event) => event.name)).toEqual([
      'quirky.ask/created',
      'quirky.ask/resolved',
      'quirky.ask/surfaced',
      'quirky.ask/updated'
    ])
    expect(api.cli.groups.find((group) => group.plugin === 'quirky.ask')).toEqual({ plugin: 'quirky.ask', words: 'ask', aliases: [] })
    expect(api.cli.commands.filter((command) => command.plugin === 'quirky.ask').map((command) => command.words).sort()).toEqual([
      'ask',
      'ask cancel',
      'ask wait'
    ])
  })

  test('the Questions panel is an effective panel in ui.state', async () => {
    const h = await startAsk()
    const client = await h.connect('cli')
    const state = await client.call('ui.state', {})
    expect(state.slots).toContainEqual({ id: 'panel:quirky.ask/questions', kind: 'panel', plugin: 'quirky.ask', title: 'Questions', shown: false })
  })
})
