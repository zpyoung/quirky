import { describe, expect, test } from 'bun:test'
import {
  PermissionError,
  agentPermissionMode,
  applyPermissionMode,
  effectiveArgs,
  effectiveEnv,
  permissionSummary
} from '../../src/core/permissions'
import { EMPTY_CONFIG, type AgentConfig, type AgentEntry } from '../../src/core/types'

function entry(id: string, over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id,
    plugin: 'quirky.agents',
    label: id,
    detect: id,
    detectAliases: [],
    detectRequires: [],
    launch: id,
    process: id,
    env: {},
    prompt: 'argv',
    promptSeparator: null,
    draftFlag: null,
    yolo: null,
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
    ...over
  }
}

const claude = entry('claude', { yolo: '--dangerously-skip-permissions', auto: '--permission-mode auto' })
const teams = entry('claude-agent-teams', { yolo: '--dangerously-skip-permissions', auto: '--permission-mode auto' })
const codex = entry('codex', { yolo: '--dangerously-bypass-approvals-and-sandbox', auto: '--approve-for-me' })
const gemini = entry('gemini', { yolo: '--yolo' })
const goose = entry('goose', { yoloEnv: { GOOSE_MODE: 'auto' } })
const opencode = entry('opencode')
const ALL = [claude, teams, codex, gemini, goose, opencode]

function configs(init: Record<string, Partial<AgentConfig>> = {}): Map<string, AgentConfig> {
  return new Map(Object.entries(init).map(([id, c]) => [id, { ...EMPTY_CONFIG, ...c }]))
}

function cfg(map: Map<string, AgentConfig>, id: string): AgentConfig {
  return map.get(id) ?? EMPTY_CONFIG
}

describe('effective arguments and environment', () => {
  test('an unset override falls back to the Yolo default', () => {
    expect(effectiveArgs(claude, EMPTY_CONFIG)).toBe('--dangerously-skip-permissions')
    expect(effectiveEnv(goose, EMPTY_CONFIG)).toEqual({ GOOSE_MODE: 'auto' })
  })

  test('an empty override is Manual and wins over the default', () => {
    expect(effectiveArgs(claude, { ...EMPTY_CONFIG, args: '' })).toBe('')
    expect(effectiveEnv(goose, { ...EMPTY_CONFIG, env: {} })).toEqual({})
  })

  test('agents with no permission control default to nothing', () => {
    expect(effectiveArgs(opencode, EMPTY_CONFIG)).toBe('')
    expect(effectiveEnv(opencode, EMPTY_CONFIG)).toEqual({})
  })
})

describe('agentPermissionMode', () => {
  test('is null without a control', () => {
    expect(agentPermissionMode(opencode, EMPTY_CONFIG)).toBeNull()
  })

  test('SC-14: untouched arguments mean Yolo', () => {
    expect(agentPermissionMode(claude, EMPTY_CONFIG)).toBe('yolo')
    expect(agentPermissionMode(gemini, EMPTY_CONFIG)).toBe('yolo')
    expect(agentPermissionMode(goose, EMPTY_CONFIG)).toBe('yolo')
  })

  test('empty arguments are Manual, Auto arguments are Auto', () => {
    expect(agentPermissionMode(codex, { ...EMPTY_CONFIG, args: '' })).toBe('manual')
    expect(agentPermissionMode(codex, { ...EMPTY_CONFIG, args: '--approve-for-me' })).toBe('auto')
    expect(agentPermissionMode(claude, { ...EMPTY_CONFIG, args: ' --permission-mode auto ' })).toBe('auto')
  })

  test('any other arguments are custom', () => {
    expect(agentPermissionMode(codex, { ...EMPTY_CONFIG, args: '--ask-for-approval on-request' })).toBe('custom')
    expect(agentPermissionMode(claude, { ...EMPTY_CONFIG, args: '--model sonnet' })).toBe('custom')
  })

  test('an Auto flag on an agent without Auto is custom', () => {
    expect(agentPermissionMode(gemini, { ...EMPTY_CONFIG, args: '--permission-mode auto' })).toBe('custom')
  })

  test('environment agents resolve by their environment', () => {
    expect(agentPermissionMode(goose, { ...EMPTY_CONFIG, env: {} })).toBe('manual')
    expect(agentPermissionMode(goose, { ...EMPTY_CONFIG, env: { GOOSE_MODE: 'auto' } })).toBe('yolo')
    expect(agentPermissionMode(goose, { ...EMPTY_CONFIG, env: { GOOSE_MODE: 'custom' } })).toBe('custom')
    expect(agentPermissionMode(goose, { ...EMPTY_CONFIG, env: { OTHER: '1' } })).toBe('custom')
  })

  test('mixed argument and environment modes are custom', () => {
    const both = entry('both', { yolo: '--yolo', yoloEnv: { MODE: 'yolo' } })
    expect(agentPermissionMode(both, EMPTY_CONFIG)).toBe('yolo')
    expect(agentPermissionMode(both, { ...EMPTY_CONFIG, args: '' })).toBe('custom')
    expect(agentPermissionMode(both, { ...EMPTY_CONFIG, args: '', env: {} })).toBe('manual')
  })
})

describe('permissionSummary', () => {
  test('untouched configs read as Yolo', () => {
    expect(permissionSummary(ALL, configs())).toEqual({ summary: 'yolo', nonAuto: 'yolo' })
  })

  test('an empty profile reads as Manual', () => {
    const all = configs({
      claude: { args: '' },
      'claude-agent-teams': { args: '' },
      codex: { args: '' },
      gemini: { args: '' },
      goose: { env: {} }
    })
    expect(permissionSummary(ALL, all)).toEqual({ summary: 'manual', nonAuto: 'manual' })
  })

  test('custom rows are ignored by the summary', () => {
    const c = configs({ codex: { args: '--model gpt-5' } })
    expect(permissionSummary(ALL, c).summary).toBe('yolo')
  })

  test('rows that differ read as mixed', () => {
    expect(permissionSummary(ALL, configs({ gemini: { args: '' } }))).toEqual({
      summary: 'mixed',
      nonAuto: 'mixed'
    })
  })

  test('Auto when every Auto-capable preset row is Auto, whatever the others use', () => {
    const c = configs({
      claude: { args: '--permission-mode auto' },
      'claude-agent-teams': { args: '--permission-mode auto' },
      codex: { args: '--approve-for-me' }
    })
    expect(permissionSummary(ALL, c)).toEqual({ summary: 'auto', nonAuto: 'yolo' })
  })

  test('Auto holds when an agent without Auto has custom arguments', () => {
    const c = configs({
      claude: { args: '--permission-mode auto' },
      'claude-agent-teams': { args: '--permission-mode auto' },
      codex: { args: '--approve-for-me' },
      gemini: { args: '--model custom' }
    })
    expect(permissionSummary(ALL, c)).toEqual({ summary: 'auto', nonAuto: 'yolo' })
  })

  test('not Auto when every Auto-capable agent has custom arguments', () => {
    const c = configs({
      claude: { args: '--model a' },
      'claude-agent-teams': { args: '--model b' },
      codex: { args: '--model c' },
      gemini: { args: '' },
      goose: { env: {} }
    })
    expect(permissionSummary(ALL, c).summary).toBe('manual')
  })

  test('nonAuto is mixed only when the agents Auto does not cover differ', () => {
    const auto = {
      claude: { args: '--permission-mode auto' },
      'claude-agent-teams': { args: '--permission-mode auto' },
      codex: { args: '--approve-for-me' }
    }
    expect(permissionSummary(ALL, configs(auto)).nonAuto).toBe('yolo')
    expect(permissionSummary(ALL, configs({ ...auto, gemini: { args: '' } })).nonAuto).toBe('mixed')
    expect(permissionSummary(ALL, configs({ ...auto, gemini: { args: '' }, goose: { env: {} } })).nonAuto).toBe('manual')
  })

  test('nonAuto reads mixed when every agent Auto does not cover is custom', () => {
    const c = configs({ gemini: { args: '--custom-flag' }, goose: { env: { GOOSE_MODE: 'custom' } } })
    expect(permissionSummary(ALL, c).nonAuto).toBe('mixed')
  })

  test('no entries with a control reads as Manual', () => {
    expect(permissionSummary([opencode], configs())).toEqual({ summary: 'manual', nonAuto: 'mixed' })
  })
})

describe('applyPermissionMode, bulk', () => {
  test('SC-15: Auto then Manual then Manual again', () => {
    const start = configs({ claude: { args: '--model haiku' } })

    const auto = applyPermissionMode(ALL, start, { mode: 'auto' })
    expect(cfg(auto.configs, 'codex').args).toBe('--approve-for-me')
    expect(cfg(auto.configs, 'claude-agent-teams').args).toBe('--permission-mode auto')
    expect(cfg(auto.configs, 'claude').args).toBe('--model haiku')
    expect(agentPermissionMode(gemini, cfg(auto.configs, 'gemini'))).toBe('yolo')
    expect(auto.changed.sort()).toEqual(['claude-agent-teams', 'codex'])
    expect(permissionSummary(ALL, auto.configs).summary).toBe('auto')

    const manual = applyPermissionMode(ALL, auto.configs, { mode: 'manual' })
    for (const id of ['claude-agent-teams', 'codex', 'gemini']) expect(cfg(manual.configs, id).args).toBe('')
    expect(cfg(manual.configs, 'goose').env).toEqual({})
    expect(cfg(manual.configs, 'claude').args).toBe('--model haiku')
    expect(permissionSummary(ALL, manual.configs).summary).toBe('manual')

    const again = applyPermissionMode(ALL, manual.configs, { mode: 'manual' })
    expect(again.changed).toEqual([])
    expect(again.configs).toEqual(manual.configs)
  })

  test('Yolo stores the flags and the environment', () => {
    const manual = applyPermissionMode(ALL, configs(), { mode: 'manual' })
    const yolo = applyPermissionMode(ALL, manual.configs, { mode: 'yolo' })
    expect(cfg(yolo.configs, 'claude').args).toBe('--dangerously-skip-permissions')
    expect(cfg(yolo.configs, 'gemini').args).toBe('--yolo')
    expect(cfg(yolo.configs, 'goose').env).toEqual({ GOOSE_MODE: 'auto' })
    expect(yolo.changed.sort()).toEqual(['claude', 'claude-agent-teams', 'codex', 'gemini', 'goose'])
    expect(applyPermissionMode(ALL, yolo.configs, { mode: 'yolo' }).changed).toEqual([])
  })

  test('agents with no control are never written', () => {
    const result = applyPermissionMode(ALL, configs(), { mode: 'manual' })
    expect(result.configs.has('opencode')).toBe(false)
    expect(result.changed).not.toContain('opencode')
  })

  test('Auto preserves the Yolo and Manual policy elsewhere, and a later switch restores it', () => {
    for (const mode of ['yolo', 'manual'] as const) {
      const previous = applyPermissionMode(ALL, configs(), { mode })
      const auto = applyPermissionMode(ALL, previous.configs, { mode: 'auto' })
      expect(cfg(auto.configs, 'gemini')).toEqual(cfg(previous.configs, 'gemini'))
      expect(cfg(auto.configs, 'goose')).toEqual(cfg(previous.configs, 'goose'))
      expect(permissionSummary(ALL, auto.configs).summary).toBe('auto')
      expect(applyPermissionMode(ALL, auto.configs, { mode }).configs).toEqual(previous.configs)
    }
  })

  test('recognizes Auto arguments entered by hand for each supporting agent', () => {
    for (const e of [claude, teams, codex]) {
      expect(agentPermissionMode(e, { ...EMPTY_CONFIG, args: e.auto })).toBe('auto')
    }
  })

  test('Manual preserves custom arguments and clears environment presets', () => {
    const start = configs({
      claude: { args: '--dangerously-skip-permissions' },
      codex: { args: '--model gpt-5' },
      goose: { env: { GOOSE_MODE: 'auto' } }
    })
    const result = applyPermissionMode(ALL, start, { mode: 'manual' })
    expect(cfg(result.configs, 'claude').args).toBe('')
    expect(cfg(result.configs, 'codex').args).toBe('--model gpt-5')
    expect(cfg(result.configs, 'goose').env).toEqual({})
  })

  test('a custom environment row is left alone', () => {
    const start = configs({ goose: { env: { GOOSE_MODE: 'custom' } } })
    const result = applyPermissionMode(ALL, start, { mode: 'manual' })
    expect(cfg(result.configs, 'goose').env).toEqual({ GOOSE_MODE: 'custom' })
    expect(result.changed).not.toContain('goose')
  })

  test('does not mutate the configs it was given', () => {
    const start = configs({ claude: { args: '' } })
    applyPermissionMode(ALL, start, { mode: 'yolo' })
    expect(cfg(start, 'claude').args).toBe('')
  })

  test('keeps the other fields of a changed row', () => {
    const start = configs({ gemini: { args: '', command: 'gemini-nightly', disabled: true } })
    const result = applyPermissionMode(ALL, start, { mode: 'yolo' })
    expect(cfg(result.configs, 'gemini')).toEqual({
      disabled: true,
      command: 'gemini-nightly',
      args: '--yolo',
      env: null
    })
  })
})

describe('applyPermissionMode, one agent', () => {
  function message(fn: () => unknown): string {
    try {
      fn()
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionError)
      return (error as Error).message
    }
    throw new Error('did not throw')
  }

  test('SC-16: custom arguments are refused without replaceCustom', () => {
    const start = configs({ claude: { args: '--model haiku' } })
    expect(message(() => applyPermissionMode(ALL, start, { mode: 'yolo', agent: 'claude' }))).toBe(
      'claude has custom arguments; pass --replace-custom to replace them'
    )
  })

  test('SC-16: replaceCustom replaces them', () => {
    const start = configs({ claude: { args: '--model haiku' } })
    const result = applyPermissionMode(ALL, start, { mode: 'yolo', agent: 'claude', replaceCustom: true })
    expect(cfg(result.configs, 'claude').args).toBe('--dangerously-skip-permissions')
    expect(result.changed).toEqual(['claude'])
  })

  test('SC-16: Auto on an agent without Auto is refused', () => {
    expect(message(() => applyPermissionMode(ALL, configs(), { mode: 'auto', agent: 'gemini' }))).toBe(
      'gemini has no Auto mode'
    )
  })

  test('SC-16: an agent with no control is refused for every mode', () => {
    for (const mode of ['manual', 'auto', 'yolo'] as const) {
      expect(message(() => applyPermissionMode(ALL, configs(), { mode, agent: 'opencode' }))).toBe(
        'opencode has no permission modes'
      )
    }
  })

  test('an unknown agent is refused', () => {
    expect(message(() => applyPermissionMode(ALL, configs(), { mode: 'yolo', agent: 'nope' }))).toBe(
      'unknown agent: nope'
    )
  })

  test('only the named agent changes', () => {
    const result = applyPermissionMode(ALL, configs(), { mode: 'manual', agent: 'codex' })
    expect(cfg(result.configs, 'codex').args).toBe('')
    expect(result.configs.has('gemini')).toBe(false)
    expect(result.changed).toEqual(['codex'])
  })

  test('Auto on one Auto-capable agent', () => {
    const result = applyPermissionMode(ALL, configs(), { mode: 'auto', agent: 'codex' })
    expect(cfg(result.configs, 'codex').args).toBe('--approve-for-me')
  })

  test('an environment agent stores its environment', () => {
    const manual = applyPermissionMode(ALL, configs(), { mode: 'manual', agent: 'goose' })
    expect(cfg(manual.configs, 'goose')).toEqual({ ...EMPTY_CONFIG, env: {} })
    const yolo = applyPermissionMode(ALL, manual.configs, { mode: 'yolo', agent: 'goose' })
    expect(cfg(yolo.configs, 'goose').env).toEqual({ GOOSE_MODE: 'auto' })
    expect(cfg(yolo.configs, 'goose').args).toBeNull()
  })

  test('a repeat is a no-op', () => {
    const first = applyPermissionMode(ALL, configs(), { mode: 'manual', agent: 'gemini' })
    const second = applyPermissionMode(ALL, first.configs, { mode: 'manual', agent: 'gemini' })
    expect(second.changed).toEqual([])
  })

  test('Yolo copies the entry environment instead of sharing it', () => {
    const result = applyPermissionMode(ALL, configs(), { mode: 'yolo', agent: 'goose' })
    expect(cfg(result.configs, 'goose').env).not.toBe(goose.yoloEnv)
  })

  test('Muse-style entries switch between Yolo and Manual', () => {
    const muse = entry('muse', { yolo: '--yolo' })
    const manual = applyPermissionMode([muse], configs({ muse: { args: '--yolo' } }), { mode: 'manual', agent: 'muse' })
    expect(cfg(manual.configs, 'muse').args).toBe('')
    const yolo = applyPermissionMode([muse], configs({ muse: { args: '' } }), { mode: 'yolo', agent: 'muse' })
    expect(cfg(yolo.configs, 'muse').args).toBe('--yolo')
  })
})

describe('opencode and kilo', () => {
  test('SC-17: have no permission control, so their saved arguments stay as typed', () => {
    const kilo = entry('kilo', { stripArgs: ['--dangerously-skip-permissions'] })
    const oc = entry('opencode', { stripArgs: ['--dangerously-skip-permissions'] })
    const saved = { args: '--dangerously-skip-permissions --model x' }
    expect(effectiveArgs(oc, { ...EMPTY_CONFIG, ...saved })).toBe(saved.args)
    expect(agentPermissionMode(oc, EMPTY_CONFIG)).toBeNull()
    expect(agentPermissionMode(kilo, EMPTY_CONFIG)).toBeNull()
  })
})
