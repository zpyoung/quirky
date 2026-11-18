import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { resetSessionMemory } from '../../src/window/model'
import { agentInfo, agentListing, fakeContext, session, settle, type FakeContext } from '../ui-fake'

type Handler = (params: Record<string, any>) => unknown

const OVERLAY = 'overlay:quirky.session/chat-dialogs'
const listing = agentListing([agentInfo('claude', 'Claude Code'), agentInfo('codex', 'Codex'), agentInfo('pi', 'pi'), agentInfo('omp', 'omp')])
const created = session({ id: 'chat-1', kind: 'structured', agent: 'codex' })

let activateModule: (context: FakeContext['context']) => void
let fake: FakeContext
let host: HTMLElement
let unmount: (() => void) | void = undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mock.module('@xterm/addon-webgl', () => ({
    WebglAddon: class {
      activate() {
        throw new Error('WebGL2 not supported')
      }
      onContextLoss() {}
      dispose() {}
    }
  }))
  ;({ activate: activateModule } = await import('../../src/ui'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  resetSessionMemory()
})
afterEach(async () => {
  if (unmount) await act(async () => void (unmount as () => void)())
  unmount = undefined
  document.body.innerHTML = ''
})

async function start(handlers: Record<string, Handler> = {}) {
  fake = fakeContext({
    'quirky.agents/list': () => listing,
    'quirky.agents/options': () => ({ models: [{ id: 'm', label: 'Model' }] }),
    'quirky.terminal/groupInfo': () => ({ workspace: 'wt-main' }),
    'quirky.terminal/focusContext': () => ({ workspace: 'wt-main' }),
    'quirky.terminal/workspace': () => ({ workspace: { activeGroup: 'g-active' } }),
    'quirky.structured/create': () => created,
    'quirky.terminal/adoptSession': () => ({ workspace: {} }),
    ...handlers
  })
  activateModule(fake.context)
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    unmount = fake.provided.get(OVERLAY)!(host, {})
  })
}

const dialog = () => host.querySelector('[role="dialog"]')
const card = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.querySelector('strong')?.textContent === name)!
const click = (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const open = async (args?: unknown) => {
  await fake.command('new-chat', args)
  await settle()
}

describe('the manifest', () => {
  test('puts Chat in the terminal tab menu and declares its command', async () => {
    const manifest = (await Bun.file(join(import.meta.dir, '..', '..', 'quirky-plugin.json')).json()) as {
      contributes: { 'menu-item': unknown[]; command: { id: string; args?: unknown }[]; overlay: { id: string }[] }
    }
    expect(manifest.contributes['menu-item']).toContainEqual({ id: 'new-chat', menu: 'quirky.terminal/tab', title: 'Chat…', command: 'new-chat' })
    const command = manifest.contributes.command.find((entry) => entry.id === 'new-chat')!
    expect(command.args).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { worktree: { type: 'string' }, workspace: { type: 'string' }, group: { type: 'string' } }
    })
    expect(manifest.contributes.overlay.map((entry) => entry.id)).toContain('chat-dialogs')
  })
})

describe('the new chat command', () => {
  test('with a group it resolves the workspace and opens the picker', async () => {
    await start()
    await open({ group: 'g1' })
    expect(fake.callsTo('quirky.terminal/groupInfo')[0]!.params).toEqual({ group: 'g1' })
    expect(dialog()?.querySelector('h2')?.textContent).toBe('New chat')
    expect([...host.querySelectorAll('strong')].map((node) => node.textContent)).toEqual(['Claude Code', 'Codex', 'pi', 'omp'])
  })

  test('without a group it takes the focused workspace', async () => {
    await start()
    await open({})
    expect(fake.callsTo('quirky.terminal/focusContext')).toHaveLength(1)
    expect(dialog()).not.toBeNull()
  })

  test('rejects unknown arguments and opens nothing', async () => {
    await start()
    await expect(open({ nope: 1 })).rejects.toThrow()
    expect(dialog()).toBeNull()
  })

  test('picking an agent creates the chat in the workspace and adopts it into the group', async () => {
    await start()
    await open({ group: 'g1' })
    await click(card('Codex'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ agent: 'codex', worktree: 'wt-main', deferStart: true })
    expect(fake.callsTo('quirky.terminal/adoptSession')[0]!.params).toEqual({ group: 'g1', session: 'chat-1' })
    expect(dialog()).toBeNull()
  })

  test('without a group the chat goes into the workspace active group', async () => {
    await start()
    await open({})
    await click(card('pi'))
    await settle()
    expect(fake.callsTo('quirky.terminal/workspace')[0]!.params).toEqual({ workspace: 'wt-main' })
    expect(fake.callsTo('quirky.terminal/adoptSession')[0]!.params).toEqual({ group: 'g-active', session: 'chat-1' })
  })

  test('cancel closes the dialog and creates nothing', async () => {
    await start()
    await open({ group: 'g1' })
    await act(async () => void dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await settle()
    expect(dialog()).toBeNull()
    expect(fake.callsTo('quirky.structured/create')).toEqual([])
    expect(fake.callsTo('quirky.terminal/adoptSession')).toEqual([])
  })

  test('a failed create keeps the dialog open with the error', async () => {
    await start({ 'quirky.structured/create': () => { throw new RpcError(RpcErrorCode.Internal, 'agent missing') } })
    await open({ group: 'g1' })
    await click(card('Codex'))
    await settle()
    expect(dialog()).not.toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('agent missing')
    expect(fake.callsTo('quirky.terminal/adoptSession')).toEqual([])
  })

  test('a failed adopt keeps the dialog open and a retry adopts the same session without creating another', async () => {
    let failures = 1
    await start({
      'quirky.terminal/adoptSession': () => {
        if (failures-- > 0) throw new RpcError(RpcErrorCode.Internal, 'group gone')
        return { workspace: {} }
      }
    })
    await open({ group: 'g1' })
    await click(card('Codex'))
    await settle()
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('group gone')
    expect(alert.textContent).toContain('chat-1')
    expect(dialog()).not.toBeNull()
    await click(alert.querySelector('button')!)
    await settle()
    expect(fake.callsTo('quirky.structured/create')).toHaveLength(1)
    expect(fake.callsTo('quirky.terminal/adoptSession').map((call) => call.params)).toEqual([
      { group: 'g1', session: 'chat-1' },
      { group: 'g1', session: 'chat-1' }
    ])
    expect(dialog()).toBeNull()
  })
})
