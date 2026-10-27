import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { checkSchemaDeclaration, parseContributionId, type PluginInfo, type UiModel } from '@quirky/protocol'
import type { UiPluginContext } from '@quirky/protocol'
import { checkUiKindEntry } from '../../../packages/daemon/src/plugins/ui-kinds'
import manifest from '../quirky-plugin.json'
import { HandoffRig } from './support'
import { registerDom } from './window/register-dom'

const contributes = manifest.contributes as Record<string, any[]>

describe('the window side of the manifest', () => {
  test('SC-1: the manifest points at the UI module and declares the overlay, the settings view and the pane menu item', () => {
    expect((manifest as { ui?: string }).ui).toBe('dist/ui.js')
    expect(contributes.overlay).toEqual([{ id: 'dialog', title: 'Continue in New Session' }])
    expect(contributes.view).toEqual([{ id: 'settings', title: 'Session handoff' }])
    expect(contributes['menu-item']).toEqual([
      {
        id: 'hand-off',
        menu: 'quirky.terminal/pane',
        title: 'Hand Off to Another Agent',
        command: 'command:quirky.handoff/open',
        when: { agent: 'any' },
        after: 'quick-commands'
      }
    ])
  })

  test('SC-1: every contributed UI entry passes the kernel validation', () => {
    const errors: string[] = []
    for (const kind of ['overlay', 'view', 'menu-item', 'command']) {
      for (const entry of contributes[kind]!) checkUiKindEntry(kind, `${kind} ${entry.id}`, entry, errors)
    }
    expect(errors).toEqual([])
  })

  test('SC-1: the menu item runs a command this plugin declares', () => {
    const parsed = parseContributionId(contributes['menu-item']![0].command)
    expect(parsed).toMatchObject({ kind: 'command', namespace: 'quirky.handoff', name: 'open' })
    expect(contributes.command!.map((entry) => entry.id)).toContain('open')
  })

  test('SC-63: the W1 command list is declared, each with an object args schema when it takes arguments', () => {
    const ids = contributes.command!.map((entry) => entry.id)
    expect(ids).toEqual([
      'open',
      'set',
      'edit',
      'regenerate',
      'wait-idle',
      'capture',
      'start',
      'cancel',
      'save-template',
      'search',
      'resend-confirm',
      'discard',
      'jump',
      'open-settings',
      'template-add',
      'template-edit',
      'template-remove',
      'templates-reset'
    ])
    const takes = ['open', 'set', 'edit', 'cancel', 'save-template', 'search', 'resend-confirm', 'discard', 'jump', 'template-add', 'template-edit', 'template-remove']
    for (const entry of contributes.command!) {
      if (takes.includes(entry.id)) expect(checkSchemaDeclaration(entry.args, 'args', { object: true })).toEqual([])
      else expect(entry.args).toBeUndefined()
    }
    const byId = (id: string) => contributes.command!.find((entry) => entry.id === id)!
    expect(byId('open').args.required).toEqual(['session'])
    expect(byId('set').args.required).toEqual(['field', 'value'])
    expect(byId('cancel').args.properties.via.enum).toEqual(['button', 'escape'])
    expect(byId('jump').args.properties).toHaveProperty('lineage')
  })
})

describe('the daemon loading the manifest', () => {
  let rig: HandoffRig
  afterEach(async () => {
    await rig?.cleanup()
  })

  test('SC-1: the plugin loads without errors and the pane menu item reaches the UI contributions', async () => {
    rig = await HandoffRig.start()
    const plugins = (await rig.call('plugin.list')) as PluginInfo[]
    const info = plugins.find((plugin) => plugin.id === 'quirky.handoff')!
    expect(info.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(info.state).not.toBe('invalid')

    const model = (await rig.call('ui.contributions')) as UiModel
    expect(model.menuItems.filter((item) => item.plugin === 'quirky.handoff')).toEqual([
      {
        id: 'menu-item:quirky.handoff/hand-off',
        plugin: 'quirky.handoff',
        menu: 'quirky.terminal/pane',
        title: 'Hand Off to Another Agent',
        command: 'command:quirky.handoff/open',
        when: { agent: 'any' },
        after: 'quick-commands'
      }
    ])
    expect(model.overlays.map((overlay) => overlay.id)).toContain('overlay:quirky.handoff/dialog')
    expect(model.views.map((view) => view.id)).toContain('view:quirky.handoff/settings')
    const commands = model.commands.filter((entry) => entry.plugin === 'quirky.handoff').map((entry) => entry.id)
    expect(commands).toHaveLength(contributes.command!.length)
  })
})

describe('the activated window module', () => {
  let activate: (context: UiPluginContext) => void

  beforeAll(async () => {
    registerDom()
    ;({ activate } = await import('../src/ui'))
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  test('SC-63: every declared overlay, view and command has a provided implementation, and nothing else is provided', () => {
    const provided = new Set<string>()
    const context = {
      pluginId: 'quirky.handoff',
      subscribe: () => () => {},
      provide: (id: string) => void provided.add(id)
    } as unknown as UiPluginContext
    activate(context)
    const declared = [
      ...contributes.overlay!.map((entry) => `overlay:quirky.handoff/${entry.id}`),
      ...contributes.view!.map((entry) => `view:quirky.handoff/${entry.id}`),
      ...contributes.command!.map((entry) => `command:quirky.handoff/${entry.id}`)
    ]
    expect([...provided].sort()).toEqual(declared.sort())
  })
})
