import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { LaunchSettings, Session } from '@quirky/protocol'
import { startAgentsE2E, type CliResult, type E2E, type FakeEvent } from '../support/e2e'

const FIXTURES = join(import.meta.dir, 'fixtures')

type Start = Extract<FakeEvent, { type: 'start' }>

type Choice = { value: string; label: string }
type OptionInfo = { id: string; label: string; type: 'select' | 'boolean'; choices: Choice[] | null }
type ModelInfo = { id: string; label: string; description: string | null; options: OptionInfo[] }
type OptionsInfo = {
  agent: string
  label: string
  supported: boolean
  models: ModelInfo[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: OptionInfo[]
  structured: boolean
  extraArgs: { supported: boolean; allowed: string | null; placeholder: string | null; message: string | null }
}
type Resolved = {
  added: string[]
  args: string
  structured: Record<string, string | boolean>
  shadowed: string[]
  launchSettings: LaunchSettings | null
}
type Listing = {
  agents: { id: string; plugin: string }[]
  problems?: { plugin: string; id: string; status: string; error: string }[]
}

async function cliJson<T>(e2e: E2E, args: string[]): Promise<T> {
  const result = await e2e.cli([...args, '--json'])
  if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

/** The message (and JSON-RPC code) of a daemon call that is expected to fail. */
async function failureOf(work: Promise<unknown>): Promise<{ message: string; code?: number }> {
  try {
    await work
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), code: (error as { code?: number }).code }
  }
  throw new Error('expected the call to fail')
}

const optionsOf = (e2e: E2E, agent: string) => e2e.call('quirky.agents/options', { agent }) as Promise<OptionsInfo>
const resolveOf = (e2e: E2E, params: Record<string, unknown>) => e2e.call('quirky.agents/resolveLaunch', params) as Promise<Resolved>
const configure = async (e2e: E2E, agent: string, ...flags: string[]) => {
  const result = await e2e.cli(['agents', 'configure', agent, ...flags])
  expect(result.code).toBe(0)
}

/** Option rows reduced to what the catalog tables name: ID, label, kind and the offered values. */
const shape = (options: OptionInfo[]) => options.map((o) => ({ id: o.id, label: o.label, type: o.type, values: o.choices?.map((c) => c.value) ?? null }))
type Shape = ReturnType<typeof shape>[number]
const select = (id: string, label: string, values: string[]): Shape => ({ id, label, type: 'select', values })
const toggle = (id: string, label: string): Shape => ({ id, label, type: 'boolean', values: null })

describe('the catalog (SC-1 to SC-4)', () => {
  let e2e: E2E
  beforeAll(async () => {
    e2e = await startAgentsE2E()
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'SC-1: Claude lists four models and the efforts each supports',
    async () => {
      const claude = await cliJson<OptionsInfo>(e2e, ['agents', 'options', 'claude'])
      expect(claude).toMatchObject({ agent: 'claude', supported: true, unlisted: 'accept' })
      expect(claude.models.map((m) => [m.id, m.label, m.description])).toEqual([
        ['fable', 'Fable', 'Most capable for the hardest, longest-running tasks'],
        ['opus', 'Opus', 'Best for everyday, complex tasks'],
        ['sonnet', 'Sonnet', 'Efficient for routine tasks'],
        ['haiku', 'Haiku', 'Fastest for quick answers']
      ])
      const effort: OptionInfo = {
        id: 'effort',
        label: 'Effort',
        type: 'select',
        choices: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Max' }
        ]
      }
      for (const id of ['fable', 'opus', 'sonnet']) expect(claude.models.find((m) => m.id === id)!.options).toEqual([effort])
      expect(claude.models.find((m) => m.id === 'haiku')!.options).toEqual([])
      expect(claude.unlistedOptions).toEqual([effort])

      const table = await e2e.cli(['agents', 'options', 'claude'])
      expect(table.code).toBe(0)
      expect(table.stdout).toContain('MODEL')
      for (const line of ['fable   Fable   effort: low|medium|high|xhigh|max', 'haiku   Haiku   -']) expect(table.stdout).toContain(line)
      expect(table.stdout).toContain('unlisted models: accepted, with effort: low|medium|high|xhigh|max')
    },
    60_000
  )

  test(
    "SC-2: Codex's effort list stops at each model's ceiling",
    async () => {
      const codex = await cliJson<OptionsInfo>(e2e, ['agents', 'options', 'codex'])
      expect(codex.models.map((m) => m.label)).toEqual(['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5', 'GPT-5.2 Codex'])
      const efforts = (id: string) => {
        const option = codex.models.find((m) => m.id === id)!.options
        expect(option.map((o) => [o.id, o.label])).toEqual([['effort', 'Reasoning effort']])
        return option[0]!.choices!.map((c) => c.value)
      }
      const upToXhigh = ['minimal', 'low', 'medium', 'high', 'xhigh']
      expect(efforts('gpt-5.6-sol')).toEqual([...upToXhigh, 'max', 'ultra'])
      expect(efforts('gpt-5.6-terra')).toEqual([...upToXhigh, 'max', 'ultra'])
      expect(efforts('gpt-5.6-luna')).toEqual([...upToXhigh, 'max'])
      expect(efforts('gpt-5.5')).toEqual(upToXhigh)
      expect(efforts('gpt-5.2-codex')).toEqual(upToXhigh)
      expect(codex.models.find((m) => m.id === 'gpt-5.5')!.options[0]!.choices!.map((c) => c.label)).toEqual(['Minimal', 'Low', 'Medium', 'High', 'Extra high'])
    },
    60_000
  )

  test(
    'SC-3: each of the ten agents has its catalog and the others report none',
    async () => {
      const low3 = ['low', 'medium', 'high']
      const expected: Record<string, { models: string[]; options: Shape[]; unlisted: 'accept' | 'refuse' }> = {
        claude: { models: ['Fable', 'Opus', 'Sonnet', 'Haiku'], options: [select('effort', 'Effort', [...low3, 'xhigh', 'max'])], unlisted: 'accept' },
        codex: {
          models: ['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5', 'GPT-5.2 Codex'],
          options: [select('effort', 'Reasoning effort', ['minimal', ...low3, 'xhigh', 'max', 'ultra'])],
          unlisted: 'accept'
        },
        codebuddy: {
          models: ['Default', 'Fast', 'Balanced', 'Primary', 'Deep'],
          options: [select('effort', 'Reasoning effort', ['minimal', ...low3, 'xhigh', 'max'])],
          unlisted: 'accept'
        },
        gemini: { models: ['Gemini 3 Pro Preview', 'Gemini 3 Flash Preview', 'Gemini 2.5 Pro', 'Gemini 2.5 Flash'], options: [], unlisted: 'refuse' },
        cursor: {
          models: ['Auto', 'GPT-5.3 Codex', 'Claude Opus 4.8'],
          options: [select('effort', 'Effort', low3), toggle('fastMode', 'Fast mode'), toggle('thinking', 'Thinking')],
          unlisted: 'refuse'
        },
        grok: { models: ['Grok 4.7', 'Grok 4.6', 'Grok 4.5'], options: [select('effort', 'Reasoning effort', [...low3, 'xhigh'])], unlisted: 'accept' },
        muse: { models: [], options: [select('effort', 'Reasoning effort', ['minimal', ...low3, 'xhigh', 'max', 'ultra'])], unlisted: 'accept' },
        antigravity: { models: [], options: [select('effort', 'Reasoning effort', low3)], unlisted: 'accept' },
        omp: { models: [], options: [], unlisted: 'accept' },
        opencode: { models: [], options: [], unlisted: 'accept' }
      }

      const listing = (await e2e.call('quirky.agents/list', {})) as Listing
      const supported: string[] = []
      for (const { id } of listing.agents) {
        const info = await optionsOf(e2e, id)
        if (!expected[id]) {
          expect(info).toMatchObject({ agent: id, supported: false, models: [], unlistedOptions: [], unlisted: 'refuse' })
          continue
        }
        supported.push(id)
        const want = expected[id]!
        expect(info.supported).toBe(true)
        expect(info.models.map((m) => m.label)).toEqual(want.models)
        expect(info.unlisted).toBe(want.unlisted)
        // the option set is the union of what the models offer, or what unlisted models get when none are listed
        const offered = info.models.length ? info.models.flatMap((m) => shape(m.options)) : shape(info.unlistedOptions)
        const ids = new Set(offered.map((o) => o.id))
        expect(want.options.map((o) => o.id).sort()).toEqual([...ids].sort())
        for (const option of want.options) {
          const seen = offered.filter((o) => o.id === option.id)
          expect(seen[0]).toMatchObject({ id: option.id, label: option.label, type: option.type })
          const widest = seen.map((o) => o.values).filter((v): v is string[] => v !== null).sort((a, b) => b.length - a.length)[0] ?? null
          expect(widest as unknown).toEqual(option.values)
        }
      }
      expect(supported.sort()).toEqual(Object.keys(expected).sort())
      expect(listing.agents.map((a) => a.id)).toContain('claude-agent-teams')
      expect((await optionsOf(e2e, 'claude-agent-teams')).supported).toBe(false)
    },
    120_000
  )

  test(
    'SC-4: the catalog says which extra arguments each agent accepts',
    async () => {
      expect((await optionsOf(e2e, 'claude')).extraArgs).toEqual({
        supported: true,
        allowed: '--model, --effort, --add-dir',
        placeholder: '--model opus --effort high --add-dir docs',
        message: null
      })
      const codex = (await optionsOf(e2e, 'codex')).extraArgs
      expect(codex.supported).toBe(true)
      expect(codex.allowed).toBe('--model, -c model_reasoning_effort=…')
      expect(codex.placeholder).toBe('-m model-id -c model_reasoning_effort=high')
      expect((await optionsOf(e2e, 'aider')).extraArgs).toEqual({
        supported: false,
        allowed: null,
        placeholder: null,
        message: "Extra arguments aren't supported for this agent yet."
      })
    },
    60_000
  )
})

describe('a plugin replaces a catalog (SC-5)', () => {
  let e2e: E2E
  beforeAll(async () => {
    e2e = await startAgentsE2E()
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'SC-5: a plugin can replace an agent catalog and a malformed one is skipped',
    async () => {
      expect((await cliJson<OptionsInfo>(e2e, ['agents', 'options', 'claude'])).models).toHaveLength(4)

      await e2e.call('plugin.install', { path: join(FIXTURES, 'acme.launch-override'), yes: true })
      await e2e.call('plugin.install', { path: join(FIXTURES, 'acme.launch-bad'), yes: true })

      const claude = await cliJson<OptionsInfo>(e2e, ['agents', 'options', 'claude'])
      expect(claude.models.map((m) => m.id)).toEqual(['opus'])

      const all = await cliJson<Listing>(e2e, ['agents', 'list', '--all'])
      expect(all.agents.find((a) => a.id === 'claude')?.plugin).toBe('acme.launch-override')
      expect(all.agents.some((a) => a.id === 'bad')).toBe(false)
      const problem = all.problems!.find((p) => p.plugin === 'acme.launch-bad')
      expect(problem).toMatchObject({ id: 'bad', status: 'invalid' })
      expect(problem!.error).toContain('launchOptions')

      await e2e.call('plugin.disable', { id: 'acme.launch-override' })
      const restored = await cliJson<OptionsInfo>(e2e, ['agents', 'options', 'claude'])
      expect(restored.models.map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    },
    90_000
  )
})

describe('resolving a selection (SC-6 to SC-17)', () => {
  let e2e: E2E
  beforeAll(async () => {
    e2e = await startAgentsE2E()
  }, 60_000)
  afterAll(() => e2e.cleanup())

  const resolveCli = (...args: string[]) => cliJson<Resolved>(e2e, ['agents', 'resolve', ...args])
  const refused = async (args: string[]): Promise<CliResult> => {
    const result = await e2e.cli(['agents', 'resolve', ...args])
    expect(result.code).not.toBe(0)
    return result
  }

  test(
    'SC-6: a model and effort become the agent flags, its structured options and a snapshot',
    async () => {
      const before = (await e2e.call('quirky.session/list', {})) as Session[]
      const result = await resolveCli('claude', '--model', 'opus', '--effort', 'high')
      expect(result.added).toEqual(['--model', 'opus', '--effort', 'high'])
      expect(result.args).toBe('--dangerously-skip-permissions --model opus --effort high')
      expect(result.structured).toEqual({ model: 'opus', effort: 'high' })
      expect(result.shadowed).toEqual([])
      expect(result.launchSettings).toEqual({
        agent: 'claude',
        options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
        args: { value: '--dangerously-skip-permissions', source: 'inherited' },
        summary: 'Claude · Opus · Effort: high'
      })
      expect((await e2e.call('quirky.session/list', {})) as Session[]).toEqual(before)
    },
    60_000
  )

  test(
    "SC-7: Codex's effort goes through -c",
    async () => {
      const result = await resolveCli('codex', '--model', 'gpt-5.5', '--effort', 'low')
      expect(result.added).toEqual(['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=low'])
      expect(result.launchSettings?.summary).toBe('Codex · GPT-5.5 · Reasoning effort: low')
    },
    60_000
  )

  test(
    'SC-8: no pick adds nothing, and catalog defaults are never injected',
    async () => {
      try {
        expect((await e2e.cli(['agents', 'permissions', 'manual', '--agent', 'claude'])).code).toBe(0)
        const manual = await resolveOf(e2e, { agent: 'claude' })
        expect(manual).toMatchObject({ added: [], structured: {}, launchSettings: null })

        expect((await e2e.cli(['agents', 'permissions', 'yolo', '--agent', 'claude'])).code).toBe(0)
        const yolo = await resolveOf(e2e, { agent: 'claude' })
        expect(yolo.added).toEqual([])
        expect(yolo.structured).toEqual({})
        expect(yolo.args).toBe('--dangerously-skip-permissions')
        expect(yolo.launchSettings).toEqual({
          agent: 'claude',
          options: {},
          args: { value: '--dangerously-skip-permissions', source: 'inherited' },
          summary: 'Claude'
        })
        const codex = await resolveOf(e2e, { agent: 'codex', model: 'gpt-5.5' })
        expect(codex.added).toEqual(['-m', 'gpt-5.5'])
        expect(codex.args).not.toContain('model_reasoning_effort')
        const claude = await resolveOf(e2e, { agent: 'claude', model: 'opus' })
        expect(claude.added).toEqual(['--model', 'opus'])
      } finally {
        await e2e.cli(['agents', 'configure', 'claude', '--reset', 'args'])
      }
    },
    60_000
  )

  test(
    'SC-9: invalid picks are refused with the Orca messages and launch nothing',
    async () => {
      const rows: [string[], string][] = [
        [['claude', '--effort', 'low'], '--effort requires --model'],
        [['claude', '--model', 'haiku', '--effort', 'low'], 'Agent claude model haiku does not support effort low.'],
        [['codex', '--model', 'gpt-5.5', '--effort', 'ultra'], 'Agent codex model gpt-5.5 does not support effort ultra.'],
        [['aider', '--model', 'gpt-4o'], 'Agent aider does not support launch-time model selection.'],
        [['gemini', '--model', 'gemini-9'], 'Agent gemini does not support model gemini-9.'],
        [['claude', '--model', 'opus', '--option', 'speed=fast'], 'Agent claude model opus does not support speed fast.'],
        [['cursor', '--model', 'claude-opus-4-8', '--option', 'thinking=maybe'], 'Agent cursor model claude-opus-4-8 does not support thinking maybe.']
      ]
      for (const [args, message] of rows) {
        const result = await refused(args)
        expect(result.stderr).toContain(message)
        expect(result.stdout.trim()).toBe('')
      }
      expect(await cliJson<Session[]>(e2e, ['session', 'list'])).toEqual([])
      expect(await e2e.cli(['agents', 'resolve', 'claude', '--effort', 'low'])).toMatchObject({ code: 2 })
    },
    120_000
  )

  test(
    'SC-9: the CLI refuses --effort with --option effort= and a repeated --option key before calling the daemon',
    async () => {
      const both = await refused(['claude', '--model', 'opus', '--effort', 'high', '--option', 'effort=low'])
      expect(both.stderr).toContain('effort is set by both --effort and --option effort=…')
      const twice = await refused(['claude', '--model', 'opus', '--option', 'effort=low', '--option', 'effort=high'])
      expect(twice.stderr).toContain('--option effort given more than once')
      const another = await refused(['cursor', '--model', 'gpt-5.3-codex', '--option', 'fastMode=true', '--option', 'fastMode=false'])
      expect(another.stderr).toContain('--option fastMode given more than once')
    },
    60_000
  )

  test(
    'SC-9: the API refuses an oversize model, too many options, a long option ID and reserved option names as invalid parameters',
    async () => {
      const refusal = async (params: Record<string, unknown>) => {
        const failure = await failureOf(resolveOf(e2e, { agent: 'claude', ...params }))
        expect(failure.code).toBe(-32602)
        return failure
      }
      await refusal({ model: 'm'.repeat(129) })
      await refusal({ model: 'opus', options: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`o${i}`, 'x'])) })
      await refusal({ model: 'opus', options: { ['e'.repeat(65)]: 'x' } })
      for (const reserved of ['__proto__', 'constructor', 'prototype', 'model']) {
        await refusal({ model: 'opus', options: JSON.parse(`{"${reserved}":"x"}`) })
      }
      expect((await failureOf(resolveOf(e2e, { agent: 'claude', options: { effort: 'low' } }))).message).toBe('effort requires a model')
    },
    60_000
  )

  test(
    'SC-10: unlisted models pass where the agent allows them',
    async () => {
      expect((await resolveOf(e2e, { agent: 'claude', model: 'claude-opus-5-5', options: { effort: 'max' } })).added).toEqual([
        '--model',
        'claude-opus-5-5',
        '--effort',
        'max'
      ])
      expect((await resolveOf(e2e, { agent: 'codex', model: 'gpt-7', options: { effort: 'ultra' } })).added).toEqual([
        '-m',
        'gpt-7',
        '-c',
        'model_reasoning_effort=ultra'
      ])
      expect((await resolveOf(e2e, { agent: 'omp', model: 'anthropic/sonnet' })).added).toEqual(['--model', 'anthropic/sonnet'])

      const omp = await failureOf(resolveOf(e2e, { agent: 'omp', model: 'anthropic/sonnet', options: { effort: 'low' } }))
      expect(omp).toMatchObject({ code: -32602, message: 'Agent omp model anthropic/sonnet does not support effort low.' })
      const gemini = await failureOf(resolveOf(e2e, { agent: 'gemini', model: 'gemini-9' }))
      expect(gemini.message).toBe('Agent gemini does not support model gemini-9.')
    },
    60_000
  )

  test(
    'SC-11: Cursor folds its options into the model name',
    async () => {
      const added = async (model: string, options?: Record<string, unknown>) => (await resolveOf(e2e, { agent: 'cursor', model, ...(options ? { options } : {}) })).added
      expect(await added('claude-opus-4-8', { thinking: true, effort: 'high' })).toEqual(['--model', 'claude-opus-4-8-thinking-high'])
      expect(await added('gpt-5.3-codex', { effort: 'low', fastMode: true })).toEqual(['--model', 'gpt-5.3-codex-low-fast'])
      expect(await added('auto')).toEqual(['--model', 'auto'])
      const refusedAuto = await failureOf(resolveOf(e2e, { agent: 'cursor', model: 'auto', options: { effort: 'high' } }))
      expect(refusedAuto).toMatchObject({ code: -32602, message: 'Agent cursor model auto does not support effort high.' })
    },
    60_000
  )

  test(
    'SC-12: a pick replaces the configured model flag instead of repeating it',
    async () => {
      try {
        for (const configured of ['--model gpt-5.4 --search', '-m gpt-5.4 --search', '--model=gpt-5.4 --search', '-c model=gpt-5.4 --search']) {
          await configure(e2e, 'codex', `--args=${configured}`)
          const result = await resolveOf(e2e, { agent: 'codex', model: 'gpt-5.5' })
          expect(result.args).toBe('--search -m gpt-5.5')
          expect(result.args).not.toContain('gpt-5.4')
        }
        await configure(e2e, 'claude', '--args=--effort low --dangerously-skip-permissions')
        const claude = await resolveOf(e2e, { agent: 'claude', model: 'opus', options: { effort: 'high' } })
        expect(claude.args).toBe('--dangerously-skip-permissions --model opus --effort high')
      } finally {
        await configure(e2e, 'codex', '--reset', 'args')
        await configure(e2e, 'claude', '--reset', 'args')
      }
    },
    90_000
  )

  test(
    'SC-13: extra arguments beat a pick and the result says so',
    async () => {
      const result = await resolveCli('claude', '--model', 'opus', '--effort', 'low', '--extra-args=--effort high --add-dir docs')
      expect(result.args).toBe('--dangerously-skip-permissions --effort high --add-dir docs --model opus')
      expect(result.args.match(/--effort/g)).toHaveLength(1)
      expect(result.args).not.toContain('--effort low')
      expect(result.shadowed).toEqual(['effort'])
      expect(result.launchSettings).toEqual({
        agent: 'claude',
        options: { model: { value: 'opus', source: 'explicit' }, effort: { source: 'extra-args' } },
        args: { value: '--dangerously-skip-permissions --effort high --add-dir docs', source: 'explicit' },
        summary: 'Claude · Opus'
      })
      expect(result.structured).toEqual({ model: 'opus' })

      const text = await e2e.cli(['agents', 'resolve', 'claude', '--model', 'opus', '--effort', 'low', '--extra-args=--effort high --add-dir docs'])
      expect(text.stdout).toContain('set by extra args: effort')
    },
    60_000
  )

  test(
    'SC-14: extra arguments replace the configured model flag',
    async () => {
      try {
        await configure(e2e, 'claude', '--args=--model sonnet --dangerously-skip-permissions')
        const result = await resolveOf(e2e, { agent: 'claude', extraArgs: '--model opus --add-dir docs' })
        expect(result.args).toBe('--dangerously-skip-permissions --model opus --add-dir docs')
        expect(result.launchSettings?.args?.source).toBe('explicit')
      } finally {
        await configure(e2e, 'claude', '--reset', 'args')
      }
    },
    60_000
  )

  test(
    'SC-16: a command override that sets the model fails the launch',
    async () => {
      const message =
        'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'
      try {
        await configure(e2e, 'claude', '--command', 'claude --model sonnet')
        expect(await failureOf(resolveOf(e2e, { agent: 'claude', model: 'opus' }))).toMatchObject({ code: -32602, message })
        expect(await failureOf(resolveOf(e2e, { agent: 'claude', extraArgs: '--model opus' }))).toMatchObject({ code: -32602, message })
        const plain = await resolveOf(e2e, { agent: 'claude' })
        expect(plain).toMatchObject({ added: [], launchSettings: { agent: 'claude', options: {} } })
      } finally {
        await configure(e2e, 'claude', '--reset', 'command')
      }
    },
    60_000
  )

  test(
    'SC-17: extra arguments are checked against the allowlist',
    async () => {
      const rows: [string, string, string][] = [
        ['claude', '--verbose', '"--verbose" isn\'t allowed in extra arguments for Claude. Allowed: --model, --effort, --add-dir.'],
        ['claude', 'docs', '"docs" isn\'t an option. Extra arguments for Claude accept only: --model, --effort, --add-dir.'],
        ['claude', '--add-dir docs -- x', '"--" isn\'t allowed in extra arguments.'],
        ['claude', '--effort', '"--effort" needs a value.'],
        ['claude', '--model opus --model sonnet', 'Extra arguments set the model more than once.'],
        ['claude', '--add-dir $(pwd)', "$(pwd) uses shell syntax that extra arguments don't allow."],
        ['claude', `--add-dir ${'a'.repeat(4097 - '--add-dir '.length)}`, 'Extra arguments must be 4 KB or less.'],
        ['claude', '--add-dir a\nb', 'Extra arguments cannot contain control characters or line breaks.'],
        ['codex', '-c sandbox=none', '"-c sandbox=none" isn\'t allowed. Codex extra arguments accept only "-c model_reasoning_effort=<level>".'],
        ['aider', '--model x', "Extra arguments aren't supported for this agent yet."]
      ]
      expect(Buffer.byteLength(rows[6]![1])).toBe(4097)
      for (const [agent, text, message] of rows) {
        const result = await refused([agent, `--extra-args=${text}`])
        expect(result.stderr).toContain(message)
      }

      const repeated = await resolveCli('claude', '--extra-args=--add-dir docs --add-dir src')
      expect(repeated.args).toBe('--dangerously-skip-permissions --add-dir docs --add-dir src')
      for (const blank of ['', '   ']) {
        const none = await resolveCli('claude', `--extra-args=${blank}`)
        expect(none.args).toBe('--dangerously-skip-permissions')
        expect(none.launchSettings?.args?.source).toBe('inherited')
      }
    },
    120_000
  )
})

describe('launching a session (SC-18 to SC-23)', () => {
  let e2e: E2E
  beforeAll(async () => {
    e2e = await startAgentsE2E({ fakes: { claude: true, codex: true } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  const parsed = <T>(result: CliResult): T => {
    if (result.code !== 0) throw new Error(`quirky exited ${result.code}: ${result.stderr || result.stdout}`)
    return JSON.parse(result.stdout) as T
  }
  const newSession = async (...flags: string[]) => parsed<Session>(await e2e.cli(['session', 'new', ...flags, '--json']))
  const listSessions = async () => parsed<Session[]>(await e2e.cli(['session', 'list', '--json']))
  const startCount = (fake: string) => e2e.fakeLog(fake).filter((event) => event.type === 'start').length

  async function startOf(fake: string, session: Session): Promise<Start> {
    const events = await e2e.waitForFakeLog(fake, (log) => log.some((e) => e.type === 'start' && e.env.QUIRKY_SESSION_ID === session.id), 15_000)
    return events.find((e): e is Start => e.type === 'start' && e.env.QUIRKY_SESSION_ID === session.id)!
  }

  /** Removes and validates the one effective JSON settings option, leaving agent arguments for assertions. */
  function withoutHookSettings(argv: string[]): string[] {
    const terminator = argv.indexOf('--')
    const beforeTerminator = terminator < 0 ? argv : argv.slice(0, terminator)
    const at = beforeTerminator.indexOf('--settings')
    if (at === -1) return argv
    expect(beforeTerminator.filter((argument) => argument === '--settings')).toHaveLength(1)
    const settings = JSON.parse(beforeTerminator[at + 1]!) as { hooks: Record<string, unknown[]> }
    expect(settings.hooks).toBeDefined()
    return [...argv.slice(0, at), ...argv.slice(at + 2)]
  }

  const contains = (argv: string[], run: string[]) => argv.some((_, i) => run.every((token, j) => argv[i + j] === token))

  test(
    'SC-18: a session starts with the picked model and effort and shows what it used',
    async () => {
      const session = await newSession('--agent', 'claude', '--model', 'opus', '--effort', 'high', '--prompt', 'hi')
      const started = await startOf('claude', session)
      expect(withoutHookSettings(started.argv)).toEqual(['--dangerously-skip-permissions', '--model', 'opus', '--effort', 'high', 'hi'])
      expect(started.argv.filter((a) => a === '--model')).toHaveLength(1)
      expect(started.argv.filter((a) => a === '--effort')).toHaveLength(1)

      expect(session.launchSettings).toEqual({
        agent: 'claude',
        options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
        args: { value: '--dangerously-skip-permissions', source: 'inherited' },
        summary: 'Claude · Opus · Effort: high'
      })
      const fetched = parsed<Session>(await e2e.cli(['session', 'get', session.id, '--json']))
      expect(fetched.launchSettings).toEqual(session.launchSettings)
      const text = await e2e.cli(['session', 'get', session.id])
      expect(text.code).toBe(0)
      expect(text.stdout).toMatch(/^launch: Claude · Opus · Effort: high$/im)
    },
    60_000
  )

  test(
    'SC-19: extra arguments reach a session',
    async () => {
      const session = await newSession('--agent', 'claude', '--extra-args=--add-dir docs')
      const started = await startOf('claude', session)
      expect(withoutHookSettings(started.argv)).toEqual(['--dangerously-skip-permissions', '--add-dir', 'docs'])
      expect(session.launchSettings?.args).toEqual({ value: '--dangerously-skip-permissions --add-dir docs', source: 'explicit' })
      expect(session.launchSettings?.options).toEqual({})
    },
    60_000
  )

  test(
    'SC-20: an invalid pick creates no session',
    async () => {
      await e2e.waitForFakeLog('claude', (log) => log.filter((e) => e.type === 'start').length === 2, 15_000)
      const before = await listSessions()
      const spawned = startCount('claude') + startCount('codex')

      const haiku = await e2e.cli(['session', 'new', '--agent', 'claude', '--model', 'haiku', '--effort', 'low'])
      expect(haiku.code).not.toBe(0)
      expect(haiku.stderr).toContain('Agent claude model haiku does not support effort low.')

      const shell = await e2e.cli(['session', 'new', '--agent', 'shell', '--model', 'opus'])
      expect(shell.code).not.toBe(0)
      expect(shell.stderr).toContain('Agent shell does not support launch-time model selection.')

      await Bun.sleep(300)
      expect(await listSessions()).toEqual(before)
      expect(startCount('claude') + startCount('codex')).toBe(spawned)
    },
    60_000
  )

  test(
    'SC-21: resume and fork keep the original model and effort',
    async () => {
      const first = await newSession('--agent', 'codex', '--model', 'gpt-5.5', '--effort', 'low')
      await startOf('codex', first)
      expect((await e2e.cli(['session', 'set-provider-session', first.id, 'abc'])).code).toBe(0)
      await configure(e2e, 'codex', '--args=--model gpt-5.4')
      try {
        const picked = ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=low']
        for (const [flags, verb] of [[[], 'resume'], [['--fork'], 'fork']] as const) {
          const next = parsed<Session>(await e2e.cli(['session', 'resume', first.id, ...flags, '--json']))
          expect(next.id).not.toBe(first.id)
          expect(next.launchSettings).toEqual(first.launchSettings)
          const started = await startOf('codex', next)
          expect(contains(started.argv, picked)).toBe(true)
          expect(started.argv.slice(-2)).toEqual([verb, 'abc'])
          expect(started.argv).not.toContain('gpt-5.4')
          expect(started.argv.join(' ')).not.toContain('gpt-5.4')
        }
      } finally {
        await configure(e2e, 'codex', '--reset', 'args')
      }
    },
    90_000
  )

  test(
    'SC-22: a session with no pick records only its inherited arguments',
    async () => {
      try {
        expect((await e2e.cli(['agents', 'permissions', 'manual', '--agent', 'claude'])).code).toBe(0)
        const manual = await newSession('--agent', 'claude')
        expect(manual.launchSettings ?? null).toBeNull()
        const manualText = await e2e.cli(['session', 'get', manual.id])
        expect(manualText.code).toBe(0)
        expect(manualText.stdout).not.toMatch(/^launch/im)
        expect(withoutHookSettings((await startOf('claude', manual)).argv)).toEqual([])

        expect((await e2e.cli(['agents', 'permissions', 'yolo', '--agent', 'claude'])).code).toBe(0)
        const yolo = await newSession('--agent', 'claude')
        expect(yolo.launchSettings).toEqual({
          agent: 'claude',
          options: {},
          args: { value: '--dangerously-skip-permissions', source: 'inherited' },
          summary: 'Claude'
        })
        expect(yolo.launch).toEqual({ command: 'claude', args: '--dangerously-skip-permissions', env: {} })
        expect(withoutHookSettings((await startOf('claude', yolo)).argv)).toEqual(['--dangerously-skip-permissions'])
        const fetched = parsed<Session>(await e2e.cli(['session', 'get', yolo.id, '--json']))
        expect(fetched.launchSettings).toEqual(yolo.launchSettings)
      } finally {
        await e2e.cli(['agents', 'permissions', 'yolo', '--agent', 'claude'])
      }
    },
    90_000
  )

  test(
    'SC-23: a structured session refuses extra arguments and registers nothing',
    async () => {
      const before = await listSessions()
      const spawned = startCount('claude')
      const result = await e2e.cli(['session', 'new', '--background', '--agent', 'claude', '--prompt', 'hi', '--extra-args=--model x'])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("Extra arguments can't be applied to a structured session.")
      expect(await listSessions()).toEqual(before)
      expect(startCount('claude')).toBe(spawned)
    },
    60_000
  )
})
