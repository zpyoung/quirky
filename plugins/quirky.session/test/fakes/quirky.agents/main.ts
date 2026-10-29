import type { PluginContext } from '@quirky/protocol'

type Catalog = { label: string; resumable: boolean; canFork: boolean; paste: boolean }

const CATALOG: Record<string, Catalog> = {
  claude: { label: 'Claude', resumable: true, canFork: true, paste: false },
  codex: { label: 'Codex', resumable: true, canFork: true, paste: false },
  opencode: { label: 'OpenCode', resumable: true, canFork: false, paste: false },
  gemini: { label: 'Gemini', resumable: true, canFork: false, paste: false },
  aider: { label: 'Aider', resumable: false, canFork: false, paste: false },
  goose: { label: 'Goose', resumable: true, canFork: false, paste: true },
  cursor: { label: 'Cursor', resumable: false, canFork: false, paste: false }
}

export type FakeAgentsState = {
  /** What `pick` answers when asked for no particular agent. */
  pick: string
  disabled: Set<string>
  /** What `deliver` settles with; `reject` makes the call fail. */
  outcome: 'pasted' | 'unconfirmed' | 'not-delivered' | 'reject'
  /** While set, `deliver` waits for it before settling. */
  gate: Promise<void> | null
  /** The user arguments every launch records and runs with. */
  args: string
  calls: { method: string; params: Record<string, unknown> }[]
}

declare global {
  var __FAKE_AGENTS__: FakeAgentsState | undefined
}

/** Test handle on the fake; the daemon runs in the test process, so the global is shared. */
export function fakeAgents(): FakeAgentsState {
  globalThis.__FAKE_AGENTS__ ??= { pick: 'shell', disabled: new Set(), outcome: 'pasted', gate: null, args: '', calls: [] }
  return globalThis.__FAKE_AGENTS__
}

export function resetFakeAgents(): FakeAgentsState {
  globalThis.__FAKE_AGENTS__ = undefined
  return fakeAgents()
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * Stands in for `quirky.agents` with a few agents and plain commands: `<agent> <hook args>
 * '<prompt>'`, and resume as `<command> <args> <hook args> --resume <id>`. `goose` takes its prompt by paste.
 */
export function activate(context: PluginContext): void {
  const entry = (agent: string): Catalog => {
    const found = CATALOG[agent]
    if (!found) throw context.error('not-found', `unknown agent: ${agent}`)
    return found
  }
  const provide = (name: string, handler: (params: Record<string, any>) => unknown) =>
    context.provide(`method:quirky.agents/${name}`, (params: Record<string, unknown>) => {
      fakeAgents().calls.push({ method: name, params })
      return handler(params)
    })

  provide('pick', (params) => ({ agent: params.preferred ?? fakeAgents().pick }))

  provide('get', (params) => {
    const found = entry(params.agent)
    return {
      id: params.agent,
      label: found.label,
      enabled: !fakeAgents().disabled.has(params.agent),
      resumable: found.resumable,
      canFork: found.canFork
    }
  })

  provide('plan', (params) => {
    const found = entry(params.agent)
    const prompt: string | undefined = params.prompt?.trim() ? params.prompt : undefined
    if (prompt?.includes('\u0000')) throw context.error('invalid-params', 'prompt contains a NUL character')
    const options =
      params.options !== null && typeof params.options === 'object' && !Array.isArray(params.options)
        ? (params.options as Record<string, unknown>)
        : {}
    const selected: Record<string, { value: string | boolean; source: 'explicit' }> = {}
    if (typeof params.model === 'string') selected.model = { value: params.model, source: 'explicit' }
    for (const [key, value] of Object.entries(options)) {
      if (typeof value === 'string' || typeof value === 'boolean') selected[key] = { value, source: 'explicit' }
    }
    const args = [fakeAgents().args, typeof params.extraArgs === 'string' ? params.extraArgs : ''].filter(Boolean).join(' ')
    const record = { command: params.agent, args, env: {} }
    const paste = prompt !== undefined && (found.paste || params.submitPrompt === false)
    const summary = Object.keys(selected).length > 0 ? `${String(params.agent)} selected options` : undefined
    return {
      agent: params.agent,
      command: `${record.command}${args === '' ? '' : ` ${args}`}${prompt !== undefined && !paste ? ` ${quote(prompt)}` : ''}`,
      env: record.env,
      record,
      promptDelivery: prompt === undefined ? null : paste ? 'pending' : 'command-line',
      paste: paste ? { text: prompt, submit: params.submitPrompt !== false } : null,
      launchSettings:
        summary === undefined ? null : { agent: params.agent, options: selected, summary }
    }
  })
  provide('resolveLaunch', (params) => {
    const structured: Record<string, string | boolean> = {}
    const selected: Record<string, { value: string | boolean; source: 'explicit' }> = {}
    if (typeof params.model === 'string') {
      structured.model = params.model
      selected.model = { value: params.model, source: 'explicit' }
    }
    const options =
      params.options !== null && typeof params.options === 'object' && !Array.isArray(params.options)
        ? (params.options as Record<string, unknown>)
        : {}
    for (const [key, value] of Object.entries(options)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') continue
      structured[key] = value
      selected[key] = { value, source: 'explicit' }
    }
    const launchSettings =
      Object.keys(selected).length > 0
        ? { agent: params.agent, options: selected, summary: `${String(params.agent)} selected options` }
        : null
    return { added: [], args: '', structured, shadowed: [], launchSettings }
  })

  provide('prepareLaunch', (params) => {
    const found = entry(params.agent)
    if (fakeAgents().disabled.has(params.agent)) throw context.error('conflict', `agent ${params.agent} is disabled`)
    const prompt: string | undefined = params.prompt?.trim() ? params.prompt : undefined
    if (prompt?.includes('\u0000')) throw context.error('invalid-params', 'prompt contains a NUL character')
    const hooks = (params.hookArgs as string[]).map((arg) => ` ${quote(arg)}`).join('')
    const args = fakeAgents().args === '' ? '' : ` ${fakeAgents().args}`
    const paste = prompt !== undefined && (found.paste || params.submitPrompt === false)
    return {
      agent: params.agent,
      command: `${params.agent}${args}${hooks}${prompt !== undefined && !paste ? ` ${quote(prompt)}` : ''}`,
      env: params.hookEnv,
      record: { command: params.agent, args: fakeAgents().args, env: {} },
      promptDelivery: prompt === undefined ? null : paste ? 'pending' : 'command-line',
      paste: paste ? { text: prompt, submit: params.submitPrompt !== false } : null
    }
  })

  provide('prepareResume', (params) => {
    entry(params.agent)
    const record = params.record ?? { command: params.agent, args: '', env: {} }
    const hooks = (params.hookArgs as string[]).map((arg) => ` ${quote(arg)}`).join('')
    const args = record.args === '' ? '' : ` ${record.args}`
    return {
      command: `${record.command}${args}${hooks} --resume ${params.providerSession.id}${params.fork ? ' --fork-session' : ''}`,
      env: { ...record.env, ...params.hookEnv },
      record
    }
  })

  provide('deliver', async () => {
    const state = fakeAgents()
    await state.gate
    if (state.outcome === 'reject') throw new Error('delivery failed')
    return { delivery: state.outcome }
  })
}
