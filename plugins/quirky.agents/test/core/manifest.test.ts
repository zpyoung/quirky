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
  test('declares the plugin with startup activation, no dependencies and only agent and setting contributions', () => {
    expect(manifest).toMatchObject({
      id: 'quirky.agents',
      name: 'Agents',
      version: '0.1.0',
      main: 'main.ts',
      activation: 'startup',
      dependencies: []
    })
    expect(Object.keys(manifest.contributes).sort()).toEqual(['agent', 'setting'])
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

  test('25 agents resume, with the argv after the command as providers.md lists it', () => {
    const parsed = entries()
    for (const [id, , , , , , , resume] of TABLE) {
      expect({ id, resume: parsed.find((entry) => entry.id === id)!.resume?.join(' ') ?? '' }).toEqual({ id, resume })
    }
    expect(parsed.filter((entry) => entry.resume)).toHaveLength(25)
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
