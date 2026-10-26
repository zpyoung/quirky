import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { bytesToBase64, RpcError, RpcErrorCode } from '@quirky/protocol'
import { resetSessionMemory } from '../src/window/model'
import manifest from '../quirky-plugin.json'
import { fakeContext, mountView, session, sessionHandlers, settle, WORKTREE, type FakeContext } from './ui-fake'

const VIEW = 'view:quirky.session/worktree'
const shell1 = session({ id: 's1', title: 'Shell 1', createdAt: 1 })
const claude = session({ id: 's2', title: 'Claude 1', agent: 'claude', status: 'working', createdAt: 2 })

let fake: FakeContext
let mounted: Awaited<ReturnType<typeof mountView>> | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // there is no WebGL in happy-dom; the pane falls back to xterm's DOM renderer
  mock.module('@xterm/addon-webgl', () => ({
    WebglAddon: class {
      activate() {
        throw new Error('WebGL2 not supported')
      }
      onContextLoss() {}
      dispose() {}
    }
  }))
  ;({ Terminal } = await import('@xterm/xterm'))
  const { activate } = await import('../src/ui')
  activateModule = activate
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>
let Terminal: typeof import('@xterm/xterm').Terminal
let activateModule: (context: FakeContext['context']) => void

function start(sessions = [shell1, claude], extra = {}, settings: Record<string, unknown> = {}) {
  fake = fakeContext(sessionHandlers(sessions, extra), settings)
  activateModule(fake.context)
}

beforeEach(() => {
  resetSessionMemory()
})
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
})

async function open(input: unknown) {
  mounted = await mountView(fake, input)
  return mounted
}

describe('the plugin module', () => {
  test('provides every code-backed contribution the manifest declares', () => {
    start()
    const declared = [
      ...manifest.contributes.view.map((entry) => `view:quirky.session/${entry.id}`),
      ...manifest.contributes.command.map((entry) => `command:quirky.session/${entry.id}`)
    ]
    expect([...fake.provided.keys()].sort()).toEqual(declared.sort())
  })

  test('the manifest points at the built module and binds Cmd+T, Cmd+W and Cmd+1..9', () => {
    expect(manifest.ui).toBe('dist/ui.js')
    const keys = Object.fromEntries(manifest.contributes.keybinding.map((entry) => [entry.key, entry.command]))
    expect(keys['mod+t']).toBe('new-shell')
    expect(keys['mod+w']).toBe('close-session')
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(keys[`mod+${digit}`]).toBe(`select-tab-${digit}`)
    const commands = manifest.contributes.command.map((entry) => entry.id)
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(commands).toContain(`select-tab-${digit}`)
  })
})

describe('the worktree view', () => {
  test('shows the worktree name and path above the session tabs', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.querySelector('.main-title strong')?.textContent).toBe('main')
    expect(view.element.querySelector('.main-title .path')?.textContent).toBe('/tmp/work/main')
    expect(view.tabs().map((tab) => tab.textContent)).toEqual(['Shell 1×', 'Claude 1×'])
    expect(fake.callsTo('quirky.worktree/resolve')[0]!.params).toEqual({ selector: WORKTREE.id })
    expect(fake.callsTo('quirky.session/list')[0]!.params).toEqual({ worktree: WORKTREE.id })
  })

  test('SC-35: reports the tabs and the active session', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's2' })
    expect(view.lastReport()).toEqual({
      worktree: WORKTREE.id,
      tabs: [
        { session: 's1', title: 'Shell 1', agent: 'shell', status: 'running' },
        { session: 's2', title: 'Claude 1', agent: 'claude', status: 'working' }
      ],
      active: 's2'
    })
  })

  test('a starting session reports as running', async () => {
    start([session({ id: 's1', status: 'starting' })])
    const view = await open({ worktree: WORKTREE.id })
    expect((view.lastReport() as { tabs: { status: string }[] }).tabs[0]!.status).toBe('running')
  })

  test('with no session in the input it shows the one last active in the worktree, else the first', async () => {
    start()
    const first = await open({ worktree: WORKTREE.id })
    expect((first.lastReport() as { active: string }).active).toBe('s1')
    await first.unmount()
    mounted = null

    mounted = await mountView(fake, { worktree: WORKTREE.id, session: 's2' })
    await mounted.unmount()
    mounted = await mountView(fake, { worktree: WORKTREE.id })
    expect((mounted.lastReport() as { active: string }).active).toBe('s2')
  })

  test('D21: a fresh window mounted with the daemon\'s view input shows the tab selected earlier', async () => {
    start()
    const first = await open({ worktree: WORKTREE.id })
    await first.click(first.tabs()[1]!)
    await first.unmount()
    mounted = null

    resetSessionMemory()
    const input = fake.layout.view!.input
    mounted = await mountView(fake, input)
    expect((mounted.lastReport() as { active: string }).active).toBe('s2')
  })

  test('closing the active tab shown through the window memory publishes the replacement to the daemon layout', async () => {
    start()
    const first = await open({ worktree: WORKTREE.id, session: 's2' })
    await first.unmount()
    mounted = null
    mounted = await mountView(fake, { worktree: WORKTREE.id })
    expect((mounted.lastReport() as { active: string }).active).toBe('s2')
    expect(fake.opened).toEqual([])
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's2' } })
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's1' } }])
  })

  test('SC-37: clicking a tab opens the view on that session', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's1' })
    await view.click(view.tabs()[1]!)
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's2' } }])
  })

  test('marks the active tab selected', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's2' })
    expect(view.tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  test('a worktree that does not resolve is reported as missing', async () => {
    start([], { 'quirky.worktree/resolve': () => Promise.reject(new RpcError(RpcErrorCode.NotFound, 'no such worktree')) })
    const view = await open({ worktree: 'nowhere' })
    expect(view.element.textContent).toContain('Worktree not found')
    expect(view.lastReport()).toEqual({ worktree: 'nowhere', tabs: [], active: null })
  })

  test('an input without a worktree asks for one and reports nothing open', async () => {
    start()
    const view = await open({})
    expect(view.element.textContent).toContain('Pick a worktree')
    expect(view.lastReport()).toEqual({ worktree: null, tabs: [], active: null })
  })

  test('an empty worktree offers a new shell', async () => {
    start([], { 'quirky.session/create': () => session({ id: 'new' }) })
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.textContent).toContain('No sessions in this worktree.')
    await view.click(view.element.querySelector('.empty button')!)
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'shell' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'new' } })
  })
})

describe('keeping tabs current', () => {
  test('a session created or changed in the worktree appears and updates', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    const third = session({ id: 's3', title: 'Shell 2', createdAt: 3 })
    await fake.emit({ type: 'quirky.session/changed', data: { session: third } })
    expect(view.tabs()).toHaveLength(3)
    await fake.emit({ type: 'quirky.session/changed', data: { session: { ...third, status: 'exited', exitCode: 0 } } })
    expect((view.lastReport() as { tabs: { status: string }[] }).tabs[2]!.status).toBe('exited')
  })

  test('a session of another worktree is ignored', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    await fake.emit({ type: 'quirky.session/changed', data: { session: session({ id: 'x', worktreeId: 'other', createdAt: 9 }) } })
    expect(view.tabs()).toHaveLength(2)
  })

  test('a removed session leaves, and closing the active one opens its replacement', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's2' })
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's2' } })
    expect(view.tabs()).toHaveLength(1)
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's1' } }])
  })

  test('closing a session that is not active does not move the view', async () => {
    start()
    await open({ worktree: WORKTREE.id, session: 's2' })
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's1' } })
    expect(fake.opened).toEqual([])
  })

  test('reloads the sessions after the connection comes back', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    const before = fake.callsTo('quirky.session/list').length
    await fake.setConnection('reconnecting')
    await fake.setConnection('connected')
    await settle()
    expect(fake.callsTo('quirky.session/list').length).toBe(before + 1)
    expect(view.tabs()).toHaveLength(2)
  })
})

describe('new sessions', () => {
  const pickFromMenu = async (view: Awaited<ReturnType<typeof mountView>>, label: string) => {
    await view.click(view.element.querySelector('[aria-label="New session"]')!)
    const item = [...view.element.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent === label)!
    await view.click(item)
  }

  test('Shell starts a terminal session in the worktree and opens it', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Shell')
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'shell' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'new' } })
  })

  test('Claude asks for an optional prompt and passes it on', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Claude')
    const textarea = document.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '  fix the bug  ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Start')!)
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'claude', prompt: 'fix the bug' })
  })

  test('Claude (background) starts a structured session', async () => {
    start([shell1], { 'quirky.structured/create': () => session({ id: 'bg', kind: 'structured', agent: 'claude' }) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Claude (background)')
    const start_ = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Start') as HTMLButtonElement
    expect(start_.disabled).toBe(true)
    const textarea = document.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'go')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click(start_)
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'claude', prompt: 'go' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'bg' } })
  })

  test('a failed start is shown as a toast', async () => {
    start([shell1], { 'quirky.session/create': () => Promise.reject(new Error('no pty')) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Shell')
    expect(fake.toasts).toEqual([{ title: 'Could not start session', body: 'no pty' }])
    expect(fake.opened).toEqual([])
  })
})

describe('closing sessions', () => {
  const closeButton = (view: Awaited<ReturnType<typeof mountView>>, title: string) =>
    view.element.querySelector(`[aria-label="Close ${title}"]`)!

  test('a running session is closed after the person confirms', async () => {
    start([shell1], { 'quirky.session/close': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    await view.click(closeButton(view, 'Shell 1'))
    expect(fake.confirms).toEqual([{ title: 'Close session', body: '"Shell 1" is still running. Close it?', confirmLabel: 'Close' }])
    expect(fake.callsTo('quirky.session/close')[0]!.params).toEqual({ session: 's1' })
  })

  test('declining the confirmation keeps the session', async () => {
    start([shell1], { 'quirky.session/close': () => ({ ok: true }) })
    fake.state.confirmAnswer = false
    const view = await open({ worktree: WORKTREE.id })
    await view.click(closeButton(view, 'Shell 1'))
    expect(fake.callsTo('quirky.session/close')).toEqual([])
  })

  test('an exited session closes without asking', async () => {
    start([session({ id: 's1', title: 'Shell 1', status: 'exited', exitCode: 0 })], { 'quirky.session/close': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    await view.click(closeButton(view, 'Shell 1'))
    expect(fake.confirms).toEqual([])
    expect(fake.callsTo('quirky.session/close')).toHaveLength(1)
  })

  test('the exited bar shows the exit code and closes the session', async () => {
    start([session({ id: 's1', status: 'exited', exitCode: 3 })], { 'quirky.session/close': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.querySelector('.exited-bar')?.textContent).toContain('exited (code 3)')
    await view.click(view.element.querySelector('.exited-bar button')!)
    expect(fake.callsTo('quirky.session/close')[0]!.params).toEqual({ session: 's1' })
  })
})

describe('UI commands', () => {
  test('new-shell starts a shell in the open view\'s worktree', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    await open({ worktree: WORKTREE.id })
    await fake.command('new-shell')
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'shell' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'new' } })
  })

  test('new-shell falls back to the worktree the layout names when no view is mounted', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    fake.layout.view = { id: VIEW, input: { worktree: 'wt-other' } }
    await fake.command('new-shell')
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: 'wt-other', agent: 'shell' })
  })

  test('close-session closes the active session', async () => {
    start([session({ id: 's1', status: 'exited', exitCode: 0 }), claude], { 'quirky.session/close': () => ({ ok: true }) })
    await open({ worktree: WORKTREE.id, session: 's1' })
    await fake.command('close-session')
    expect(fake.callsTo('quirky.session/close')[0]!.params).toEqual({ session: 's1' })
  })

  test('select-tab picks a tab by its 1-based index and ignores a missing one', async () => {
    start()
    await open({ worktree: WORKTREE.id, session: 's1' })
    await fake.command('select-tab', { index: 2 })
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's2' } }])
    await fake.command('select-tab', { index: 5 })
    await fake.command('select-tab', { index: 0 })
    await fake.command('select-tab', {})
    expect(fake.opened).toHaveLength(1)
  })

  test('select-tab-N commands pick the Nth tab', async () => {
    start()
    await open({ worktree: WORKTREE.id, session: 's2' })
    await fake.command('select-tab-1')
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's1' } }])
  })

  test('commands do nothing once the view is gone', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    await view.unmount()
    mounted = null
    await fake.command('select-tab', { index: 2 })
    await fake.command('close-session')
    expect(fake.opened).toEqual([])
    expect(fake.callsTo('quirky.session/close')).toEqual([])
  })
})

describe('terminal pane', () => {
  const text = (bytes: string) => new TextEncoder().encode(bytes)
  const decode = (bytes: Uint8Array | string) => (typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
  let terminals: XtermTerminal[]
  let writes: string[]
  let restore: () => void

  beforeEach(() => {
    terminals = []
    writes = []
    const open = Terminal.prototype.open
    const write = Terminal.prototype.write
    Terminal.prototype.open = function (this: XtermTerminal, element: HTMLElement) {
      terminals.push(this)
      return open.call(this, element)
    }
    Terminal.prototype.write = function (this: XtermTerminal, data: string | Uint8Array, callback?: () => void) {
      writes.push(decode(data))
      return write.call(this, data, callback)
    }
    restore = () => {
      Terminal.prototype.open = open
      Terminal.prototype.write = write
    }
  })
  afterEach(() => restore())

  test('attaches the active terminal session and takes its output from the stream', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    const attach = fake.callsTo('quirky.terminal/attach')
    expect(attach).toHaveLength(1)
    expect(attach[0]!.params.session).toBe('s1')
    expect(typeof attach[0]!.params.cols).toBe('number')
    expect(typeof attach[0]!.params.rows).toBe('number')
    await act(async () => fake.streams.get(7)!(text('hello')))
    expect(writes).toEqual(['hello'])
  })

  test('replays the output recorded before the attach', async () => {
    start([shell1], { 'quirky.terminal/attach': () => ({ streamId: 7, replay: bytesToBase64(text('old output')), offset: 10 }) })
    await open({ worktree: WORKTREE.id })
    expect(writes).toEqual(['old output'])
  })

  test('sends typed input and resizes to the session while it is alive', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    await act(async () => terminals[0]!.input('ls'))
    expect(fake.callsTo('quirky.terminal/write')[0]!.params).toEqual({ session: 's1', data: 'ls' })
    await act(async () => terminals[0]!.resize(100, 30))
    expect(fake.callsTo('quirky.terminal/resize').at(-1)!.params).toEqual({ session: 's1', cols: 100, rows: 30 })
  })

  test('sends no input to an exited session', async () => {
    start([session({ id: 's1', status: 'exited', exitCode: 0 })])
    await open({ worktree: WORKTREE.id })
    await act(async () => terminals[0]!.input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
  })

  test('takes the scrollback from the terminal setting and defaults when it is unavailable', async () => {
    start([shell1], {}, { 'setting:quirky.terminal/scrollback': 4000 })
    await open({ worktree: WORKTREE.id })
    expect(terminals[0]!.options.scrollback).toBe(4000)
    await mounted!.unmount()
    mounted = null
    start([shell1])
    await open({ worktree: WORKTREE.id })
    expect(terminals[1]!.options.scrollback).toBe(2000)
  })

  test('applies a changed scrollback setting to the open terminal without remounting it', async () => {
    start([shell1], {}, { 'setting:quirky.terminal/scrollback': 4000 })
    await open({ worktree: WORKTREE.id })
    await fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/scrollback', value: 9000 })
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.options.scrollback).toBe(9000)
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(1)
    await fake.emit({ type: 'setting.changed', id: 'setting:other.plugin/x', value: 1 })
    expect(terminals[0]!.options.scrollback).toBe(9000)
  })

  test('takes its colors from the custom properties on the mount element and follows theme changes', async () => {
    start([shell1])
    mounted = await mountView(fake, { worktree: WORKTREE.id }, { '--terminal-background': '#101010', '--terminal-cursor': '#ff0000' })
    expect(terminals[0]!.options.theme).toEqual({ background: '#101010', foreground: '#d7dae0', cursor: '#ff0000' })
    mounted.element.style.setProperty('--terminal-foreground', '#00ff00')
    await fake.emit({ type: 'theme.changed', chosen: 'x', active: 'x' })
    await settle()
    expect(terminals[0]!.options.theme).toEqual({ background: '#101010', foreground: '#00ff00', cursor: '#ff0000' })
  })

  test('re-reads its colors when the shell applies the theme after theme.changed was delivered', async () => {
    start([shell1])
    mounted = await mountView(fake, { worktree: WORKTREE.id }, { '--terminal-background': '#101010' })
    await fake.emit({ type: 'theme.changed', chosen: 'x', active: 'x' })
    await settle()
    expect(terminals[0]!.options.theme).toEqual({ background: '#101010', foreground: '#d7dae0', cursor: '#d7dae0' })

    await act(async () => {
      mounted!.element.style.setProperty('--terminal-background', '#fafafa')
      mounted!.element.style.setProperty('--terminal-foreground', '#111111')
    })
    await settle()
    expect(terminals[0]!.options.theme).toEqual({ background: '#fafafa', foreground: '#111111', cursor: '#d7dae0' })
  })

  test('detaches when the view unmounts', async () => {
    start([shell1])
    const view = await open({ worktree: WORKTREE.id })
    await view.unmount()
    mounted = null
    expect(fake.callsTo('quirky.terminal/detach').map((call) => call.params)).toEqual([{ streamId: 7 }])
    expect(fake.streams.size).toBe(0)
  })

  test('detaches the old stream and attaches again after a reconnect', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    await fake.setConnection('reconnecting')
    expect(fake.callsTo('quirky.terminal/detach')).toHaveLength(1)
    await fake.setConnection('connected')
    await settle()
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(2)
  })

  test('writes the reason into the terminal when the attach fails', async () => {
    start([shell1], { 'quirky.terminal/attach': () => Promise.reject(new RpcError(RpcErrorCode.MethodNotFound, 'unknown method: quirky.terminal/attach')) })
    await open({ worktree: WORKTREE.id })
    expect(writes.join('')).toContain('Could not attach: unknown method: quirky.terminal/attach')
  })

  test('mounts no terminal for a structured session', async () => {
    start([session({ id: 'bg', kind: 'structured', agent: 'claude' })], { 'quirky.structured/messages': () => [] })
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.querySelector('.terminal-host')).toBeNull()
    expect(fake.callsTo('quirky.terminal/attach')).toEqual([])
  })
})

describe('structured sessions', () => {
  const message = (seq: number, role: string, body: string) => ({ sessionId: 'bg', seq, role, text: body, at: 0 })
  const bg = session({ id: 'bg', kind: 'structured', agent: 'claude', title: 'Claude 1' })

  test('renders the transcript, hides hook chatter and takes new messages from events', async () => {
    start([bg], {
      'quirky.structured/messages': () => [message(1, 'user', 'hi'), message(2, 'system', 'hook_started: x'), message(3, 'assistant', 'hello')]
    })
    const view = await open({ worktree: WORKTREE.id })
    expect(fake.callsTo('quirky.structured/messages')[0]!.params).toEqual({ session: 'bg' })
    expect([...view.element.querySelectorAll('.msg')].map((row) => row.textContent)).toEqual(['userhi', 'assistanthello'])
    await fake.emit({ type: 'quirky.structured/message', data: { message: message(4, 'assistant', 'more') } })
    expect(view.element.querySelectorAll('.msg')).toHaveLength(3)
    await fake.emit({ type: 'quirky.structured/message', data: { message: { ...message(9, 'assistant', 'other'), sessionId: 'else' } } })
    expect(view.element.querySelectorAll('.msg')).toHaveLength(3)
  })

  test('sends a follow-up with Enter', async () => {
    start([bg], { 'quirky.structured/messages': () => [], 'quirky.structured/send': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    const textarea = view.element.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, ' next ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => void textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 'bg', text: 'next' })
  })

  test('says so when quirky.structured is off', async () => {
    start([bg])
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.textContent).toContain('Structured sessions are off')
    expect(view.element.querySelector('textarea')).toBeNull()
  })

  describe('when quirky.structured changes while the transcript is open', () => {
    let on: boolean

    const start2 = (initial: boolean) => {
      on = initial
      start([bg], {
        'quirky.structured/messages': () => {
          if (!on) throw new RpcError(RpcErrorCode.MethodNotFound, 'unknown method: quirky.structured/messages')
          return [message(1, 'user', 'hi')]
        }
      })
    }

    test('disabling it shows the off state and removes the input', async () => {
      start2(true)
      const view = await open({ worktree: WORKTREE.id })
      expect(view.element.querySelector('textarea')).not.toBeNull()
      on = false
      await fake.emit({ type: 'plugin.changed' })
      await settle()
      expect(view.element.textContent).toContain('Structured sessions are off')
      expect(view.element.querySelector('textarea')).toBeNull()
    })

    test('enabling it reloads the transcript and enables the input', async () => {
      start2(false)
      const view = await open({ worktree: WORKTREE.id })
      expect(view.element.textContent).toContain('Structured sessions are off')
      on = true
      await fake.emit({ type: 'plugin.changed' })
      await settle()
      expect(fake.callsTo('quirky.structured/messages')).toHaveLength(2)
      expect([...view.element.querySelectorAll('.msg')].map((row) => row.textContent)).toEqual(['userhi'])
      expect(view.element.querySelector('textarea')).not.toBeNull()
      expect(view.element.textContent).not.toContain('Structured sessions are off')
    })

    test('a reconnect re-checks too', async () => {
      start2(true)
      const view = await open({ worktree: WORKTREE.id })
      await fake.setConnection('reconnecting')
      on = false
      await fake.setConnection('connected')
      await settle()
      expect(view.element.textContent).toContain('Structured sessions are off')
    })
  })
})
