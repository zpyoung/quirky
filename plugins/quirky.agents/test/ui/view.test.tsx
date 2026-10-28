import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { fakeAgentsContext, FakeAgents, mountSettings, settle, type FakeContext, type Mounted } from './fake'

let activate: (context: FakeContext['context']) => void
let agents: FakeAgents
let fake: FakeContext
let view: Mounted | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ activate } = await import('../../src/ui'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  agents = new FakeAgents()
})
afterEach(async () => {
  await view?.unmount()
  view = null
  document.body.innerHTML = ''
})

async function open(installed?: string[], configure?: (agents: FakeAgents) => void) {
  agents = new FakeAgents(installed)
  configure?.(agents)
  fake = fakeAgentsContext(agents)
  activate(fake.context)
  view = await mountSettings(fake)
  return view
}

const radios = (root: ParentNode) => [...root.querySelectorAll('[role="radio"]')] as HTMLElement[]
const labelsOf = (nodes: HTMLElement[]) => nodes.map((node) => node.textContent?.trim())
const group = (v: Mounted, name: string) => v.q(`[aria-label="${name}"]`)!
const defaultButtons = (v: Mounted) => [...group(v, 'Default agent').querySelectorAll('button')] as HTMLElement[]
const section = (v: Mounted, title: string) => (v.byText('h2', title) ?? v.byText('h3', title))!.closest('section') as HTMLElement
const switchOf = (row: HTMLElement) => row.querySelector('[role="switch"]') as HTMLElement

describe('SC-39: the Agents view shows Orca\'s sections and counts', () => {
  test('SC-39: Default Agent lists Auto, the installed enabled agents in order and Blank Terminal', async () => {
    const v = await open()
    expect(labelsOf(defaultButtons(v))).toEqual(['Auto', 'Claude', 'Claude Agent Teams', 'Codex', 'Goose', 'Blank Terminal'])
    expect(defaultButtons(v).map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false'])
  })

  test('SC-39: Agent Permissions is a Manual / Auto / Yolo radio group with Yolo selected', async () => {
    const v = await open()
    const control = group(v, 'Agent permissions')
    expect(control.getAttribute('role')).toBe('radiogroup')
    expect(labelsOf(radios(control))).toEqual(['Manual', 'Auto', 'Yolo'])
    expect(radios(control).map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
  })

  test('SC-39: Installed shows "4 detected" and Available to install shows "41 agents" with Install links', async () => {
    const v = await open()
    const installed = section(v, 'Installed')
    expect(installed.textContent).toContain('4 detected')
    expect(installed.querySelectorAll('[data-agent]').length).toBe(4)
    expect(v.button('Refresh', installed)).not.toBeNull()
    const available = section(v, 'Available to install')
    expect(available.textContent).toContain('41 agents')
    const rows = [...available.querySelectorAll('[data-agent]')] as HTMLElement[]
    expect(rows.length).toBe(41)
    for (const row of rows) {
      const link = row.querySelector('a') as HTMLAnchorElement
      expect(link.textContent).toBe('Install')
      expect(link.getAttribute('href')).toBe(`https://example.test/${row.dataset.agent}`)
    }
  })

  test('SC-39: installed rows have a Docs link and an Enabled switch, and the "This Mac" trust switch is on', async () => {
    const v = await open()
    const claude = v.row('claude')!
    expect(claude.querySelector('a')!.textContent).toBe('Docs')
    expect(claude.querySelector('a')!.getAttribute('href')).toBe('https://example.test/claude')
    expect(switchOf(claude).getAttribute('aria-checked')).toBe('true')
    expect(claude.textContent).toContain('Claude')
    expect(claude.textContent).toContain('claude --dangerously-skip-permissions')
    const mac = section(v, 'This Mac')
    const trust = mac.querySelector('[role="switch"]') as HTMLElement
    expect(trust.getAttribute('aria-checked')).toBe('true')
    expect(trust.getAttribute('aria-label')).toBe('Trust the folder when Quirky starts an agent')
  })

  test('SC-39: the trust switch writes the setting', async () => {
    const v = await open()
    await v.click(section(v, 'This Mac').querySelector('[role="switch"]'))
    await settle()
    expect(fake.callsTo('setting.set')).toEqual([
      { method: 'setting.set', params: { id: 'setting:quirky.agents/workspace-trust', value: false } }
    ])
    expect(section(v, 'This Mac').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
  })

  test('the Set default button picks a default, and the current default reads Default', async () => {
    const v = await open()
    await v.click(v.button('Set default: Codex'))
    await settle()
    expect(fake.callsTo('quirky.agents/setDefault')[0]!.params).toEqual({ agent: 'codex' })
    expect(v.row('codex')!.textContent).toContain('Default')
    expect(v.button('Default: Codex')).not.toBeNull()
    expect(defaultButtons(v).map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false', 'false'])
  })

  test('the Default Agent buttons call setDefault with auto, the agent ID or shell', async () => {
    const v = await open()
    await v.click(v.button('Goose', group(v, 'Default agent')))
    await v.click(v.button('Blank Terminal'))
    await v.click(v.button('Auto'))
    await settle()
    expect(fake.callsTo('quirky.agents/setDefault').map((call) => call.params.agent)).toEqual(['goose', 'shell', 'auto'])
    expect(defaultButtons(v)[0]!.getAttribute('aria-pressed')).toBe('true')
  })

  test('the Agent Permissions control sets every preset agent', async () => {
    const v = await open()
    await v.click(v.button('Manual', group(v, 'Agent permissions')))
    await settle()
    expect(fake.callsTo('quirky.agents/setPermissions')[0]!.params).toEqual({ mode: 'manual' })
    expect(radios(group(v, 'Agent permissions')).map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(v.row('claude')!.textContent).not.toContain('--dangerously-skip-permissions')
  })

  test('when agents disagree no segment is selected and the majority mode is named', async () => {
    const v = await open(undefined, (a) => {
      a.handlers()['quirky.agents/configure']!({ agent: 'codex', args: '' })
    })
    expect(radios(group(v, 'Agent permissions')).map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])
    expect(v.text()).toContain('Most agents use Yolo. Choosing a mode resets the marked exceptions, except custom arguments.')
  })

  test('a failed action is shown as a toast', async () => {
    const v = await open()
    fake.context.call = async () => {
      throw new RpcError(RpcErrorCode.InvalidParams, 'unknown agent: nope')
    }
    await v.click(v.button('Set default: Codex'))
    await settle()
    expect(fake.toasts.map((toast) => toast.body)).toContain('unknown agent: nope')
  })
})

describe('SC-40: expanding a row edits that agent', () => {
  const expand = async (v: Mounted, id: string) => {
    await v.click(v.button('Expand agent settings', v.row(id)!))
    return v.row(id)!
  }
  const field = (row: HTMLElement, name: string) => row.querySelector(`[aria-label="${name}"]`) as HTMLInputElement
  const save = async (v: Mounted, input: HTMLInputElement, value: string) => {
    await v.type(input, value)
    await v.key(input, 'Enter')
    await settle()
  }

  test('SC-40: Manual empties Arguments and Reset appears', async () => {
    const v = await open()
    const row = await expand(v, 'claude')
    expect(field(row, 'Arguments').value).toBe('--dangerously-skip-permissions')
    expect(field(row, 'Command').value).toBe('claude')
    expect(v.button('Reset', row)).toBeNull()
    expect(labelsOf(radios(row))).toEqual(['Manual', 'Auto', 'Yolo'])
    await v.click(v.button('Manual', row))
    await settle()
    expect(fake.callsTo('quirky.agents/setPermissions')[0]!.params).toEqual({ mode: 'manual', agent: 'claude' })
    expect(field(v.row('claude')!, 'Arguments').value).toBe('')
    expect(v.button('Reset', v.row('claude')!)).not.toBeNull()
  })

  test('SC-40: custom arguments show the Custom badge, "Custom arguments" and "Replace with Yolo"', async () => {
    const v = await open()
    const row = await expand(v, 'claude')
    await v.click(v.button('Manual', row))
    await save(v, field(v.row('claude')!, 'Arguments'), '--model haiku')
    expect(fake.callsTo('quirky.agents/configure').at(-1)!.params).toEqual({ agent: 'claude', args: '--model haiku' })
    const custom = v.row('claude')!
    expect(custom.textContent).toContain('Custom')
    expect(custom.textContent).toContain('claude --model haiku')
    expect(custom.textContent).toContain('Custom arguments')
    expect(v.button('Replace with Yolo', custom)).not.toBeNull()
    expect(radios(custom)).toEqual([])
    expect(radios(group(v, 'Agent permissions')).map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
    await v.click(v.button('Replace with Yolo', custom))
    await settle()
    expect(fake.callsTo('quirky.agents/setPermissions').at(-1)!.params).toEqual({ mode: 'yolo', agent: 'claude', replaceCustom: true })
    expect(v.row('claude')!.textContent).not.toContain('Custom')
  })

  test('SC-40: Environment appears for Goose only, as KEY=VALUE lines', async () => {
    const v = await open()
    const goose = await expand(v, 'goose')
    expect((goose.querySelector('[aria-label="Environment"]') as HTMLTextAreaElement).value).toBe('GOOSE_MODE=auto')
    const claude = await expand(v, 'claude')
    expect(claude.querySelector('[aria-label="Environment"]')).toBeNull()
    expect(labelsOf(radios(goose))).toEqual(['Manual', 'Yolo'])
  })

  test('the Environment field saves KEY=VALUE lines on blur and resets', async () => {
    const v = await open()
    const goose = await expand(v, 'goose')
    const env = goose.querySelector('[aria-label="Environment"]') as HTMLTextAreaElement
    await v.type(env, 'GOOSE_MODE=smart\nTOKEN=a=b\n\n')
    await v.blur(env)
    await settle()
    expect(fake.callsTo('quirky.agents/configure').at(-1)!.params).toEqual({ agent: 'goose', env: { GOOSE_MODE: 'smart', TOKEN: 'a=b' } })
    await v.click(v.button('Reset', v.row('goose')!))
    await settle()
    expect(fake.callsTo('quirky.agents/configure').at(-1)!.params).toEqual({ agent: 'goose', reset: ['env'] })
  })

  test('an environment line without = is refused under the field and keeps the text', async () => {
    const v = await open()
    const goose = await expand(v, 'goose')
    const env = goose.querySelector('[aria-label="Environment"]') as HTMLTextAreaElement
    await v.type(env, 'oops')
    await v.blur(env)
    await settle()
    expect(fake.callsTo('quirky.agents/configure')).toEqual([])
    expect(v.row('goose')!.querySelector('[role="alert"]')!.textContent).toContain('KEY=VALUE')
    expect((v.row('goose')!.querySelector('[aria-label="Environment"]') as HTMLTextAreaElement).value).toBe('oops')
  })

  test('SC-40: bad quoting shows the error under the field and keeps the text', async () => {
    const v = await open()
    const row = await expand(v, 'claude')
    await v.type(field(row, 'Arguments'), '--model "haiku')
    await v.blur(field(row, 'Arguments'))
    await settle()
    const alert = v.row('claude')!.querySelector('[role="alert"]')!
    expect(alert.textContent).toBe('CLI arguments are invalid: unterminated quote')
    expect(field(v.row('claude')!, 'Arguments').value).toBe('--model "haiku')
    expect(field(v.row('claude')!, 'Arguments').getAttribute('aria-invalid')).toBe('true')
    expect(v.row('claude')!.textContent).not.toContain('Custom')
  })

  test('Enter then blur while the save is still running saves once', async () => {
    agents = new FakeAgents()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    fake = fakeAgentsContext(agents, {
      'quirky.agents/configure': async (params) => {
        await gate
        return agents.handlers()['quirky.agents/configure']!(params)
      }
    })
    activate(fake.context)
    view = await mountSettings(fake)
    const row = await expand(view, 'claude')
    const input = field(row, 'Arguments')
    await view.type(input, '--model haiku')
    await view.key(input, 'Enter')
    await view.blur(input)
    release()
    await settle()
    expect(fake.callsTo('quirky.agents/configure').length).toBe(1)
  })

  test('an unchanged field does not call configure', async () => {
    const v = await open()
    const row = await expand(v, 'claude')
    await v.blur(field(row, 'Command'))
    await settle()
    expect(fake.callsTo('quirky.agents/configure')).toEqual([])
  })

  test('the Command field saves an override and its Reset removes it', async () => {
    const v = await open()
    const row = await expand(v, 'codex')
    await save(v, field(row, 'Command'), '/opt/bin/codex')
    expect(fake.callsTo('quirky.agents/configure').at(-1)!.params).toEqual({ agent: 'codex', command: '/opt/bin/codex' })
    expect(v.row('codex')!.textContent).toContain('/opt/bin/codex')
    await v.click(v.button('Reset', v.row('codex')!))
    await settle()
    expect(fake.callsTo('quirky.agents/configure').at(-1)!.params).toEqual({ agent: 'codex', reset: ['command'] })
    expect(field(v.row('codex')!, 'Command').value).toBe('codex')
  })

  test('an agent with no permission control and saved arguments is marked Custom', async () => {
    const v = await open(['gemini'])
    expect(v.row('gemini')!.textContent).not.toContain('Custom')
    await v.click(v.button('Expand agent settings', v.row('gemini')!))
    await save(v, field(v.row('gemini')!, 'Arguments'), '--model pro')
    expect(v.row('gemini')!.textContent).toContain('Custom')
    expect(v.row('gemini')!.querySelector('[role="radiogroup"]')).toBeNull()
  })

  test('Auto is offered only to agents that have it', async () => {
    const v = await open()
    expect(labelsOf(radios(await expand(v, 'codex')))).toEqual(['Manual', 'Auto', 'Yolo'])
    await v.click(v.button('Auto', v.row('codex')!))
    await settle()
    expect(fake.callsTo('quirky.agents/setPermissions').at(-1)!.params).toEqual({ mode: 'auto', agent: 'codex' })
  })

  test('only installed rows can be expanded, and the chevron toggles', async () => {
    const v = await open()
    expect(v.button('Expand agent settings', v.row('aider')!)).toBeNull()
    const chevron = v.button('Expand agent settings', v.row('claude')!)!
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    await v.click(chevron)
    expect(v.row('claude')!.querySelector('[aria-label="Arguments"]')).not.toBeNull()
    await v.click(v.button('Collapse agent settings', v.row('claude')!))
    expect(v.row('claude')!.querySelector('[aria-label="Arguments"]')).toBeNull()
  })
})

describe('SC-41: disabling an agent in the view', () => {
  test('SC-41: Codex shows Disabled, loses Set default and leaves the Default Agent row', async () => {
    const v = await open()
    expect(v.row('codex')!.textContent).not.toContain('Disabled')
    expect(v.button('Set default: Codex')).not.toBeNull()
    await v.click(switchOf(v.row('codex')!))
    await settle()
    expect(fake.callsTo('quirky.agents/setEnabled')[0]!.params).toEqual({ agent: 'codex', enabled: false })
    const row = v.row('codex')!
    expect(row.textContent).toContain('Disabled')
    expect(switchOf(row).getAttribute('aria-checked')).toBe('false')
    expect(v.button('Set default: Codex')).toBeNull()
    expect(labelsOf(defaultButtons(v))).toEqual(['Auto', 'Claude', 'Claude Agent Teams', 'Goose', 'Blank Terminal'])
    expect(section(v, 'Installed').textContent).toContain('4 detected')
  })

  test('disabling the default agent moves the default back to Auto', async () => {
    const v = await open(undefined, (a) => void (a.default = 'codex'))
    expect(defaultButtons(v)[3]!.getAttribute('aria-pressed')).toBe('true')
    await v.click(switchOf(v.row('codex')!))
    await settle()
    expect(defaultButtons(v)[0]!.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('SC-42: Refresh and the empty state', () => {
  test('SC-42: Refresh reads "Refreshing…" until the call finishes, then Installed is empty', async () => {
    const v = await open(['claude'])
    let release!: () => void
    agents.refreshGate = new Promise((resolve) => (release = resolve))
    agents.installed = []
    await v.click(v.button('Refresh'))
    const busy = v.button('Refreshing…')!
    expect(busy).not.toBeNull()
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    release()
    await settle()
    expect(v.button('Refreshing…')).toBeNull()
    expect(v.button('Refresh')).not.toBeNull()
    const installed = section(v, 'Installed')
    expect(installed.textContent).toContain('No agents detected. Install one below, then Refresh.')
    expect(installed.textContent).toContain('0 detected')
    expect(labelsOf(defaultButtons(v))).toEqual(['Auto', 'Blank Terminal'])
    expect(section(v, 'Available to install').textContent).toContain('45 agents')
  })

  test('a failed Refresh is shown as a toast and the button recovers', async () => {
    const v = await open()
    agents.failNextRefresh = new Error('login shell timed out')
    await v.click(v.button('Refresh'))
    await settle()
    expect(fake.toasts.map((toast) => toast.body)).toContain('login shell timed out')
    expect(v.button('Refresh')).not.toBeNull()
  })
})

describe('keeping the listing current', () => {
  test('quirky.agents/changed and setting.changed fetch the listing again', async () => {
    const v = await open()
    expect(fake.callsTo('quirky.agents/list').length).toBe(1)
    agents.installed = [...agents.installed, 'gemini']
    await fake.emit({ type: 'quirky.agents/changed', data: {} } as QuirkyEvent)
    await settle()
    expect(section(v, 'Installed').textContent).toContain('5 detected')
    agents.default = 'shell'
    await fake.emit({ type: 'setting.changed', id: 'setting:quirky.agents/default-agent', value: 'shell' })
    await settle()
    expect(defaultButtons(v).at(-1)!.getAttribute('aria-pressed')).toBe('true')
  })

  test('a failed first load says so and can be retried', async () => {
    agents = new FakeAgents()
    let fail = true
    fake = fakeAgentsContext(agents, {
      'quirky.agents/list': () => {
        if (fail) throw new Error('daemon unavailable')
        return agents.listing()
      }
    })
    activate(fake.context)
    view = await mountSettings(fake)
    expect(view.q('[role="alert"]')!.textContent).toContain('daemon unavailable')
    fail = false
    await view.click(view.button('Try again'))
    await settle()
    expect(view.q('[role="alert"]')).toBeNull()
    expect(section(view, 'Installed').textContent).toContain('4 detected')
  })

  test('the listing is fetched again after a reconnect', async () => {
    await open()
    await fake.setConnection('reconnecting')
    await fake.setConnection('connected')
    await settle()
    expect(fake.callsTo('quirky.agents/list').length).toBe(2)
  })

  test('unmounting stops listening to events', async () => {
    const v = await open()
    await v.unmount()
    view = null
    await act(async () => void fake.dispatch({ type: 'quirky.agents/changed', data: {} } as QuirkyEvent))
    await settle()
    expect(fake.callsTo('quirky.agents/list').length).toBe(1)
  })
})
