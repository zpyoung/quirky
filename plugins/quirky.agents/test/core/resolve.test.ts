import { describe, expect, test } from 'bun:test'
import { findOptionOccurrence } from '../../src/core/arg-occurrence'
import { formatSummary, resolveLaunch } from '../../src/core/resolve'
import { SelectionError } from '../../src/core/selection'
import { joinCommand, tokenize } from '../../src/core/shell'
import type {
  AgentEntry,
  Conflict,
  ExtraArgKind,
  LaunchCatalog,
  ParsedExtras,
  Resolution,
  ValidSelection
} from '../../src/core/types'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const choices = (values: string[]) => values.map((value) => ({ value, label: value }))

const CLAUDE_CATALOG: LaunchCatalog = {
  model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }], structured: 'model' },
  options: [
    {
      id: 'effort',
      label: 'Effort',
      type: 'select',
      choices: choices(EFFORT_LEVELS),
      flag: ['--effort', '{value}'],
      conflicts: [{ flags: ['--effort'] }],
      composed: false,
      structured: 'effort'
    }
  ],
  models: [
    { id: 'opus', label: 'Opus', description: null, options: [{ id: 'effort', choices: null }] },
    { id: 'haiku', label: 'Haiku', description: null, options: [] }
  ],
  unlisted: 'accept',
  unlistedOptions: [{ id: 'effort', choices: null }],
  composeModel: null,
  valueFlags: ['--add-dir', '--effort', '--model'],
  extraArgs: null
}

const CODEX_CATALOG: LaunchCatalog = {
  model: {
    flag: ['-m', '{value}'],
    conflicts: [{ flags: ['-m', '--model'] }, { flags: ['-c', '--config'], valuePrefix: 'model=' }],
    structured: null
  },
  options: [
    {
      id: 'effort',
      label: 'Reasoning effort',
      type: 'select',
      choices: choices(CODEX_LEVELS),
      flag: ['-c', 'model_reasoning_effort={value}'],
      conflicts: [{ flags: ['--reasoning-effort'] }, { flags: ['-c', '--config'], valuePrefix: 'model_reasoning_effort=' }],
      composed: false,
      structured: null
    }
  ],
  models: [{ id: 'gpt-5.5', label: 'GPT-5.5', description: null, options: [{ id: 'effort', choices: CODEX_LEVELS.slice(0, 5) }] }],
  unlisted: 'accept',
  unlistedOptions: [{ id: 'effort', choices: null }],
  composeModel: null,
  valueFlags: [],
  extraArgs: null
}

const CURSOR_CATALOG: LaunchCatalog = {
  model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['-m', '--model'] }], structured: null },
  options: [
    { id: 'effort', label: 'Effort', type: 'select', choices: choices(['low', 'medium', 'high']), flag: null, conflicts: [], composed: true, structured: null },
    { id: 'fastMode', label: 'Fast mode', type: 'boolean', choices: null, flag: null, conflicts: [], composed: true, structured: null },
    { id: 'thinking', label: 'Thinking', type: 'boolean', choices: null, flag: null, conflicts: [], composed: true, structured: null }
  ],
  models: [
    { id: 'auto', label: 'Auto', description: null, options: [] },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: null, options: [{ id: 'effort', choices: null }, { id: 'fastMode', choices: null }] },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: null, options: [{ id: 'thinking', choices: null }, { id: 'effort', choices: null }] }
  ],
  unlisted: 'refuse',
  unlistedOptions: [],
  composeModel: 'cursor',
  valueFlags: ['--model'],
  extraArgs: null
}

function agent(id: string, label: string, launchOptions: LaunchCatalog | null, yolo: string | null = null): AgentEntry {
  return {
    id,
    plugin: 'quirky.agents',
    label,
    detect: id,
    detectAliases: [],
    detectRequires: [],
    launch: id,
    process: id,
    env: {},
    prompt: 'argv',
    promptSeparator: null,
    draftFlag: null,
    yolo,
    auto: null,
    yoloEnv: null,
    stripArgs: [],
    resume: null,
    fork: null,
    resumeStyle: null,
    readySignal: 'render-quiet-after-bracketed-paste',
    submitSignal: 'render-quiet-after-bracketed-paste',
    readyTimeoutMs: 8000,
    blindPaste: true,
    submitRetryMs: null,
    lineSettleMs: null,
    enterWithPaste: false,
    trust: null,
    homepage: null,
    install: null,
    launchOptions,
    oneShot: null
  }
}

const CLAUDE = agent('claude', 'Claude', CLAUDE_CATALOG, '--dangerously-skip-permissions')
const CODEX = agent('codex', 'Codex', CODEX_CATALOG)
const CURSOR = agent('cursor', 'Cursor', CURSOR_CATALOG)
const YOLO = ['--dangerously-skip-permissions']

const words = (text: string): string[] => {
  const result = tokenize(text)
  if (!result.ok) throw new Error(result.error)
  return result.tokens
}

function pick(model: string, values: Record<string, string | boolean> = {}, listed = true): ValidSelection {
  return { model, values: Object.assign(Object.create(null), values), listed }
}

function extrasOf(text: string, ...kinds: ExtraArgKind[]): ParsedExtras {
  return { tokens: words(text), kinds: new Set(kinds) }
}

type Overrides = Partial<{
  entry: AgentEntry
  commandTokens: string[]
  configuredArgs: string[]
  selection: ValidSelection | null
  extras: ParsedExtras | null
  structured: boolean
}>

function resolve(overrides: Overrides = {}): Resolution {
  return resolveLaunch({
    entry: CLAUDE,
    commandTokens: [],
    configuredArgs: [],
    selection: null,
    extras: null,
    structured: false,
    ...overrides
  })
}

function refusal(overrides: Overrides): string {
  try {
    resolve(overrides)
  } catch (error) {
    expect(error).toBeInstanceOf(SelectionError)
    return (error as Error).message
  }
  throw new Error('expected a SelectionError')
}

describe('resolveLaunch: terminal launches', () => {
  test('SC-6: a model and effort become flags, structured options and a snapshot', () => {
    const result = resolve({ configuredArgs: YOLO, selection: pick('opus', { effort: 'high' }) })
    expect(result.added).toEqual(['--model', 'opus', '--effort', 'high'])
    expect(result.args).toEqual([...YOLO, '--model', 'opus', '--effort', 'high'])
    expect(result.structured).toEqual({ model: 'opus', effort: 'high' })
    expect(result.shadowed).toEqual([])
    expect(result.launchSettings).toEqual({
      agent: 'claude',
      options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
      args: { value: '--dangerously-skip-permissions', source: 'inherited' },
      summary: 'Claude · Opus · Effort: high'
    })
  })

  test('SC-7: codex effort goes through -c', () => {
    const result = resolve({ entry: CODEX, selection: pick('gpt-5.5', { effort: 'low' }) })
    expect(result.added).toEqual(['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=low'])
    expect(result.launchSettings?.summary).toBe('Codex · GPT-5.5 · Reasoning effort: low')
  })

  test('SC-8: no pick adds nothing and Manual has no snapshot', () => {
    const manual = resolve()
    expect(manual).toEqual({ added: [], args: [], structured: {}, shadowed: [], launchSettings: null })
    const yolo = resolve({ configuredArgs: YOLO })
    expect(yolo.added).toEqual([])
    expect(yolo.args).toEqual(YOLO)
    expect(yolo.launchSettings).toEqual({
      agent: 'claude',
      options: {},
      args: { value: '--dangerously-skip-permissions', source: 'inherited' },
      summary: 'Claude'
    })
  })

  test('a model alone adds no effort default', () => {
    const result = resolve({ entry: CODEX, selection: pick('gpt-5.5') })
    expect(result.added).toEqual(['-m', 'gpt-5.5'])
    expect(result.launchSettings?.options).toEqual({ 'model': { value: 'gpt-5.5', source: 'explicit' } })
  })

  test('an unlisted model shows its ID in the summary', () => {
    const result = resolve({ selection: pick('claude-opus-5-5', { effort: 'max' }, false) })
    expect(result.added).toEqual(['--model', 'claude-opus-5-5', '--effort', 'max'])
    expect(result.launchSettings?.summary).toBe('Claude · claude-opus-5-5 · Effort: max')
  })

  test('flags land before the configured terminator', () => {
    const result = resolve({ configuredArgs: ['--verbose', '--', 'tail'], selection: pick('opus') })
    expect(result.args).toEqual(['--verbose', '--model', 'opus', '--', 'tail'])
  })

  test('a model value is one token and is never split or expanded', () => {
    const result = resolve({ selection: pick('a b $& c', {}, false) })
    expect(result.added).toEqual(['--model', 'a b $& c'])
    expect(result.launchSettings?.args).toBeUndefined()
  })

  test('the snapshot arguments are shell-quoted without the pick flags', () => {
    const result = resolve({ configuredArgs: ['--add-dir', 'my docs'], selection: pick('opus') })
    expect(result.launchSettings?.args).toEqual({ value: joinCommand(['--add-dir', 'my docs']), source: 'inherited' })
  })

  test('SC-11: cursor folds options into the model name', () => {
    const cases: [ValidSelection, string][] = [
      [pick('claude-opus-4-8', { thinking: true, effort: 'high' }), 'claude-opus-4-8-thinking-high'],
      [pick('gpt-5.3-codex', { effort: 'low', fastMode: true }), 'gpt-5.3-codex-low-fast'],
      [pick('auto'), 'auto']
    ]
    for (const [selection, model] of cases) {
      const result = resolve({ entry: CURSOR, selection })
      expect(result.added).toEqual(['--model', model])
      expect(result.args).toEqual(['--model', model])
    }
  })

  test('SC-11: cursor marks composed options explicit and replaces a configured model flag', () => {
    const result = resolve({
      entry: CURSOR,
      configuredArgs: ['-m', 'auto', '--force'],
      selection: pick('claude-opus-4-8', { thinking: true, effort: 'high' })
    })
    expect(result.args).toEqual(['--force', '--model', 'claude-opus-4-8-thinking-high'])
    expect(result.launchSettings?.options).toEqual({
      model: { value: 'claude-opus-4-8', source: 'explicit' },
      effort: { value: 'high', source: 'explicit' },
      thinking: { value: true, source: 'explicit' }
    })
    expect(result.launchSettings?.summary).toBe('Cursor · Claude Opus 4.8 · Effort: high · Thinking')
    expect(result.structured).toEqual({})
  })
})

describe('resolveLaunch: precedence', () => {
  test.each([
    ['--model gpt-5.4 --search'],
    ['-m gpt-5.4 --search'],
    ['--model=gpt-5.4 --search'],
    ['-c model=gpt-5.4 --search'],
    ['-mgpt-5.4 --search']
  ])('SC-12: a pick replaces the configured model spelling %p', (configured) => {
    const result = resolve({ entry: CODEX, configuredArgs: words(configured), selection: pick('gpt-5.5') })
    expect(result.args).toEqual(['--search', '-m', 'gpt-5.5'])
    expect(result.launchSettings?.args).toEqual({ value: '--search', source: 'inherited' })
  })

  test('SC-12: a codex config entry for another key stays', () => {
    const result = resolve({ entry: CODEX, configuredArgs: ['-c', 'sandbox=none'], selection: pick('gpt-5.5', { effort: 'low' }) })
    expect(result.args).toEqual(['-c', 'sandbox=none', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=low'])
  })

  test('SC-12: claude effort pick replaces a configured --effort', () => {
    for (const configured of [['--effort', 'low'], ['--effort=low']]) {
      const result = resolve({ configuredArgs: [...configured, '--verbose'], selection: pick('opus', { effort: 'high' }) })
      expect(result.args).toEqual(['--verbose', '--model', 'opus', '--effort', 'high'])
    }
  })

  test('a configured effort stays when no effort is picked', () => {
    const result = resolve({ configuredArgs: ['--effort', 'low'], selection: pick('opus') })
    expect(result.args).toEqual(['--effort', 'low', '--model', 'opus'])
  })

  test('SC-13: extra arguments beat a pick, and the snapshot says so', () => {
    const result = resolve({
      configuredArgs: YOLO,
      selection: pick('opus', { effort: 'low' }),
      extras: extrasOf('--effort high --add-dir docs', 'effort', 'repeatable')
    })
    expect(result.args).toEqual([...YOLO, '--effort', 'high', '--add-dir', 'docs', '--model', 'opus'])
    expect(result.added).toEqual(['--model', 'opus'])
    expect(result.shadowed).toEqual(['effort'])
    expect(result.structured).toEqual({ model: 'opus' })
    expect(result.launchSettings).toEqual({
      agent: 'claude',
      options: { model: { value: 'opus', source: 'explicit' }, effort: { source: 'extra-args' } },
      args: { value: '--dangerously-skip-permissions --effort high --add-dir docs', source: 'explicit' },
      summary: 'Claude · Opus'
    })
  })

  test('SC-13: extras that set the model shadow the whole pick', () => {
    const result = resolve({
      selection: pick('opus', { effort: 'low' }),
      extras: extrasOf('--model sonnet', 'model')
    })
    expect(result.args).toEqual(['--model', 'sonnet'])
    expect(result.added).toEqual([])
    expect(result.shadowed).toEqual(['model', 'effort'])
    expect(result.structured).toEqual({})
    expect(result.launchSettings?.options).toEqual({ model: { source: 'extra-args' }, effort: { source: 'extra-args' } })
    expect(result.launchSettings?.summary).toBe('Claude')
  })

  test('SC-13: codex extras with a model or effort spelling shadow the matching picks', () => {
    const effort = resolve({
      entry: CODEX,
      selection: pick('gpt-5.5', { effort: 'low' }),
      extras: extrasOf('-c model_reasoning_effort=high', 'effort')
    })
    expect(effort.args).toEqual(['-c', 'model_reasoning_effort=high', '-m', 'gpt-5.5'])
    expect(effort.shadowed).toEqual(['effort'])
    const model = resolve({ entry: CODEX, selection: pick('gpt-5.5'), extras: extrasOf('-c model=gpt-5.4', 'model') })
    expect(model.args).toEqual(['-c', 'model=gpt-5.4'])
    expect(model.shadowed).toEqual(['model'])
  })

  test('SC-14: extras replace the configured model flag', () => {
    const result = resolve({
      configuredArgs: ['--model', 'sonnet', ...YOLO],
      extras: extrasOf('--model opus --add-dir docs', 'model', 'repeatable')
    })
    expect(result.args).toEqual([...YOLO, '--model', 'opus', '--add-dir', 'docs'])
    expect(result.added).toEqual([])
    expect(result.launchSettings).toEqual({
      agent: 'claude',
      options: {},
      args: { value: '--dangerously-skip-permissions --model opus --add-dir docs', source: 'explicit' },
      summary: 'Claude'
    })
  })

  test('extras go before the configured terminator, with the pick after them', () => {
    const result = resolve({
      configuredArgs: ['--verbose', '--', 'tail'],
      selection: pick('opus'),
      extras: extrasOf('--add-dir docs', 'repeatable')
    })
    expect(result.args).toEqual(['--verbose', '--add-dir', 'docs', '--model', 'opus', '--', 'tail'])
  })

  test('a value flag holding -- is not the terminator', () => {
    const result = resolve({ configuredArgs: ['--add-dir', '--', 'x'], selection: pick('opus') })
    expect(result.args).toEqual(['--add-dir', '--', 'x', '--model', 'opus'])
  })
})

describe('resolveLaunch: command override', () => {
  const override = ['claude', '--model', 'sonnet']
  const message =
    'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'

  test('SC-16: a pick that sets a model the override already sets is refused', () => {
    expect(refusal({ commandTokens: override, selection: pick('opus') })).toBe(message)
  })

  test('SC-16: extras that set the model are refused', () => {
    expect(refusal({ commandTokens: override, extras: extrasOf('--model opus', 'model') })).toBe(message)
  })

  test('SC-16: an override that sets effort refuses an effort pick, even when the model is free', () => {
    expect(refusal({ commandTokens: ['claude', '--effort=low'], selection: pick('opus', { effort: 'high' }) })).toBe(message)
    expect(resolve({ commandTokens: ['claude', '--effort=low'], selection: pick('opus') }).added).toEqual(['--model', 'opus'])
  })

  test('SC-16: codex config spellings in the override count', () => {
    expect(refusal({ entry: CODEX, commandTokens: ['codex', '-c', 'model=gpt-5.4'], selection: pick('gpt-5.5') })).toBe(message)
  })

  test('SC-16: with no pick and no extras the override launches as before', () => {
    expect(resolve({ commandTokens: override, configuredArgs: YOLO }).args).toEqual(YOLO)
  })

  test('SC-16: a wrapper command with its own -- is still scanned for conflicting flags', () => {
    expect(refusal({ commandTokens: ['env', '--', 'claude', '--model', 'sonnet'], selection: pick('opus') })).toBe(message)
    expect(
      refusal({ commandTokens: ['env', 'FOO=1', 'claude', '--effort', 'low'], selection: pick('opus', { effort: 'high' }) })
    ).toBe(message)
  })

  test('the executable itself is not scanned', () => {
    expect(resolve({ commandTokens: ['--model'], selection: pick('opus') }).added).toEqual(['--model', 'opus'])
  })
})

describe('resolveLaunch: structured launches', () => {
  test('SC-13: a structured pick carries the model and effort keys and no argv', () => {
    const result = resolve({ configuredArgs: YOLO, selection: pick('opus', { effort: 'high' }), structured: true })
    expect(result.structured).toEqual({ model: 'opus', effort: 'high' })
    expect(result.added).toEqual([])
    expect(result.args).toEqual([])
    expect(result.shadowed).toEqual([])
    expect(result.launchSettings).toEqual({
      agent: 'claude',
      options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
      summary: 'Claude · Opus · Effort: high'
    })
  })

  test('SC-13: a structured model alone', () => {
    const result = resolve({ selection: pick('opus'), structured: true })
    expect(result.structured).toEqual({ model: 'opus' })
    expect(result.launchSettings?.options).toEqual({ model: { value: 'opus', source: 'explicit' } })
  })

  test('SC-23: no pick means no structured options and no snapshot', () => {
    const result = resolve({ configuredArgs: YOLO, structured: true })
    expect(result).toEqual({ added: [], args: [], structured: {}, shadowed: [], launchSettings: null })
  })

  test('SC-24: extras are refused', () => {
    expect(refusal({ extras: extrasOf('--add-dir docs', 'repeatable'), structured: true })).toBe(
      "Extra arguments can't be applied to a structured session."
    )
  })

  test('SC-24: an agent whose model has no structured key is refused', () => {
    expect(refusal({ entry: CODEX, selection: pick('gpt-5.5'), structured: true })).toBe(
      'Agent codex does not support launch-time model selection.'
    )
    expect(refusal({ entry: agent('aider', 'Aider', null), selection: pick('x', {}, false), structured: true })).toBe(
      'Agent aider does not support launch-time model selection.'
    )
  })

  test('an option with only a flag is refused on a structured launch', () => {
    const catalog: LaunchCatalog = {
      ...CLAUDE_CATALOG,
      options: [{ ...CLAUDE_CATALOG.options[0]!, structured: null }]
    }
    expect(refusal({ entry: agent('claude', 'Claude', catalog), selection: pick('opus', { effort: 'high' }), structured: true })).toBe(
      "Agent claude option effort can't be applied to a structured launch."
    )
  })

  test('an option with only a structured key is refused on a terminal launch', () => {
    const catalog: LaunchCatalog = {
      ...CLAUDE_CATALOG,
      options: [{ ...CLAUDE_CATALOG.options[0]!, flag: null, conflicts: [] }]
    }
    const entry = agent('claude', 'Claude', catalog)
    expect(refusal({ entry, selection: pick('opus', { effort: 'high' }) })).toBe(
      "Agent claude option effort can't be applied to a terminal launch."
    )
    expect(resolve({ entry, selection: pick('opus', { effort: 'high' }), structured: true }).structured).toEqual({
      model: 'opus',
      effort: 'high'
    })
  })
})

describe('formatSummary', () => {
  test('lists the agent, the model label and each explicit option in declared order', () => {
    const options = {
      thinking: { value: true, source: 'explicit' as const },
      model: { value: 'claude-opus-4-8', source: 'explicit' as const },
      effort: { value: 'high', source: 'explicit' as const }
    }
    expect(formatSummary(CURSOR, options)).toBe('Cursor · Claude Opus 4.8 · Effort: high · Thinking')
  })

  test('a false boolean reads Off and extra-args entries are left out', () => {
    expect(
      formatSummary(CURSOR, {
        model: { value: 'gpt-5.3-codex', source: 'explicit' },
        fastMode: { value: false, source: 'explicit' },
        effort: { source: 'extra-args' }
      })
    ).toBe('Cursor · GPT-5.3 Codex · Fast mode: Off')
  })

  test('an agent without a catalog is just its label', () => {
    expect(formatSummary(agent('aider', 'Aider', null), {})).toBe('Aider')
  })
})

describe('SC-15: the snapshot agrees with the command', () => {
  type Subject = { entry: AgentEntry; model: string; efforts: string[]; modelFlag: string[]; effortFlag: string[]; effortValue: (v: string) => string }
  const subjects: Subject[] = [
    {
      entry: CLAUDE,
      model: 'opus',
      efforts: ['low', 'high'],
      modelFlag: ['--model', 'sonnet'],
      effortFlag: ['--effort', 'medium'],
      effortValue: (value) => value
    },
    {
      entry: CODEX,
      model: 'gpt-5.5',
      efforts: ['low', 'xhigh'],
      modelFlag: ['-c', 'model=gpt-5.4'],
      effortFlag: ['-c', 'model_reasoning_effort=minimal'],
      effortValue: (value) => `model_reasoning_effort=${value}`
    }
  ]
  const extraModel: Record<string, string> = { claude: '--model haiku', codex: '--model gpt-5.2-codex' }
  const extraEffort: Record<string, string> = { claude: '--effort max', codex: '-c model_reasoning_effort=max' }

  function occurrences(tokens: string[], conflicts: Conflict[], valueFlags: string[]): number {
    let count = 0
    for (const { flags, valuePrefix } of conflicts) {
      let rest = tokens
      for (let found = findOptionOccurrence(rest, flags, true, valueFlags); found; found = findOptionOccurrence(rest, flags, true, valueFlags)) {
        if (valuePrefix === undefined || found.value?.startsWith(valuePrefix)) count += 1
        rest = rest.slice(found.index + found.consumed)
      }
    }
    return count
  }

  for (const subject of subjects) {
    const { entry } = subject
    const catalog = entry.launchOptions!
    const effort = catalog.options[0]!
    const configuredVariants: [string, string[]][] = [
      ['neither', []],
      ['model', subject.modelFlag],
      ['effort', subject.effortFlag],
      ['both', [...subject.modelFlag, ...subject.effortFlag]]
    ]
    const extrasVariants: [string, ParsedExtras | null][] = [
      ['none', null],
      ['model', extrasOf(extraModel[entry.id]!, 'model')],
      ['effort', extrasOf(extraEffort[entry.id]!, 'effort')],
      ['both', extrasOf(`${extraModel[entry.id]} ${extraEffort[entry.id]}`, 'model', 'effort')]
    ]
    const selections: [string, ValidSelection | null][] = [
      ['no pick', null],
      ['model', pick(subject.model)],
      ...subject.efforts.map((level): [string, ValidSelection] => [`model + effort ${level}`, pick(subject.model, { effort: level })])
    ]

    test(`${entry.id}: every combination keeps explicit, extra-args and the argv consistent`, () => {
      let checked = 0
      for (const [, selection] of selections) {
        for (const [, configuredArgs] of configuredVariants) {
          for (const [, extras] of extrasVariants) {
            const label = JSON.stringify({ selection, configuredArgs, extras: extras?.tokens })
            const result = resolve({ entry, selection, configuredArgs, extras })
            const options = result.launchSettings?.options ?? {}
            const argv = result.args

            expect(occurrences(argv, catalog.model.conflicts, catalog.valueFlags), label).toBeLessThanOrEqual(1)
            expect(occurrences(argv, effort.conflicts, catalog.valueFlags), label).toBeLessThanOrEqual(1)

            const picked: Record<string, string> = {}
            if (selection) picked.model = selection.model
            const pickedEffort = selection?.values.effort
            if (typeof pickedEffort === 'string') picked.effort = pickedEffort
            const emitted: Record<string, boolean> = {
              model: selection !== null && result.added.includes(selection.model),
              effort: typeof pickedEffort === 'string' && result.added.includes(subject.effortValue(pickedEffort))
            }
            for (const id of ['model', 'effort']) {
              if (!(id in picked)) {
                expect(options[id], label).toBeUndefined()
                continue
              }
              expect(options[id]?.source, `${id} ${label}`).toBe(emitted[id] ? 'explicit' : 'extra-args')
              expect(options[id]?.value, `${id} ${label}`).toBe(emitted[id] ? picked[id] : undefined)
              expect(result.shadowed.includes(id), `${id} ${label}`).toBe(!emitted[id])
            }
            expect(Object.keys(result.structured).every((key) => emitted[key === 'model' ? 'model' : 'effort']), label).toBe(true)
            expect(argv.join(' ').includes(result.added.join(' ')), label).toBe(true)
            checked += 1
          }
        }
      }
      expect(checked).toBe(selections.length * configuredVariants.length * extrasVariants.length)
    })
  }
})
