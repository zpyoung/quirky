import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateEntry } from '../src/core/entry'
import { buildOneShotCommand, extractEnvAssignments, OneShotError, planCustomCommand, shouldRetryWithoutStrictMcp } from '../src/core/one-shot'
import { decodeOutput, excerptFailureOutput, failureMessage, parseOpenCodeOutput, sanitizeFailureDetail, stripAnsi } from '../src/core/one-shot-output'
import type { AgentEntry } from '../src/core/types'

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../quirky-plugin.json'), 'utf8')) as {
  contributes: { agent: ({ id: string } & Record<string, unknown>)[] }
}

const PROMPT = 'Write a commit message.\nSecond line with "quotes" and $HOME.'

function manifestEntry(id: string): AgentEntry {
  const data = manifest.contributes.agent.find((candidate) => candidate.id === id)
  if (!data) throw new Error(`no agent ${id}`)
  const { id: _id, ...rest } = data
  const result = validateEntry('quirky.agents', id, rest)
  if (!result.ok) throw new Error(result.error)
  return result.entry
}

const minimal = { label: 'Acme', detect: 'acme', prompt: 'argv' }

function entryWith(oneShot: unknown) {
  return validateEntry('acme.agents', 'acme', { ...minimal, oneShot })
}

function entryError(oneShot: unknown): string {
  const result = entryWith(oneShot)
  if (result.ok) throw new Error('expected the entry to be invalid')
  return result.error
}

function build(id: string, input: { userArgs?: string; prompt?: string; model?: string; thinking?: string | null; strictMcp?: boolean } = {}) {
  return buildOneShotCommand(manifestEntry(id), { prompt: PROMPT, ...input })
}

const SETTINGS = '{"disableAllHooks":true}'

// Each row is Orca's buildArgs for the agent's default model and default thinking level
// (O/shared/commit-message-agent-specs-primary.ts, -secondary.ts, commit-message-agent-spec.ts).
const STDIN_AGENTS: [string, string[]][] = [
  ['claude', ['-p', '--output-format', 'text', '--model', 'sonnet', '--permission-mode', 'plan', '--effort', 'low', '--strict-mcp-config', '--settings', SETTINGS]],
  ['codex', ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=low']],
  ['opencode', ['run', '--agent', 'build', '--format', 'json']],
  ['pi', ['--print', '--no-session', '--no-tools', '--no-skills', '--no-context-files', '--mode', 'text']],
  ['amp', ['--execute', '--no-notifications', '--no-ide', '--no-jetbrains', '--mode', 'smart']],
  ['dsh', ['--profile', 'headless', '-']],
  ['omp', ['--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--mode', 'text']]
]

const ARGV_AGENTS: [string, string[]][] = [
  ['cursor', ['--print', '--mode', 'ask', '--trust', '--output-format', 'text', '--model', 'auto', PROMPT]],
  ['kimi', ['--prompt', PROMPT, '--quiet']],
  ['muse', ['exec', '--no-session-log', '--approval-mode', 'never', '--disable-sandbox', '--disable-shell', '--disable-write', '--disable-web-tools', '--', PROMPT]],
  ['copilot', ['--prompt', PROMPT, '--silent', '--stream', 'off', '--no-custom-instructions', '--model', 'gpt-5.4', '--effort', 'low']],
  ['antigravity', [`--print=${PROMPT}`, '--sandbox']],
  ['jcode', ['--no-update', '--quiet', '--no-selfdev', '--tool-profile', 'none', 'run', '--json', PROMPT]]
]

describe('one-shot argv per ported agent', () => {
  test.each(STDIN_AGENTS)('%s gets Orca\'s arguments and the prompt on stdin', (id, argv) => {
    expect(build(id)).toEqual({ argv, stdin: PROMPT })
  })

  test.each(ARGV_AGENTS)('%s gets Orca\'s arguments with the prompt on argv and nothing on stdin', (id, argv) => {
    expect(build(id)).toEqual({ argv, stdin: null })
  })

  test('every agent the plugin ports has a one-shot block, and no other agent does', () => {
    const ported = [...STDIN_AGENTS, ...ARGV_AGENTS].map(([id]) => id).sort()
    const declared = manifest.contributes.agent.filter((entry) => entry.oneShot !== undefined).map((entry) => entry.id).sort()
    expect(declared).toEqual(ported)
  })

  test('only dsh and muse start a different command than they launch interactively', () => {
    for (const [id] of [...STDIN_AGENTS, ...ARGV_AGENTS]) {
      const command = manifestEntry(id).oneShot!.command
      expect(command).toBe(id === 'dsh' ? 'dsh' : id === 'muse' ? 'muse' : null)
    }
  })

  test('opencode reads its JSON event stream, the others plain text', () => {
    for (const [id] of [...STDIN_AGENTS, ...ARGV_AGENTS]) expect(manifestEntry(id).oneShot!.output).toBe(id === 'opencode' ? 'opencode-json' : 'text')
  })

  test('default models and thinking levels are Orca\'s', () => {
    const defaults = Object.fromEntries(
      [...STDIN_AGENTS, ...ARGV_AGENTS].map(([id]) => {
        const spec = manifestEntry(id).oneShot!
        return [id, [spec.defaultModel, spec.models.find((model) => model.id === spec.defaultModel)!.thinking]]
      })
    )
    expect(defaults).toEqual({
      claude: ['sonnet', 'low'],
      codex: ['gpt-5.6-terra', 'low'],
      opencode: ['default', null],
      pi: ['default', null],
      amp: ['smart', null],
      dsh: ['default', null],
      omp: ['default', null],
      cursor: ['auto', null],
      kimi: ['default', null],
      muse: ['default', null],
      copilot: ['gpt-5.4', 'low'],
      antigravity: ['default', null],
      jcode: ['default', null]
    })
  })

  test('a model other than the default fills the template, and its own effort level follows', () => {
    expect(build('opencode', { model: 'opencode/gpt-5.4-mini' }).argv).toEqual(['run', '--model', 'opencode/gpt-5.4-mini', '--agent', 'build', '--format', 'json', '--variant', 'low'])
    expect(build('amp', { model: 'deep' }).argv).toEqual(['--execute', '--no-notifications', '--no-ide', '--no-jetbrains', '--mode', 'deep', '--effort', 'low'])
    expect(build('claude', { model: 'haiku' }).argv).toEqual(['-p', '--output-format', 'text', '--model', 'haiku', '--permission-mode', 'plan', '--strict-mcp-config', '--settings', SETTINGS])
  })

  test('an explicit thinking level replaces the model\'s, and null drops the flag', () => {
    expect(build('claude', { thinking: 'high' }).argv).toContain('high')
    expect(build('claude', { thinking: null }).argv).not.toContain('--effort')
    expect(build('codex', { thinking: 'xhigh' }).argv.slice(-2)).toEqual(['-c', 'model_reasoning_effort=xhigh'])
  })

  test('kimi turns thinking on and off with its own flags', () => {
    expect(build('kimi', { model: 'kimi-code/kimi-for-coding' }).argv).toEqual(['--prompt', PROMPT, '--quiet', '--model', 'kimi-code/kimi-for-coding', '--thinking'])
    expect(build('kimi', { model: 'kimi-code/kimi-for-coding', thinking: 'off' }).argv).toEqual(['--prompt', PROMPT, '--quiet', '--model', 'kimi-code/kimi-for-coding', '--no-thinking'])
  })

  test('a model the spec does not list is refused by name', () => {
    expect(() => build('claude', { model: 'gpt-9' })).toThrow('Model "gpt-9" is not available for Claude.')
  })

  test('an agent without a one-shot block cannot be built', () => {
    const aider = entryWith(undefined)
    if (!aider.ok) throw new Error(aider.error)
    expect(() => buildOneShotCommand(aider.entry, { prompt: 'x' })).toThrow("Acme can't generate text. Pick another agent.")
  })

  test('a NUL in an argv prompt is refused, and is harmless on stdin', () => {
    expect(() => build('cursor', { prompt: 'a\0b' })).toThrow(OneShotError)
    expect(build('claude', { prompt: 'a\0b' }).stdin).toBe('a\0b')
  })
})

describe('user arguments', () => {
  test('a model flag replaces Orca\'s in place, never both', () => {
    expect(build('claude', { userArgs: '--model haiku' }).argv).toEqual([
      '-p', '--output-format', 'text', '--model', 'haiku', '--permission-mode', 'plan', '--effort', 'low', '--strict-mcp-config', '--settings', SETTINGS
    ])
  })

  test('the = form and a single-dash alias count as the same option', () => {
    expect(build('claude', { userArgs: '--model=haiku' }).argv.filter((token) => token.includes('model') || token === 'sonnet')).toEqual(['--model=haiku'])
    const codex = build('codex', { userArgs: '-m gpt-5.5' }).argv
    expect(codex).toContain('-m')
    expect(codex).not.toContain('--model')
    expect(codex).not.toContain('gpt-5.6-terra')
  })

  test('a flag Orca left out for the default model is added, not merged', () => {
    expect(build('opencode', { userArgs: '--model openai/gpt-5.4' }).argv).toEqual(['run', '--agent', 'build', '--format', 'json', '--model', 'openai/gpt-5.4'])
  })

  test('the same singleton typed twice keeps the first', () => {
    const argv = build('claude', { userArgs: '--model haiku --model opus' }).argv
    expect(argv.filter((token) => token === '--model')).toHaveLength(1)
    expect(argv).toContain('haiku')
    expect(argv).not.toContain('opus')
  })

  test('--settings from the user replaces the generated hook switch', () => {
    const argv = build('claude', { userArgs: '--settings /tmp/mine.json' }).argv
    expect(argv.slice(-3)).toEqual(['--strict-mcp-config', '--settings', '/tmp/mine.json'])
    expect(argv).not.toContain(SETTINGS)
  })

  test('effort and repeatable flags: effort replaces, -c stays repeatable', () => {
    expect(build('claude', { userArgs: '--effort high' }).argv).toContain('high')
    expect(build('claude', { userArgs: '--effort high' }).argv).not.toContain('low')
    const codex = build('codex', { userArgs: '-c foo=bar' }).argv
    expect(codex.slice(-4)).toEqual(['-c', 'model_reasoning_effort=low', '-c', 'foo=bar'])
  })

  test('other arguments go before a trailing prompt, else at the end', () => {
    expect(build('cursor', { userArgs: '--force' }).argv.slice(-2)).toEqual(['--force', PROMPT])
    expect(build('claude', { userArgs: '--verbose' }).argv.at(-1)).toBe('--verbose')
    expect(build('kimi', { userArgs: '--debug' }).argv.at(-1)).toBe('--debug')
  })

  test('quotes group words and nothing expands', () => {
    expect(build('claude', { userArgs: `--append-system-prompt "be $HOME brief" 'it''s'` }).argv.slice(-3)).toEqual(['--append-system-prompt', 'be $HOME brief', 'its'])
  })

  test('an unclosed quote is refused', () => {
    expect(() => build('claude', { userArgs: '--model "haiku' })).toThrow('CLI arguments are invalid: unterminated quote')
  })

  test('blank user arguments change nothing', () => {
    expect(build('claude', { userArgs: '   ' })).toEqual(build('claude'))
  })
})

describe('Claude background isolation', () => {
  test('strictMcp false drops --strict-mcp-config and keeps the hook switch', () => {
    const argv = build('claude', { strictMcp: false }).argv
    expect(argv).not.toContain('--strict-mcp-config')
    expect(argv.slice(-2)).toEqual(['--settings', SETTINGS])
  })

  test('other agents ignore strictMcp', () => {
    expect(build('codex', { strictMcp: false })).toEqual(build('codex'))
  })

  const refusal = 'Error: You cannot use --strict-mcp-config when an enterprise MCP config is present'

  test('retries only a claude run that exited non-zero with the enterprise refusal', () => {
    const spec = manifestEntry('claude').oneShot!
    expect(shouldRetryWithoutStrictMcp(spec, { code: 1, stdout: '', stderr: refusal })).toBe(true)
    expect(shouldRetryWithoutStrictMcp(spec, { code: 2, stdout: refusal, stderr: '' })).toBe(true)
    expect(shouldRetryWithoutStrictMcp(spec, { code: 0, stdout: refusal, stderr: '' })).toBe(false)
    expect(shouldRetryWithoutStrictMcp(spec, { code: null, stdout: '', stderr: refusal })).toBe(false)
    expect(shouldRetryWithoutStrictMcp(spec, { code: 1, stdout: '', stderr: 'quota exceeded' })).toBe(false)
    expect(shouldRetryWithoutStrictMcp(manifestEntry('codex').oneShot!, { code: 1, stdout: '', stderr: refusal })).toBe(false)
  })
})

describe('custom command planning', () => {
  test('{prompt} becomes one argument, whatever the prompt holds', () => {
    expect(planCustomCommand('my-gen --fast {prompt}', PROMPT)).toEqual({ binary: 'my-gen', args: ['--fast', PROMPT], stdin: null, env: {} })
    expect(planCustomCommand('my-gen "{prompt}"', PROMPT).args).toEqual([PROMPT])
    expect(planCustomCommand('my-gen --text={prompt}', 'hi there').args).toEqual(['--text=hi there'])
  })

  test('without {prompt} the prompt goes to stdin', () => {
    expect(planCustomCommand('my-gen --fast', PROMPT)).toEqual({ binary: 'my-gen', args: ['--fast'], stdin: PROMPT, env: {} })
  })

  test('leading NAME=value words are environment, not part of the command', () => {
    expect(planCustomCommand('A=1 B="x y" my-gen {prompt}', 'p')).toEqual({ binary: 'my-gen', args: ['p'], stdin: null, env: { A: '1', B: 'x y' } })
  })

  test('shell syntax is never interpreted', () => {
    expect(planCustomCommand('my-gen $(touch x) ; rm y | cat', 'p').args).toEqual(['$(touch', 'x)', ';', 'rm', 'y', '|', 'cat'])
  })

  test('an empty, unclosed or env-only command is refused', () => {
    expect(() => planCustomCommand('   ', 'p')).toThrow('Custom command is empty.')
    expect(() => planCustomCommand('my-gen "x', 'p')).toThrow('Unclosed quote in command template.')
    expect(() => planCustomCommand('A=1', 'p')).toThrow('Custom command must start with a binary name.')
  })

  test('a NUL in a prompt placed on argv is refused', () => {
    expect(() => planCustomCommand('my-gen {prompt}', 'a\0b')).toThrow(OneShotError)
    expect(planCustomCommand('my-gen', 'a\0b').stdin).toBe('a\0b')
  })

  test('env assignments split off any command', () => {
    expect(extractEnvAssignments(['A=1', 'A=2', 'B=', 'run', 'C=3'])).toEqual({ env: { A: '2', B: '' }, rest: ['run', 'C=3'] })
    expect(extractEnvAssignments(['run'])).toEqual({ env: {}, rest: ['run'] })
  })
})

describe('oneShot validation', () => {
  const valid = { args: ['go', '{prompt}'], prompt: 'argv' }

  test('a minimal block gets every default', () => {
    const result = entryWith(valid)
    if (!result.ok) throw new Error(result.error)
    expect(result.entry.oneShot).toEqual({
      args: ['go', '{prompt}'],
      command: null,
      prompt: 'argv',
      output: 'text',
      singletonOptions: [['--model']],
      models: [],
      defaultModel: null,
      background: null
    })
  })

  test('a full block keeps every field, and the first model is the default one', () => {
    const result = entryWith({
      command: 'acme-run',
      args: ['run', '--model', '{model}', { when: 'thinking', args: ['--effort', '{thinking}'] }],
      prompt: 'stdin',
      output: 'opencode-json',
      singletonOptions: [['--model', '-m'], ['--effort']],
      models: [{ id: 'a', label: 'A', thinking: 'low' }, { id: 'b', label: 'B' }],
      background: 'claude'
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.entry.oneShot).toEqual({
      command: 'acme-run',
      args: ['run', '--model', '{model}', { when: 'thinking', args: ['--effort', '{thinking}'] }],
      prompt: 'stdin',
      output: 'opencode-json',
      singletonOptions: [['--model', '-m'], ['--effort']],
      models: [{ id: 'a', label: 'A', thinking: 'low' }, { id: 'b', label: 'B', thinking: null }],
      defaultModel: 'a',
      background: 'claude'
    })
  })

  test('the entry does not share the manifest block', () => {
    const block = { args: ['run'], prompt: 'stdin', singletonOptions: [['--x']] }
    const result = entryWith(block)
    if (!result.ok) throw new Error(result.error)
    result.entry.oneShot!.singletonOptions[0]!.push('--y')
    expect(block.singletonOptions[0]).toEqual(['--x'])
  })

  test('literal braces that are not placeholders pass through', () => {
    const result = entryWith({ args: ['--settings', '{"a":true}'], prompt: 'stdin' })
    expect(result.ok).toBe(true)
  })

  test.each<[string, unknown, string]>([
    ['a non-object block', 'x', 'oneShot must be an object'],
    ['null', null, 'oneShot must be an object'],
    ['an unknown field', { ...valid, extra: 1 }, 'oneShot has an unknown field extra'],
    ['missing args', { prompt: 'stdin' }, 'oneShot.args must be a list'],
    ['empty args', { args: [], prompt: 'stdin' }, 'oneShot.args must not be empty'],
    ['an empty argument', { args: [''], prompt: 'stdin' }, 'oneShot.args[0] must not be empty'],
    ['a non-string argument', { args: [3], prompt: 'stdin' }, 'oneShot.args[0] must be an object'],
    ['a missing prompt mode', { args: ['x'] }, 'oneShot.prompt must be one of: stdin, argv'],
    ['a bad prompt mode', { args: ['x'], prompt: 'file' }, 'oneShot.prompt must be one of: stdin, argv'],
    ['a bad output', { ...valid, output: 'json' }, 'oneShot.output must be one of: text, opencode-json'],
    ['a bad background', { ...valid, background: 'codex' }, 'oneShot.background must be one of: claude'],
    ['an unknown placeholder', { args: ['{nope}', '{prompt}'], prompt: 'argv' }, 'oneShot.args[0] has an unknown placeholder {nope}'],
    ['argv delivery without {prompt}', { args: ['x'], prompt: 'argv' }, 'oneShot.args needs a {prompt} placeholder for argv delivery'],
    ['stdin delivery with {prompt}', { args: ['{prompt}'], prompt: 'stdin' }, 'oneShot.args can only use {prompt} with argv delivery'],
    ['{thinking} outside a group', { args: ['--e={thinking}'], prompt: 'stdin' }, 'oneShot.args[0] uses {thinking} outside a thinking group'],
    ['{thinking} in a model group', { args: [{ when: 'model', args: ['{thinking}'] }], prompt: 'stdin', models: [{ id: 'm', label: 'M' }] }, 'oneShot.args[0].args uses {thinking} outside a thinking group'],
    ['a bad condition', { args: [{ when: 'always', args: ['x'] }], prompt: 'stdin' }, 'oneShot.args[0].when must be model, thinking or thinking=<level>'],
    ['an empty group', { args: [{ when: 'model', args: [] }], prompt: 'stdin' }, 'oneShot.args[0].args must not be empty'],
    ['an unknown group field', { args: [{ when: 'model', args: ['x'], more: 1 }], prompt: 'stdin' }, 'oneShot.args[0] has an unknown field more'],
    ['{model} with no model declared', { args: ['--model', '{model}'], prompt: 'stdin' }, 'oneShot.args uses {model} but no model is declared'],
    ['a duplicate model', { ...valid, models: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, 'oneShot.models[1].id duplicates a'],
    ['a model without a label', { ...valid, models: [{ id: 'a' }] }, 'oneShot.models[0].label must be a non-empty string'],
    ['an unlisted default model', { ...valid, models: [{ id: 'a', label: 'A' }], defaultModel: 'z' }, 'oneShot.defaultModel names z, which is not in models'],
    ['a default model with no models', { ...valid, defaultModel: 'z' }, 'oneShot.defaultModel names z, which is not in models'],
    ['a bad singleton group', { ...valid, singletonOptions: [[]] }, 'oneShot.singletonOptions[0] must not be empty'],
    ['a non-list singleton option', { ...valid, singletonOptions: ['--model'] }, 'oneShot.singletonOptions[0] must be a list'],
    ['an empty command', { ...valid, command: ' ' }, 'oneShot.command must be a non-empty string']
  ])('%s makes the entry invalid', (_name, block, message) => {
    expect(entryError(block)).toBe(message)
  })

  test('every manifest block validates and every error would start with oneShot', () => {
    for (const data of manifest.contributes.agent) {
      if (data.oneShot === undefined) continue
      expect(validateEntry('quirky.agents', data.id, (({ id: _id, ...rest }) => rest)(data)).ok).toBe(true)
    }
  })
})

describe('OpenCode output', () => {
  const event = (value: unknown) => JSON.stringify(value)

  test('joins the text parts with newlines', () => {
    const stdout = [event({ type: 'step_start' }), event({ type: 'text', part: { id: 'a', text: 'Fix crash' } }), event({ type: 'text', part: { id: 'b', text: 'Because it was empty.' } }), event({ type: 'step_finish' })].join('\n')
    expect(parseOpenCodeOutput(stdout)).toEqual({ ok: true, text: 'Fix crash\nBecause it was empty.' })
  })

  test('a later event for the same part replaces it, and a new step starts over', () => {
    const stdout = [
      event({ type: 'text', part: { id: 'a', text: 'draft' } }),
      event({ type: 'text', part: { id: 'a', text: 'Fix crash' } }),
      event({ type: 'step_start' }),
      event({ type: 'text', part: { id: 'z', text: 'Fix the crash' } })
    ].join('\r\n')
    expect(parseOpenCodeOutput(stdout)).toEqual({ ok: true, text: 'Fix the crash' })
  })

  test('parts with no id are each kept, and blank lines are skipped', () => {
    expect(parseOpenCodeOutput(`\n${event({ type: 'text', part: { text: 'a' } })}\n\n${event({ type: 'text', part: { text: 'b' } })}\n`)).toEqual({ ok: true, text: 'a\nb' })
  })

  test('an error event fails with its message, deepest field first', () => {
    expect(parseOpenCodeOutput(event({ type: 'error', error: { name: 'N', message: 'M', data: { message: 'model not found' } } }))).toEqual({ ok: false, error: 'model not found', reported: true })
    expect(parseOpenCodeOutput(event({ type: 'error', error: { name: 'N', message: 'M' } }))).toEqual({ ok: false, error: 'M', reported: true })
    expect(parseOpenCodeOutput(event({ type: 'error', error: { name: 'N' } }))).toEqual({ ok: false, error: 'N', reported: true })
    expect(parseOpenCodeOutput(event({ type: 'error' }))).toEqual({ ok: false, error: 'OpenCode reported an error.', reported: true })
  })

  test('an error after some text still fails the run', () => {
    expect(parseOpenCodeOutput([event({ type: 'text', part: { id: 'a', text: 'hi' } }), event({ type: 'error', error: { message: 'boom' } })].join('\n'))).toEqual({ ok: false, error: 'boom', reported: true })
  })

  test('output that is not an event stream fails without being reported by OpenCode', () => {
    expect(parseOpenCodeOutput('Fix crash')).toEqual({ ok: false, error: 'OpenCode returned invalid JSON events.', reported: false })
    expect(parseOpenCodeOutput('[1]')).toEqual({ ok: false, error: 'OpenCode returned invalid JSON events.', reported: false })
    expect(parseOpenCodeOutput(event({ type: 'text', part: { text: 4 } }))).toEqual({ ok: false, error: 'OpenCode returned invalid JSON events.', reported: false })
    expect(parseOpenCodeOutput(event({ part: {} }))).toEqual({ ok: false, error: 'OpenCode returned invalid JSON events.', reported: false })
  })

  test('decodeOutput leaves text alone and routes opencode-json through the parser', () => {
    expect(decodeOutput('text', ' as is\n')).toEqual({ ok: true, text: ' as is\n' })
    expect(decodeOutput('opencode-json', event({ type: 'text', part: { id: 'a', text: 'Fix crash' } }))).toEqual({ ok: true, text: 'Fix crash' })
  })
})

describe('failure text', () => {
  test('stripAnsi removes colors, cursor moves and titles', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b[2K\u001b]0;title\u0007done')).toBe('red done')
    expect(stripAnsi('plain')).toBe('plain')
  })

  test('a one-line stderr is the detail', () => {
    expect(failureMessage('Claude', { code: 3, stdout: '', stderr: 'quota exceeded\n', output: 'text' })).toBe('Claude failed: quota exceeded')
  })

  test('stdout is the detail only when stderr is blank', () => {
    expect(failureMessage('Codex', { code: 1, stdout: 'bad flag', stderr: '  \n', output: 'text' })).toBe('Codex failed: bad flag')
    expect(failureMessage('Codex', { code: 1, stdout: 'echoed prompt', stderr: 'real error', output: 'text' })).toBe('Codex failed: real error')
  })

  test('no output at all still says the exit code, and a signal says it was stopped', () => {
    expect(failureMessage('Claude', { code: 3, stdout: '', stderr: '', output: 'text' })).toBe('Claude failed with exit code 3.')
    expect(failureMessage('Claude', { code: null, stdout: '', stderr: '', output: 'text' })).toBe('Claude was stopped before it finished.')
  })

  test('OpenCode names an error event over stderr', () => {
    const stdout = JSON.stringify({ type: 'error', error: { message: 'model not found' } })
    expect(failureMessage('OpenCode', { code: 1, stdout, stderr: 'stack trace', output: 'opencode-json' })).toBe('OpenCode failed: model not found')
    expect(failureMessage('OpenCode', { code: 1, stdout: 'not json', stderr: 'stack trace', output: 'opencode-json' })).toBe('OpenCode failed: stack trace')
  })

  test('a long log shows its first lines and its last line', () => {
    const lines = ['first', 'second', 'third', 'fourth', 'last']
    expect(excerptFailureOutput('', lines.join('\n'))).toBe('first second … last')
    expect(excerptFailureOutput('', 'a\nb\nc')).toBe('a b c')
    expect(excerptFailureOutput('', 'x\nx\nx\nx')).toBe('x x')
    expect(excerptFailureOutput('', 'a'.repeat(400))).toBe(`${'a'.repeat(240)}…`)
  })

  test('a log past the scan window is read at both ends only', () => {
    const middle = `${'noise\n'.repeat(5000)}`
    expect(excerptFailureOutput('', `head one\nhead two\n${middle}tail line`)).toBe('head one head two … tail line')
    expect(excerptFailureOutput('', '\n'.repeat(9000))).toBeNull()
  })

  test('sanitizing flattens, redacts paths and caps the length', () => {
    expect(sanitizeFailureDetail('  bad\tinput\u202e here \n')).toBe('bad input here')
    expect(sanitizeFailureDetail('cannot open /Users/zoe/secret/file.txt now')).toBe('cannot open [path] now')
    expect(sanitizeFailureDetail('run /login to continue')).toBe('run /login to continue')
    expect(sanitizeFailureDetail('C:\\Users\\zoe\\x.txt missing')).toBe('[path] missing')
    expect(sanitizeFailureDetail('x'.repeat(300))).toBe(`${'x'.repeat(240)}...`)
    expect(sanitizeFailureDetail('   ')).toBeNull()
    expect(sanitizeFailureDetail(null)).toBeNull()
  })
})
