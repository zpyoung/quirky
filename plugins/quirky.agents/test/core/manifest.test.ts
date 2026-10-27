import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ContributionInfo, PluginInfo } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../../packages/daemon/test/plugins/fixtures'
import { AUTO_PICK_ORDER, buildCatalog } from '../../src/core/catalog'
import { validateEntry } from '../../src/core/entry'
import type { AgentEntry } from '../../src/core/types'

const PLUGIN_DIR = join(import.meta.dir, '../..')

type ManifestEntry = { id: string } & Record<string, unknown>
type Manifest = {
  id: string
  name: string
  version: string
  main: string
  activation: string
  dependencies?: string[]
  contributes: { agent: ManifestEntry[]; setting: ({ id: string } & Record<string, unknown>)[] } & Record<string, unknown[]>
}

const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'quirky-plugin.json'), 'utf8')) as Manifest

// [id, label, detect, aliases, requires, launch, prompt, resume argv after the command ('' = none)]
// Transcribed from providers.md "Every supported agent".
const TABLE: [string, string, string, string[], string[], string, string, string][] = [
  ['claude', 'Claude', 'claude', [], [], 'claude', 'argv', '--resume {id}'],
  ['claude-agent-teams', 'Claude Agent Teams', 'claude', [], [], 'claude --teammate-mode in-process', 'stdin-after-start', ''],
  ['openclaude', 'OpenClaude', 'openclaude', [], [], 'openclaude', 'argv', ''],
  ['codex', 'Codex', 'codex', [], [], 'codex', 'argv', 'resume {id}'],
  ['grok', 'Grok', 'grok', [], [], 'grok', 'argv', '--resume {id}'],
  ['copilot', 'GitHub Copilot', 'copilot', [], [], 'copilot', 'flag-interactive', '--resume={id}'],
  ['opencode2', 'OpenCode 2', 'opencode2', [], [], 'opencode2 --standalone', 'flag-prompt', '--session {id}'],
  ['opencode', 'OpenCode', 'opencode', [], [], 'opencode', 'flag-prompt', '--session {id}'],
  ['mimo-code', 'MiMo Code', 'mimo', [], [], 'mimo', 'flag-prompt', '--session {id}'],
  ['ante', 'Ante', 'ante', [], [], 'ante', 'stdin-after-start', ''],
  ['trae', 'Trae', 'traecli', [], [], 'traecli', 'argv', ''],
  ['muse', 'Muse', 'muse', [], [], 'muse --trust-workspace', 'stdin-after-start', 'resume {id}'],
  ['dsh', 'DeepSeek Harness', 'dsh-tui', ['dst'], ['dsh'], 'dsh-tui .', 'stdin-after-start', '--resume {id}'],
  ['qoder', 'Qoder CLI', 'qodercli', ['qoder'], [], 'qodercli', 'flag-prompt-interactive', '--resume {id}'],
  ['qoder-cn', 'Qoder CLI China', 'qoderclicn', ['qodercn'], [], 'qoderclicn', 'flag-prompt-interactive', '--resume {id}'],
  ['zcode', 'ZCode', 'zcode', [], [], 'zcode', 'stdin-after-start', '--resume {id}'],
  ['pi', 'Pi', 'pi', [], [], 'pi', 'argv', '--session {transcript}'],
  ['omp', 'OMP', 'omp', [], [], 'omp', 'argv', '--resume {transcriptOrId}'],
  ['prime-agent', 'Prime Agent', 'prime-agent', [], [], 'prime-agent', 'argv', '--resume {transcript}'],
  ['gemini', 'Gemini', 'gemini', [], [], 'gemini', 'flag-prompt-interactive', '--resume {id}'],
  ['antigravity', 'Antigravity', 'agy', [], [], 'agy', 'flag-prompt-interactive', '--conversation {id}'],
  ['aider', 'Aider', 'aider', [], [], 'aider', 'stdin-after-start', ''],
  ['goose', 'Goose', 'goose', [], [], 'goose', 'stdin-after-start', ''],
  ['amp', 'Amp', 'amp', [], [], 'amp', 'stdin-after-start', ''],
  ['kilo', 'Kilocode', 'kilo', [], [], 'kilo', 'stdin-after-start', ''],
  ['kiro', 'Kiro', 'kiro-cli', [], [], 'kiro-cli chat --tui', 'stdin-after-start', '--resume-id {id}'],
  ['crush', 'Charm', 'crush', [], [], 'crush', 'stdin-after-start', ''],
  ['aug', 'Auggie', 'auggie', [], [], 'auggie', 'stdin-after-start', ''],
  ['autohand', 'Autohand Code', 'autohand', [], [], 'autohand', 'stdin-after-start', ''],
  ['cline', 'Cline', 'cline', [], [], 'cline', 'stdin-after-start', ''],
  ['codebuff', 'Codebuff', 'codebuff', [], [], 'codebuff', 'stdin-after-start', ''],
  ['freebuff', 'Freebuff', 'freebuff', [], [], 'freebuff', 'stdin-after-start', ''],
  ['command-code', 'Command Code', 'command-code', [], [], 'command-code --trust', 'argv', ''],
  ['continue', 'Continue', 'cn', [], [], 'cn', 'stdin-after-start', ''],
  ['cursor', 'Cursor', 'cursor-agent', [], [], 'cursor-agent', 'argv', '--resume {id}'],
  ['droid', 'Droid', 'droid', [], [], 'droid', 'argv', '--resume {id}'],
  ['kimi', 'Kimi', 'kimi', ['kimi-code'], [], 'kimi', 'stdin-after-start', '--session {id}'],
  ['mistral-vibe', 'Mistral Vibe', 'vibe', ['mistral-vibe'], [], 'vibe', 'stdin-after-start', ''],
  ['qwen-code', 'Qwen Code', 'qwen', [], [], 'qwen', 'stdin-after-start', '--resume {id}'],
  ['rovo', 'Rovo Dev', 'acli', [], [], 'acli rovodev run', 'stdin-after-start', ''],
  ['hermes', 'Hermes', 'hermes', [], [], 'hermes --tui', 'hermes-query', ''],
  ['devin', 'Devin', 'devin', [], [], 'devin', 'stdin-after-start', '--resume {id}'],
  ['openclaw', 'OpenClaw', 'openclaw', [], [], 'openclaw', 'stdin-after-start', ''],
  ['codebuddy', 'CodeBuddy', 'codebuddy', ['cbc'], [], 'codebuddy', 'argv', '--resume {id}'],
  ['jcode', 'Jcode', 'jcode', [], [], 'jcode', 'stdin-after-start', '--resume {id}']
]

const YOLO: Record<string, string> = {
  claude: '--dangerously-skip-permissions',
  codebuddy: '--dangerously-skip-permissions',
  'claude-agent-teams': '--dangerously-skip-permissions',
  openclaude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  qoder: '--dangerously-skip-permissions',
  'qoder-cn': '--dangerously-skip-permissions',
  gemini: '--yolo',
  antigravity: '--dangerously-skip-permissions',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  kiro: '--trust-all-tools',
  crush: '--yolo',
  autohand: '--unrestricted',
  cline: '--auto-approve true',
  'command-code': '--yolo',
  continue: '--allow "*"',
  cursor: '--yolo',
  kimi: '--yolo',
  muse: '--yolo',
  zcode: '--mode yolo',
  'mistral-vibe': '--agent auto-approve',
  'qwen-code': '--approval-mode yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  copilot: '--yolo',
  grok: '--permission-mode bypassPermissions',
  devin: '--permission-mode bypass --respect-workspace-trust false',
  ante: '--yolo',
  trae: '--yolo',
  droid: '--auto high'
}

const entries = (): AgentEntry[] =>
  manifest.contributes.agent.map(({ id, ...data }) => {
    const result = validateEntry('quirky.agents', id, data)
    if (!result.ok) throw new Error(`${id}: ${result.error}`)
    return result.entry
  })

const byId = (id: string) => entries().find((entry) => entry.id === id)!

describe('quirky.agents manifest', () => {
  test('declares the plugin with startup activation, no dependencies and its agent, method, event and setting contributions', () => {
    expect(manifest).toMatchObject({
      id: 'quirky.agents',
      name: 'Agents',
      version: '0.1.0',
      main: 'main.ts',
      activation: 'startup',
      dependencies: []
    })
    expect(Object.keys(manifest.contributes)).toEqual(expect.arrayContaining(['agent', 'event', 'method', 'setting']))
  })

  test('SC-1: all 45 entries validate and appear in Orca\'s auto-pick order', () => {
    const parsed = entries()
    expect(parsed).toHaveLength(45)
    expect(parsed.map((entry) => entry.id)).toEqual([...AUTO_PICK_ORDER])
    expect(TABLE.map((row) => row[0])).toEqual([...AUTO_PICK_ORDER])
  })

  test('each entry\'s label, detect, aliases, requirements, launch and prompt match providers.md', () => {
    const parsed = entries()
    for (const [id, label, detect, aliases, requires, launch, prompt] of TABLE) {
      const entry = parsed.find((candidate) => candidate.id === id)!
      expect({ id, label: entry.label, detect: entry.detect, aliases: entry.detectAliases, requires: entry.detectRequires, launch: entry.launch, prompt: entry.prompt as string }).toEqual({
        id,
        label,
        detect,
        aliases,
        requires,
        launch,
        prompt
      })
    }
  })

  test('only claude, codex, grok and pi can fork', () => {
    const forks = Object.fromEntries(entries().filter((entry) => entry.fork).map((entry) => [entry.id, entry.fork!.join(' ')]))
    expect(forks).toEqual({
      claude: '--resume {id} --fork-session',
      codex: 'fork {id}',
      grok: '--resume {id} --fork-session',
      pi: '--fork {transcript}'
    })
  })

  test('yolo text, auto text and yolo environment match Orca\'s permission tables', () => {
    const parsed = entries()
    expect(Object.fromEntries(parsed.filter((entry) => entry.yolo).map((entry) => [entry.id, entry.yolo]))).toEqual(YOLO)
    expect(Object.fromEntries(parsed.filter((entry) => entry.auto).map((entry) => [entry.id, entry.auto]))).toEqual({
      claude: '--permission-mode auto',
      'claude-agent-teams': '--permission-mode auto',
      codex: '--approve-for-me'
    })
    expect(Object.fromEntries(parsed.filter((entry) => entry.yoloEnv).map((entry) => [entry.id, entry.yoloEnv]))).toEqual({
      goose: { GOOSE_MODE: 'auto' }
    })
  })

  test('D29: claude-agent-teams runs claude in-process with the agent teams environment', () => {
    expect(byId('claude-agent-teams')).toMatchObject({
      detect: 'claude',
      detectAliases: [],
      detectRequires: [],
      launch: 'claude --teammate-mode in-process',
      process: 'claude',
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      prompt: 'stdin-after-start',
      yolo: '--dangerously-skip-permissions',
      auto: '--permission-mode auto',
      trust: 'claude',
      resume: null,
      fork: null
    })
  })

  test('expected process, separator, draft flag, strip arguments and splice style', () => {
    const parsed = entries()
    expect(parsed.filter((entry) => entry.process !== entry.detect).map((entry) => [entry.id, entry.process])).toEqual([
      ['dsh', 'dsh'],
      ['zcode', 'zcode-cli']
    ])
    expect(parsed.filter((entry) => entry.promptSeparator).map((entry) => entry.id)).toEqual(['grok', 'trae', 'prime-agent'])
    expect(parsed.filter((entry) => entry.draftFlag).map((entry) => [entry.id, entry.draftFlag])).toEqual([
      ['claude', '--prefill'],
      ['openclaude', '--prefill']
    ])
    expect(parsed.filter((entry) => entry.stripArgs.length).map((entry) => [entry.id, entry.stripArgs])).toEqual([
      ['opencode', ['--dangerously-skip-permissions']],
      ['kilo', ['--dangerously-skip-permissions']]
    ])
    expect(parsed.filter((entry) => entry.resumeStyle).map((entry) => entry.id)).toEqual(['claude'])
  })

  test('ready signals, timeouts and Enter timing match Orca', () => {
    const parsed = entries()
    const signals = parsed.filter((entry) => entry.readySignal !== 'render-quiet-after-bracketed-paste')
    expect(signals.map((entry) => [entry.id, entry.readySignal])).toEqual([
      ['codex', 'codex-composer-prompt'],
      ['grok', 'grok-composer-prompt'],
      ['opencode2', 'render-cursor-after-bracketed-paste'],
      ['opencode', 'render-cursor-after-bracketed-paste'],
      ['mimo-code', 'render-cursor-after-bracketed-paste'],
      ['dsh', 'dsh-composer-prompt'],
      ['zcode', 'zcode-composer-prompt']
    ])
    expect(parsed.filter((entry) => entry.submitSignal !== entry.readySignal).map((entry) => [entry.id, entry.submitSignal])).toEqual([
      ['opencode2', 'opencode-agent-row'],
      ['opencode', 'opencode-agent-row']
    ])
    expect(parsed.filter((entry) => entry.readyTimeoutMs !== 8000).map((entry) => [entry.id, entry.readyTimeoutMs])).toEqual([
      ['codex', 20000],
      ['opencode2', 20000],
      ['opencode', 20000]
    ])
    expect(parsed.filter((entry) => !entry.blindPaste).map((entry) => entry.id)).toEqual(['codex'])
    expect(parsed.filter((entry) => entry.enterWithPaste).map((entry) => entry.id)).toEqual(['omp'])
    expect(parsed.filter((entry) => entry.submitRetryMs).map((entry) => [entry.id, entry.submitRetryMs])).toEqual([
      ['codex', 1200],
      ['qwen-code', 1200]
    ])
    expect(parsed.filter((entry) => entry.lineSettleMs).map((entry) => [entry.id, entry.lineSettleMs])).toEqual([['antigravity', 45]])
  })

  test('trust presets match Orca\'s preflight trust', () => {
    expect(Object.fromEntries(entries().filter((entry) => entry.trust).map((entry) => [entry.id, entry.trust]))).toEqual({
      claude: 'claude',
      'claude-agent-teams': 'claude',
      codex: 'codex',
      copilot: 'copilot',
      qoder: 'qoder',
      'qoder-cn': 'qoder-cn',
      antigravity: 'antigravity',
      cursor: 'cursor'
    })
  })

  test('every entry has a homepage link and Orca\'s Windows-only fields stay out of the typed entry', () => {
    for (const entry of entries()) expect(entry.homepage).toMatch(/^https:\/\//)
    const windows = Object.fromEntries(manifest.contributes.agent.filter((entry) => entry.windows).map((entry) => [entry.id, entry.windows]))
    expect(windows).toEqual({
      codex: { inputRecordPasteNewline: 'alt-enter' },
      grok: { ctrlEnterEncoding: 'csi-u' },
      pi: { shiftEnterEncoding: 'csi-u' },
      omp: { shiftEnterEncoding: 'csi-u' },
      'prime-agent': { shiftEnterEncoding: 'csi-u' },
      droid: { shiftEnterEncoding: 'csi-u', ctrlEnterEncoding: 'csi-u' }
    })
  })

  test('omits fields equal to their defaults', () => {
    const defaults: Record<string, unknown> = { readySignal: 'render-quiet-after-bracketed-paste', readyTimeoutMs: 8000, blindPaste: true }
    for (const raw of manifest.contributes.agent) {
      for (const [field, value] of Object.entries(defaults)) expect(raw[field] === value).toBe(false)
      if (raw.launch !== undefined) expect(raw.launch).not.toBe(raw.detect)
      if (raw.process !== undefined && raw.id !== 'claude-agent-teams') expect(raw.process).not.toBe(raw.detect)
    }
  })

  test('declares the default-agent and workspace-trust settings', () => {
    expect(manifest.contributes.setting).toMatchObject([
      { id: 'default-agent', type: 'string', default: 'auto', title: 'Default agent' },
      { id: 'workspace-trust', type: 'boolean', default: true, title: 'Trust the folder when Quirky starts an agent' }
    ])
    expect(String(manifest.contributes.setting[0]!.description).length).toBeGreaterThan(0)
  })

  test('buildCatalog accepts the manifest as the kernel would hand it over', () => {
    const contributions: ContributionInfo[] = manifest.contributes.agent.map(({ id, ...data }) => ({
      id: `agent:quirky.agents/${id}`,
      kind: 'agent',
      name: id,
      plugin: 'quirky.agents',
      override: false,
      status: 'effective',
      data
    }))
    const catalog = buildCatalog([...contributions].reverse())
    expect(catalog.problems).toEqual([])
    expect(catalog.agents.map((entry) => entry.id)).toEqual([...AUTO_PICK_ORDER])
  })
})

type RawChoice = { value: string; label: string }
type RawOption = { id: string; label: string; type: string; choices?: RawChoice[]; flag?: string[]; conflicts?: unknown[]; composed?: true; structured?: string }
type RawModel = { id: string; label: string; description?: string; options: { id: string; choices?: string[] }[] }
type RawBlock = {
  model: { flag: string[]; conflicts: unknown[]; structured?: string }
  options?: RawOption[]
  models?: RawModel[]
  unlisted?: 'accept' | 'refuse'
  unlistedOptions?: { id: string; choices?: string[] }[]
  composeModel?: string
  valueFlags?: string[]
  extraArgs?: { allowed: { kind: string; flags: string[]; valuePrefix?: string }[]; placeholder: string }
}

const rawBlock = (id: string): RawBlock => {
  const block = manifest.contributes.agent.find((entry) => entry.id === id)!.launchOptions as RawBlock | undefined
  if (!block) throw new Error(`${id} has no launchOptions`)
  return block
}

const LAUNCH_AGENTS = ['claude', 'codex', 'codebuddy', 'gemini', 'cursor', 'grok', 'muse', 'antigravity', 'omp', 'opencode']

// The values a model offers for an option: the declared choices narrowed by the model's subset.
const choiceValues = (block: RawBlock, use: { id: string; choices?: string[] }): string[] | boolean => {
  const decl = block.options!.find((option) => option.id === use.id)!
  if (decl.type === 'boolean') return true
  const declared = decl.choices!.map((choice) => choice.value)
  if (!use.choices) return declared
  expect(use.choices.every((value) => declared.includes(value))).toBe(true)
  expect(use.choices).toEqual(declared.filter((value) => use.choices!.includes(value)))
  return use.choices
}

const modelsOf = (id: string) => {
  const block = rawBlock(id)
  return (block.models ?? []).map((model) => ({
    id: model.id,
    label: model.label,
    description: model.description ?? null,
    options: Object.fromEntries(model.options.map((use) => [use.id, choiceValues(block, use)]))
  }))
}

const effectiveUnlisted = (block: RawBlock) => block.unlisted ?? ((block.models ?? []).length === 0 ? 'accept' : 'refuse')

const choiceList = (...pairs: [string, string][]): RawChoice[] => pairs.map(([value, label]) => ({ value, label }))

const CLAUDE_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORT = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CLAUDE_VALUE_FLAGS = [
  '--add-dir', '--agent', '--agents', '--allowedTools', '--allowed-tools', '--append-system-prompt', '--append-system-prompt-file',
  '--autocompact', '--betas', '--debug-file', '--disallowedTools', '--disallowed-tools', '--effort', '--environment', '--fallback-model',
  '--file', '--input-format', '--json-schema', '--max-budget-usd', '--mcp-config', '--model', '-n', '--name', '--output-format',
  '--permission-mode', '--permission-prompts', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix', '--session-id',
  '--setting-sources', '--settings', '--system-prompt', '--system-prompt-file', '--system-prompt-snapshot', '--tools'
]
const CURSOR_VALUE_FLAGS = [
  '--api-key', '-H', '--header', '-e', '--endpoint', '--output-format', '--mode', '--model', '--sandbox', '--workspace', '--add-dir',
  '--plugin-dir', '--worktree-base'
]

describe('quirky.agents launchOptions data', () => {
  test('only the ten catalogued agents carry a launchOptions block', () => {
    const withBlock = manifest.contributes.agent.filter((entry) => entry.launchOptions !== undefined).map((entry) => entry.id)
    expect([...withBlock].sort()).toEqual([...LAUNCH_AGENTS].sort())
    const others = manifest.contributes.agent.filter((entry) => !LAUNCH_AGENTS.includes(entry.id))
    expect(others).toHaveLength(35)
    for (const entry of others) expect(entry.launchOptions).toBeUndefined()
  })

  test('SC-1: claude offers Fable, Opus, Sonnet with five effort levels and Haiku with none', () => {
    const block = rawBlock('claude')
    expect(block.model).toEqual({ flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }], structured: 'model' })
    expect(block.options).toEqual([
      {
        id: 'effort',
        label: 'Effort',
        type: 'select',
        choices: choiceList(['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']),
        flag: ['--effort', '{value}'],
        conflicts: [{ flags: ['--effort'] }],
        structured: 'effort'
      }
    ])
    expect(modelsOf('claude')).toEqual([
      { id: 'fable', label: 'Fable', description: 'Most capable for the hardest, longest-running tasks', options: { effort: CLAUDE_EFFORT } },
      { id: 'opus', label: 'Opus', description: 'Best for everyday, complex tasks', options: { effort: CLAUDE_EFFORT } },
      { id: 'sonnet', label: 'Sonnet', description: 'Efficient for routine tasks', options: { effort: CLAUDE_EFFORT } },
      { id: 'haiku', label: 'Haiku', description: 'Fastest for quick answers', options: {} }
    ])
    expect(block.models!.find((model) => model.id === 'haiku')!.options).toEqual([])
    expect(block.unlisted).toBe('accept')
    expect(block.unlistedOptions).toEqual([{ id: 'effort' }])
    expect(block.composeModel).toBeUndefined()
    expect(block.valueFlags).toEqual(CLAUDE_VALUE_FLAGS)
  })

  test('SC-2: codex caps each model\'s reasoning effort at its ceiling and accepts unlisted models', () => {
    const block = rawBlock('codex')
    expect(block.model).toEqual({
      flag: ['-m', '{value}'],
      conflicts: [{ flags: ['-m', '--model'] }, { flags: ['-c', '--config'], valuePrefix: 'model=' }]
    })
    expect(block.options).toEqual([
      {
        id: 'effort',
        label: 'Reasoning effort',
        type: 'select',
        choices: choiceList(
          ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'], ['ultra', 'Ultra']
        ),
        flag: ['-c', 'model_reasoning_effort={value}'],
        conflicts: [{ flags: ['--reasoning-effort'] }, { flags: ['-c', '--config'], valuePrefix: 'model_reasoning_effort=' }]
      }
    ])
    const upTo = (ceiling: string) => CODEX_EFFORT.slice(0, CODEX_EFFORT.indexOf(ceiling) + 1)
    expect(modelsOf('codex')).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: null, options: { effort: upTo('ultra') } },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: null, options: { effort: upTo('ultra') } },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: null, options: { effort: upTo('max') } },
      { id: 'gpt-5.5', label: 'GPT-5.5', description: null, options: { effort: upTo('xhigh') } },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: null, options: { effort: upTo('xhigh') } }
    ])
    expect(block.unlisted).toBe('accept')
    expect(block.unlistedOptions).toEqual([{ id: 'effort' }])
    expect(block.model.structured).toBeUndefined()
    expect(block.valueFlags).toBeUndefined()
  })

  test('SC-3: codebuddy, gemini, cursor, grok, muse, antigravity, omp and opencode carry Orca\'s models and options', () => {
    const codebuddy = rawBlock('codebuddy')
    expect(codebuddy.model).toEqual({ flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }] })
    expect(codebuddy.options).toEqual([
      {
        id: 'effort',
        label: 'Reasoning effort',
        type: 'select',
        choices: choiceList(['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']),
        flag: ['--effort', '{value}'],
        conflicts: [{ flags: ['--effort'] }]
      }
    ])
    const codebuddyEffort = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    expect(modelsOf('codebuddy')).toEqual([
      { id: 'default-model', label: 'Default', description: null, options: { effort: codebuddyEffort } },
      { id: 'fast-model', label: 'Fast', description: null, options: { effort: codebuddyEffort } },
      { id: 'balanced-model', label: 'Balanced', description: null, options: { effort: codebuddyEffort } },
      { id: 'primary-model', label: 'Primary', description: null, options: { effort: codebuddyEffort } },
      { id: 'deep-model', label: 'Deep', description: null, options: { effort: codebuddyEffort } }
    ])
    expect(codebuddy.unlisted).toBe('accept')
    expect(codebuddy.unlistedOptions).toEqual([{ id: 'effort' }])

    const gemini = rawBlock('gemini')
    expect(gemini.model).toEqual({ flag: ['-m', '{value}'], conflicts: [{ flags: ['-m', '--model'] }] })
    expect(gemini.options ?? []).toEqual([])
    expect(modelsOf('gemini')).toEqual([
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: null, options: {} },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', description: null, options: {} },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: null, options: {} },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: null, options: {} }
    ])
    expect(effectiveUnlisted(gemini)).toBe('refuse')
    expect(gemini.unlistedOptions).toBeUndefined()

    const cursor = rawBlock('cursor')
    expect(cursor.model).toEqual({ flag: ['--model', '{value}'], conflicts: [{ flags: ['-m', '--model'] }] })
    expect(cursor.composeModel).toBe('cursor')
    expect(cursor.options).toEqual([
      { id: 'effort', label: 'Effort', type: 'select', choices: choiceList(['low', 'Low'], ['medium', 'Medium'], ['high', 'High']), composed: true },
      { id: 'fastMode', label: 'Fast mode', type: 'boolean', composed: true },
      { id: 'thinking', label: 'Thinking', type: 'boolean', composed: true }
    ])
    expect(modelsOf('cursor')).toEqual([
      { id: 'auto', label: 'Auto', description: null, options: {} },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: null, options: { effort: ['low', 'medium', 'high'], fastMode: true } },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: null, options: { thinking: true, effort: ['low', 'medium', 'high'] } }
    ])
    expect(rawBlock('cursor').models!.map((model) => model.options.map((use) => use.id))).toEqual([[], ['effort', 'fastMode'], ['thinking', 'effort']])
    expect(effectiveUnlisted(cursor)).toBe('refuse')
    expect(cursor.valueFlags).toEqual(CURSOR_VALUE_FLAGS)

    const grok = rawBlock('grok')
    expect(grok.model).toEqual({ flag: ['-m', '{value}'], conflicts: [{ flags: ['-m', '--model'] }] })
    expect(grok.options).toEqual([
      {
        id: 'effort',
        label: 'Reasoning effort',
        type: 'select',
        choices: choiceList(['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']),
        flag: ['--reasoning-effort', '{value}'],
        conflicts: [{ flags: ['--effort', '--reasoning-effort'] }]
      }
    ])
    expect(modelsOf('grok')).toEqual([
      { id: 'grok-4.7', label: 'Grok 4.7', description: "xAI's latest frontier model", options: { effort: ['low', 'medium', 'high', 'xhigh'] } },
      { id: 'grok-4.6', label: 'Grok 4.6', description: "xAI's previous frontier model", options: { effort: ['low', 'medium', 'high', 'xhigh'] } },
      { id: 'grok-4.5', label: 'Grok 4.5', description: 'An earlier xAI frontier model', options: { effort: ['low', 'medium', 'high'] } }
    ])
    expect(grok.unlisted).toBe('accept')
    expect(grok.unlistedOptions).toEqual([{ id: 'effort' }])

    const muse = rawBlock('muse')
    expect(muse.model).toEqual({ flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }] })
    expect(muse.options).toEqual([
      {
        id: 'effort',
        label: 'Reasoning effort',
        type: 'select',
        choices: choiceList(
          ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'], ['ultra', 'Ultra']
        ),
        flag: ['--reasoning-effort', '{value}'],
        conflicts: [{ flags: ['--reasoning-effort'] }]
      }
    ])
    expect(modelsOf('muse')).toEqual([])
    expect(effectiveUnlisted(muse)).toBe('accept')
    expect(muse.unlistedOptions).toEqual([{ id: 'effort' }])

    const antigravity = rawBlock('antigravity')
    expect(antigravity.model).toEqual({ flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }] })
    expect(antigravity.options).toEqual([
      {
        id: 'effort',
        label: 'Reasoning effort',
        type: 'select',
        choices: choiceList(['low', 'Low'], ['medium', 'Medium'], ['high', 'High']),
        flag: ['--effort', '{value}'],
        conflicts: [{ flags: ['--effort'] }]
      }
    ])
    expect(modelsOf('antigravity')).toEqual([])
    expect(effectiveUnlisted(antigravity)).toBe('accept')
    expect(antigravity.unlistedOptions).toEqual([{ id: 'effort' }])

    const omp = rawBlock('omp')
    expect(omp.model).toEqual({ flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }] })
    expect(omp.options ?? []).toEqual([])
    expect(modelsOf('omp')).toEqual([])
    expect(effectiveUnlisted(omp)).toBe('accept')
    expect(omp.unlistedOptions).toBeUndefined()

    const opencode = rawBlock('opencode')
    expect(opencode.model).toEqual({ flag: ['--model', '{value}'], conflicts: [{ flags: ['-m', '--model'] }] })
    expect(opencode.options ?? []).toEqual([])
    expect(modelsOf('opencode')).toEqual([])
    expect(effectiveUnlisted(opencode)).toBe('accept')
    expect(opencode.unlistedOptions).toBeUndefined()
  })

  test('structured keys exist only on claude\'s model and effort, and composition only on cursor', () => {
    for (const id of LAUNCH_AGENTS) {
      const block = rawBlock(id)
      const keys = [block.model.structured, ...(block.options ?? []).map((option) => option.structured)].filter((key) => key !== undefined)
      expect({ id, keys }).toEqual({ id, keys: id === 'claude' ? ['model', 'effort'] : [] })
      expect({ id, composeModel: block.composeModel }).toEqual({ id, composeModel: id === 'cursor' ? 'cursor' : undefined })
      expect({ id, composed: (block.options ?? []).filter((option) => option.composed).length }).toEqual({ id, composed: id === 'cursor' ? 3 : 0 })
      expect({ id, valueFlags: block.valueFlags !== undefined }).toEqual({ id, valueFlags: id === 'claude' || id === 'cursor' })
    }
  })

  test('every flagged option and the model flag carry exactly one {value} item', () => {
    for (const id of LAUNCH_AGENTS) {
      const block = rawBlock(id)
      const templates = [block.model.flag, ...(block.options ?? []).flatMap((option) => (option.flag ? [option.flag] : []))]
      for (const template of templates) expect({ id, count: template.filter((item) => item.includes('{value}')).length }).toEqual({ id, count: 1 })
    }
  })

  test('SC-4: extra-argument allowlists and placeholders match Orca for claude, codex, codebuddy, cursor, grok and omp', () => {
    const extras = Object.fromEntries(LAUNCH_AGENTS.map((id) => [id, rawBlock(id).extraArgs]).filter(([, value]) => value !== undefined))
    expect(extras).toEqual({
      claude: {
        allowed: [
          { kind: 'model', flags: ['--model'] },
          { kind: 'effort', flags: ['--effort'] },
          { kind: 'repeatable', flags: ['--add-dir'] }
        ],
        placeholder: '--model opus --effort high --add-dir docs'
      },
      codex: {
        allowed: [
          { kind: 'model', flags: ['-m', '--model'] },
          { kind: 'effort', flags: ['-c', '--config'], valuePrefix: 'model_reasoning_effort=' }
        ],
        placeholder: '-m model-id -c model_reasoning_effort=high'
      },
      codebuddy: {
        allowed: [
          { kind: 'model', flags: ['--model'] },
          { kind: 'effort', flags: ['--effort'] }
        ],
        placeholder: '--model model-id --effort high'
      },
      cursor: { allowed: [{ kind: 'model', flags: ['-m', '--model'] }], placeholder: '-m model-id' },
      grok: {
        allowed: [
          { kind: 'model', flags: ['-m', '--model'] },
          { kind: 'effort', flags: ['--effort', '--reasoning-effort'] }
        ],
        placeholder: '-m model-id --effort high'
      },
      omp: { allowed: [{ kind: 'model', flags: ['--model'] }], placeholder: '--model model-id' }
    })
  })
})

describe('quirky.agents as a built-in plugin', () => {
  let h: Harness

  afterEach(async () => {
    await h?.cleanup()
    removeTempDirs()
  })

  test('activates cleanly and the kernel reports 45 effective agent contributions', async () => {
    const builtins = makeTempDir('qag-')
    symlinkSync(PLUGIN_DIR, join(builtins, 'quirky.agents'))
    h = await startHarness({ home: makeTempHome('qag-h-'), builtinPluginsDir: builtins })
    const client = await h.connect('cli')

    const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
    const info = plugins.find((plugin) => plugin.id === 'quirky.agents')!
    expect(info).toMatchObject({ source: 'builtin', state: 'active', activation: 'startup', dependencies: [] })
    expect(info.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])

    const contributions = (await client.call('plugin.contributions', { kind: 'agent' })) as ContributionInfo[]
    expect(contributions).toHaveLength(45)
    const catalog = buildCatalog(contributions)
    expect(catalog.problems).toEqual([])
    expect(catalog.agents.map((entry) => entry.id)).toEqual([...AUTO_PICK_ORDER])
  })
})
