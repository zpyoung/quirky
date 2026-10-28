import { describe, expect, test } from 'bun:test'
import { PROMPT_MODES, READY_SIGNALS, SUBMIT_SIGNALS, TRUST_PRESETS } from '../../src/core/types'
import { validateEntry } from '../../src/core/entry'

const minimal = { label: 'Acme', detect: 'acme', prompt: 'argv' }

function entryOf(data: Record<string, unknown>) {
  const result = validateEntry('acme.agents', 'acme', data)
  if (!result.ok) throw new Error(result.error)
  return result.entry
}

function errorOf(data: Record<string, unknown>): string {
  const result = validateEntry('acme.agents', 'acme', data)
  if (result.ok) throw new Error('expected the entry to be invalid')
  return result.error
}

describe('validateEntry', () => {
  test('a minimal entry gets every default', () => {
    expect(entryOf(minimal)).toEqual({
      id: 'acme',
      plugin: 'acme.agents',
      label: 'Acme',
      detect: 'acme',
      detectAliases: [],
      detectRequires: [],
      launch: 'acme',
      process: 'acme',
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
      launchOptions: null,
      modelDiscovery: null,
      oneShot: null
    })
  })

  test('a full entry keeps every field', () => {
    const entry = entryOf({
      ...minimal,
      detectAliases: ['acme-dev'],
      detectRequires: ['acme-core'],
      launch: 'acme --tui',
      process: 'acme-cli',
      env: { ACME_MODE: '1' },
      prompt: 'flag-prompt',
      promptSeparator: '--',
      draftFlag: '--prefill',
      yolo: '--yes',
      auto: '--auto',
      yoloEnv: { ACME_YOLO: '1' },
      stripArgs: ['--bad'],
      resume: ['--resume', '{id}'],
      fork: ['--resume', '{id}', '--fork'],
      resumeStyle: 'claude-splice',
      readySignal: 'grok-composer-prompt',
      submitSignal: 'opencode-agent-row',
      readyTimeoutMs: 20000,
      blindPaste: false,
      submitRetryMs: 1200,
      lineSettleMs: 45,
      enterWithPaste: true,
      trust: 'codex',
      homepage: 'https://acme.example/docs',
      install: 'https://acme.example/install',
      windows: { shiftEnterEncoding: 'csi-u' }
    })
    expect(entry).toMatchObject({
      detectAliases: ['acme-dev'],
      detectRequires: ['acme-core'],
      launch: 'acme --tui',
      process: 'acme-cli',
      env: { ACME_MODE: '1' },
      promptSeparator: '--',
      draftFlag: '--prefill',
      yolo: '--yes',
      auto: '--auto',
      yoloEnv: { ACME_YOLO: '1' },
      stripArgs: ['--bad'],
      resume: ['--resume', '{id}'],
      fork: ['--resume', '{id}', '--fork'],
      resumeStyle: 'claude-splice',
      readySignal: 'grok-composer-prompt',
      submitSignal: 'opencode-agent-row',
      readyTimeoutMs: 20000,
      blindPaste: false,
      submitRetryMs: 1200,
      lineSettleMs: 45,
      enterWithPaste: true,
      trust: 'codex',
      homepage: 'https://acme.example/docs',
      install: 'https://acme.example/install'
    })
  })

  test('refuses unbounded or unsupported provider discovery probes', () => {
    const declaration = { args: ['models', '--json'], timeoutMs: 1_000, format: 'json' as const }
    expect(errorOf({ ...minimal, modelDiscovery: { ...declaration, timeoutMs: 0 } })).toBe(
      'modelDiscovery.timeoutMs must be an integer from 1 to 10000'
    )
    expect(errorOf({ ...minimal, modelDiscovery: { ...declaration, format: 'yaml' } })).toBe(
      'modelDiscovery.format must be one of: json'
    )
  })

  test('launch defaults to detect, process defaults to detect, and the submit signal follows the ready signal', () => {
    const entry = entryOf({ ...minimal, detect: 'qwen', readySignal: 'codex-composer-prompt' })
    expect(entry).toMatchObject({ launch: 'qwen', process: 'qwen', submitSignal: 'codex-composer-prompt' })
    expect(entryOf({ ...minimal, launch: 'acme chat' })).toMatchObject({ process: 'acme' })
  })

  test('SC-4: a missing detect command is reported by that text', () => {
    expect(errorOf({ label: 'Broken', prompt: 'argv' })).toBe('detect command is required')
  })

  test('label and prompt are required', () => {
    expect(errorOf({ detect: 'acme', prompt: 'argv' })).toBe('label is required')
    expect(errorOf({ label: 'Acme', detect: 'acme' })).toBe('prompt mode is required')
  })

  test('unknown fields are rejected by name', () => {
    expect(errorOf({ ...minimal, colour: 'red' })).toBe('unknown field colour')
  })

  test('an id inside the data is an unknown field, since the contribution name is the id', () => {
    expect(errorOf({ ...minimal, id: 'other' })).toBe('unknown field id')
  })

  test('enum fields name their allowed values', () => {
    expect(errorOf({ ...minimal, prompt: 'telepathy' })).toBe(`prompt must be one of: ${PROMPT_MODES.join(', ')}`)
    expect(errorOf({ ...minimal, readySignal: 'x' })).toBe(`readySignal must be one of: ${READY_SIGNALS.join(', ')}`)
    expect(errorOf({ ...minimal, submitSignal: 'x' })).toBe(`submitSignal must be one of: ${SUBMIT_SIGNALS.join(', ')}`)
    expect(errorOf({ ...minimal, trust: 'x' })).toBe(`trust must be one of: ${TRUST_PRESETS.join(', ')}`)
    expect(errorOf({ ...minimal, promptSeparator: '-' })).toBe('promptSeparator must be "--"')
    expect(errorOf({ ...minimal, resumeStyle: 'splice' })).toBe('resumeStyle must be "claude-splice"')
  })

  test('every enum value in the exported lists is accepted', () => {
    for (const prompt of PROMPT_MODES) expect(entryOf({ ...minimal, prompt }).prompt).toBe(prompt)
    for (const readySignal of READY_SIGNALS) expect(entryOf({ ...minimal, readySignal }).readySignal).toBe(readySignal)
    for (const submitSignal of SUBMIT_SIGNALS) expect(entryOf({ ...minimal, submitSignal }).submitSignal).toBe(submitSignal)
    for (const trust of TRUST_PRESETS) expect(entryOf({ ...minimal, trust }).trust).toBe(trust)
  })

  test('the ready signal cannot be the opencode agent row', () => {
    expect(errorOf({ ...minimal, readySignal: 'opencode-agent-row' })).toContain('readySignal must be one of')
  })

  test('strings must be non-empty strings', () => {
    expect(errorOf({ ...minimal, label: 3 })).toBe('label must be a non-empty string')
    expect(errorOf({ ...minimal, label: '  ' })).toBe('label must be a non-empty string')
    expect(errorOf({ ...minimal, detect: '' })).toBe('detect must be a non-empty string')
    expect(errorOf({ ...minimal, launch: [] })).toBe('launch must be a non-empty string')
    expect(errorOf({ ...minimal, yolo: false })).toBe('yolo must be a non-empty string')
  })

  test('lists must hold non-empty strings', () => {
    expect(errorOf({ ...minimal, detectAliases: 'x' })).toBe('detectAliases must be a list of non-empty strings')
    expect(errorOf({ ...minimal, detectRequires: ['ok', 2] })).toBe('detectRequires must be a list of non-empty strings')
    expect(errorOf({ ...minimal, stripArgs: [''] })).toBe('stripArgs must be a list of non-empty strings')
  })

  test('environment objects must hold string values', () => {
    expect(errorOf({ ...minimal, env: { A: 1 } })).toBe('env must be an object of strings')
    expect(errorOf({ ...minimal, env: ['A'] })).toBe('env must be an object of strings')
    expect(errorOf({ ...minimal, yoloEnv: null })).toBe('yoloEnv must be an object of strings')
  })

  test('numbers must be positive integers and flags must be booleans', () => {
    for (const field of ['readyTimeoutMs', 'submitRetryMs', 'lineSettleMs']) {
      expect(errorOf({ ...minimal, [field]: 0 })).toBe(`${field} must be a positive integer`)
      expect(errorOf({ ...minimal, [field]: 1.5 })).toBe(`${field} must be a positive integer`)
      expect(errorOf({ ...minimal, [field]: '5' })).toBe(`${field} must be a positive integer`)
    }
    expect(errorOf({ ...minimal, blindPaste: 'no' })).toBe('blindPaste must be a boolean')
    expect(errorOf({ ...minimal, enterWithPaste: 1 })).toBe('enterWithPaste must be a boolean')
  })

  test('resume and fork templates are lists of strings with known placeholders', () => {
    expect(errorOf({ ...minimal, resume: '--resume' })).toBe('resume must be a non-empty list of strings')
    expect(errorOf({ ...minimal, resume: [] })).toBe('resume must be a non-empty list of strings')
    expect(errorOf({ ...minimal, resume: ['--resume', '{session}'] })).toBe('resume has an unknown placeholder {session}')
    expect(errorOf({ ...minimal, resume: ['--resume', '{id}'], fork: ['{nope}'] })).toBe('fork has an unknown placeholder {nope}')
    expect(entryOf({ ...minimal, resume: ['--a={id}', '{transcript}', '{transcriptOrId}'] }).resume).toEqual([
      '--a={id}',
      '{transcript}',
      '{transcriptOrId}'
    ])
  })

  test('fork without resume is invalid', () => {
    expect(errorOf({ ...minimal, fork: ['fork', '{id}'] })).toBe('fork needs resume')
  })

  test('links must be http(s) URLs', () => {
    expect(errorOf({ ...minimal, homepage: 'javascript:alert(1)' })).toBe('homepage must be an http(s) URL')
    expect(errorOf({ ...minimal, install: 'not a url' })).toBe('install must be an http(s) URL')
    expect(errorOf({ ...minimal, homepage: 4 })).toBe('homepage must be an http(s) URL')
  })

  test('windows must be an object', () => {
    expect(errorOf({ ...minimal, windows: 'csi-u' })).toBe('windows must be an object')
    expect(errorOf({ ...minimal, windows: [] })).toBe('windows must be an object')
    expect(entryOf({ ...minimal, windows: {} }).id).toBe('acme')
  })

  test('the returned entry does not share arrays or objects with the input', () => {
    const data = { ...minimal, detectAliases: ['a'], env: { A: '1' } }
    const entry = entryOf(data)
    entry.detectAliases.push('b')
    entry.env.B = '2'
    expect(data.detectAliases).toEqual(['a'])
    expect(data.env).toEqual({ A: '1' })
  })

  test('launchOptions is parsed into a catalog', () => {
    const entry = entryOf({ ...minimal, launchOptions: { model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }] } } })
    expect(entry.launchOptions).toMatchObject({ model: { flag: ['--model', '{value}'] }, models: [], unlisted: 'accept', extraArgs: null })
  })

  test('an invalid launchOptions block makes the entry invalid with a message starting launchOptions', () => {
    expect(errorOf({ ...minimal, launchOptions: 'x' })).toStartWith('launchOptions')
    expect(errorOf({ ...minimal, launchOptions: { model: { flag: ['--model'], conflicts: [] } } })).toStartWith('launchOptions.model.flag')
    expect(errorOf({ ...minimal, launchOptions: null })).toStartWith('launchOptions')
  })
})
