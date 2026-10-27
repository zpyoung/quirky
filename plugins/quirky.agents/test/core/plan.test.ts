import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PlanError, buildLaunchPlan, buildResumePlan } from '../../src/core/plan'
import { SelectionError } from '../../src/core/selection'
import { tokenize } from '../../src/core/shell'
import {
  EMPTY_CONFIG,
  type AgentConfig,
  type AgentEntry,
  type LaunchCatalog,
  type LaunchRecord,
  type ParsedExtras,
  type ValidSelection
} from '../../src/core/types'

function entry(id: string, overrides: Partial<AgentEntry> = {}): AgentEntry {
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
    launchOptions: null,
    oneShot: null,
    ...overrides
  }
}

const CLAUDE = entry('claude', {
  yolo: '--dangerously-skip-permissions',
  draftFlag: '--prefill',
  resume: ['--resume', '{id}'],
  fork: ['--resume', '{id}', '--fork-session'],
  resumeStyle: 'claude-splice'
})
const CODEX = entry('codex', {
  yolo: '--dangerously-bypass-approvals-and-sandbox',
  resume: ['resume', '{id}'],
  fork: ['fork', '{id}']
})
const GROK = entry('grok', {
  yolo: '--permission-mode bypassPermissions',
  promptSeparator: '--',
  resume: ['--resume', '{id}'],
  fork: ['--resume', '{id}', '--fork-session']
})
const GEMINI = entry('gemini', { yolo: '--yolo', prompt: 'flag-prompt-interactive', resume: ['--resume', '{id}'] })
const OPENCODE = entry('opencode', {
  prompt: 'flag-prompt',
  yolo: '--dangerously-skip-permissions',
  stripArgs: ['--dangerously-skip-permissions'],
  resume: ['--session', '{id}']
})
const COPILOT = entry('copilot', { prompt: 'flag-interactive', resume: ['--resume={id}'] })
const GOOSE = entry('goose', { prompt: 'stdin-after-start', yoloEnv: { GOOSE_MODE: 'auto' } })
const AIDER = entry('aider', { prompt: 'stdin-after-start', yolo: '--yes-always' })
const DEVIN = entry('devin', { prompt: 'stdin-after-start', yolo: '--permission-mode bypass --respect-workspace-trust false' })
const HERMES = entry('hermes', { launch: 'hermes --tui', prompt: 'hermes-query' })
const HERMES_RESUMABLE = entry('hermes', { launch: 'hermes --tui', prompt: 'hermes-query', resume: ['--resume', '{id}'] })
const PI = entry('pi', { resume: ['--session', '{transcript}'], fork: ['--fork', '{transcript}'] })
const OMP = entry('omp', { resume: ['--resume', '{transcriptOrId}'] })

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({ ...EMPTY_CONFIG, ...overrides })
const plan = (e: AgentEntry, prompt?: string, overrides: Partial<Parameters<typeof buildLaunchPlan>[0]> = {}) =>
  buildLaunchPlan({ entry: e, config: EMPTY_CONFIG, prompt, ...overrides })
const words = (command: string): string[] => {
  const result = tokenize(command)
  if (!result.ok) throw new Error(result.error)
  return result.tokens
}

const scratch = mkdtempSync('/tmp/qa-plan-')
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Runs a planned command under sh with a fake `name` first on PATH and returns its argv and the startup variable. */
function runFake(name: string, command: string, env: Record<string, string | null>) {
  const dir = mkdtempSync(join(scratch, 'bin-'))
  const bin = join(dir, name)
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a"; done\nprintf "ENV=%s\\0" "${HERMES_QUIRKY_STARTUP_QUERY-unset}"\n')
  chmodSync(bin, 0o755)
  const childEnv: Record<string, string> = { PATH: `${dir}:/usr/bin:/bin` }
  for (const [key, value] of Object.entries(env)) if (value !== null) childEnv[key] = value
  const proc = Bun.spawnSync(['/bin/sh', '-c', `exec ${command}`], { env: childEnv, stdout: 'pipe', stderr: 'pipe' })
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  const lines = proc.stdout.toString().split('\0').slice(0, -1)
  return { argv: lines.slice(0, -1), startupVariable: lines.at(-1)?.slice('ENV='.length) }
}

describe('SC-14: untouched arguments mean Yolo', () => {
  test.each([
    [CLAUDE, 'claude --dangerously-skip-permissions'],
    [CODEX, 'codex --dangerously-bypass-approvals-and-sandbox'],
    [GEMINI, 'gemini --yolo'],
    [AIDER, 'aider --yes-always'],
    [DEVIN, 'devin --permission-mode bypass --respect-workspace-trust false'],
    [GOOSE, 'goose'],
    [entry('opencode'), 'opencode']
  ])('%#: %p starts %p', (e, expected) => {
    expect(plan(e).command).toBe(expected)
  })

  test('goose gets its Yolo environment unless the user saved one', () => {
    expect(plan(GOOSE).env).toEqual({ GOOSE_MODE: 'auto' })
    expect(buildLaunchPlan({ entry: GOOSE, config: config({ env: {} }) }).env).toEqual({})
    expect(buildLaunchPlan({ entry: GOOSE, config: config({ env: { A: '1' } }) }).env).toEqual({ A: '1' })
  })

  test('saved arguments replace the Yolo default, and empty arguments mean Manual', () => {
    expect(buildLaunchPlan({ entry: CLAUDE, config: config({ args: '--model haiku' }) }).command).toBe('claude --model haiku')
    expect(buildLaunchPlan({ entry: CLAUDE, config: config({ args: '' }) }).command).toBe('claude')
  })

  test('no prompt means no delivery and no paste', () => {
    const result = plan(CLAUDE)
    expect(result.promptDelivery).toBeNull()
    expect(result.paste).toBeNull()
    expect(result.agent).toBe('claude')
  })
})

describe('command and environment', () => {
  test('SC-11: a command override replaces the whole command, and clearing it restores the default', () => {
    expect(buildLaunchPlan({ entry: CLAUDE, config: config({ command: 'my-claude' }) }).command).toBe(
      'my-claude --dangerously-skip-permissions'
    )
    expect(buildLaunchPlan({ entry: CLAUDE, config: config({ command: null }) }).command).toBe(
      'claude --dangerously-skip-permissions'
    )
    expect(buildLaunchPlan({ entry: CLAUDE, config: config({ command: '  ' }) }).command).toBe(
      'claude --dangerously-skip-permissions'
    )
  })

  test('a multi-word command override keeps its own arguments before the user arguments', () => {
    expect(buildLaunchPlan({ entry: CLAUDE, config: config({ command: 'mise exec -- claude', args: '--model x' }) }).command).toBe(
      'mise exec -- claude --model x'
    )
  })

  test('SC-12: arguments are tokenized and re-quoted, never run as shell syntax', () => {
    const result = buildLaunchPlan({
      entry: CLAUDE,
      config: config({ args: '--model "haiku 5" $(touch /tmp/pwned) ; rm -rf x' })
    })
    expect(words(result.command)).toEqual([
      'claude',
      '--model',
      'haiku 5',
      '$(touch',
      '/tmp/pwned)',
      ';',
      'rm',
      '-rf',
      'x'
    ])
    expect(result.command).not.toContain('--dangerously-skip-permissions')
  })

  test('SC-12: unbalanced quotes in arguments fail with the logic spec message', () => {
    const attempt = () => buildLaunchPlan({ entry: CLAUDE, config: config({ args: '--model "haiku' }) })
    expect(attempt).toThrow(PlanError)
    expect(attempt).toThrow('CLI arguments are invalid: unterminated quote')
  })

  test('an unbalanced command override fails with the logic spec message', () => {
    const attempt = () => buildLaunchPlan({ entry: CLAUDE, config: config({ command: "my-claude 'x" }) })
    expect(attempt).toThrow(PlanError)
    expect(attempt).toThrow('Agent command override is invalid: unterminated quote')
  })

  test('SC-17: opencode never receives the Claude bypass flag', () => {
    expect(
      buildLaunchPlan({ entry: OPENCODE, config: config({ args: '--dangerously-skip-permissions --model x' }) }).command
    ).toBe('opencode --model x')
    expect(plan(OPENCODE).command).toBe('opencode')
  })

  test('hook arguments follow the user arguments, quoted', () => {
    expect(plan(CLAUDE, undefined, { hookArgs: ['--settings', '{"a": 1}'] }).command).toBe(
      `claude --dangerously-skip-permissions --settings '{"a": 1}'`
    )
  })

  test('environment layers apply in order: entry, user, hook, with null removing', () => {
    const tagged = entry('tagged', { env: { A: 'entry', B: 'entry', C: 'entry' } })
    const result = buildLaunchPlan({
      entry: tagged,
      config: config({ env: { B: 'user', C: 'user' } }),
      hookEnv: { C: 'hook', D: null }
    })
    expect(result.env).toEqual({ A: 'entry', B: 'user', C: 'hook', D: null })
  })

  test('the record keeps the unresolved command, the effective arguments and the user environment', () => {
    const result = buildLaunchPlan({
      entry: GOOSE,
      config: config({ command: 'my-goose', args: '--x "y z"' }),
      hookArgs: ['--hook'],
      hookEnv: { H: '1' },
      resolveExecutable: () => '/opt/bin/my-goose'
    })
    expect(result.record).toEqual({ command: 'my-goose', args: '--x "y z"', env: { GOOSE_MODE: 'auto' } })
  })

  test('the record holds the Yolo defaults when nothing is saved', () => {
    expect(plan(CLAUDE).record).toEqual({ command: 'claude', args: '--dangerously-skip-permissions', env: {} })
    expect(plan(HERMES).record.command).toBe('hermes --tui')
  })

  test('D43: the first token becomes an absolute path only when it has no slash and a path resolves', () => {
    const resolveExecutable = (name: string) => (name === 'claude' ? '/home/me/.local/bin/claude' : null)
    expect(plan(CLAUDE, undefined, { resolveExecutable }).command).toBe(
      'claude --dangerously-skip-permissions'.replace('claude', '/home/me/.local/bin/claude')
    )
    expect(buildLaunchPlan({ entry: CLAUDE, config: config({ command: '/x/claude' }), resolveExecutable }).command).toBe(
      '/x/claude --dangerously-skip-permissions'
    )
    expect(plan(CODEX, undefined, { resolveExecutable }).command).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox'
    )
    expect(plan(CLAUDE, undefined, { resolveExecutable: () => '/a b/claude' }).command).toBe(
      `'/a b/claude' --dangerously-skip-permissions`
    )
  })

  test('D43: only the first token of a multi-token command is resolved', () => {
    const result = buildLaunchPlan({
      entry: CLAUDE,
      config: config({ command: 'claude --teammate-mode in-process', args: '' }),
      resolveExecutable: (name) => (name === 'claude' ? '/h/claude' : '/wrong')
    })
    expect(result.command).toBe('/h/claude --teammate-mode in-process')
  })
})

describe('prompt delivery', () => {
  test('SC-18: argv agents get the prompt literally as the last argument', () => {
    const prompt = `it's "done"; echo $HOME`
    const result = plan(CLAUDE, prompt)
    expect(words(result.command).at(-1)).toBe(prompt)
    expect(result.promptDelivery).toBe('command-line')
    expect(result.paste).toBeNull()
    const multiline = plan(CODEX, 'line one\nline two')
    expect(words(multiline.command).at(-1)).toBe('line one\nline two')
  })

  test('SC-18: a separator agent puts the prompt after --, so a flag-shaped prompt stays a prompt', () => {
    expect(words(plan(GROK, '--help').command).slice(-2)).toEqual(['--', '--help'])
  })

  test('the prompt is trimmed and a blank prompt is no prompt', () => {
    expect(plan(CODEX, '  hi  \n').command).toMatch(/ 'hi'$/)
    for (const blank of ['', '   \n\t']) {
      const result = plan(CODEX, blank)
      expect(result.promptDelivery).toBeNull()
      expect(result.paste).toBeNull()
      expect(result.command).toBe('codex --dangerously-bypass-approvals-and-sandbox')
    }
  })

  test('SC-19: flag modes put the prompt after their flag', () => {
    expect(plan(OPENCODE, 'fix the bug').command).toBe(`opencode --prompt 'fix the bug'`)
    expect(plan(GEMINI, 'fix the bug').command).toBe(`gemini --yolo --prompt-interactive 'fix the bug'`)
    expect(plan(COPILOT, 'fix the bug').command).toBe(`copilot -i 'fix the bug'`)
    for (const e of [OPENCODE, GEMINI, COPILOT]) expect(plan(e, 'fix the bug').promptDelivery).toBe('command-line')
  })

  describe('flag-prompt for an OpenCode run command', () => {
    const run = (command: string, e = OPENCODE) => buildLaunchPlan({ entry: e, config: config({ command }), prompt: 'fix the bug' })

    test('a run subcommand takes the prompt as a positional message after --', () => {
      const result = run('opencode run')
      expect(result.command).toBe(`opencode run -- 'fix the bug'`)
      expect(result.promptDelivery).toBe('command-line')
    })

    test('a run command with a message separator already present gets the bare prompt', () => {
      expect(run('opencode run --model x --').command).toBe(`opencode run --model x -- 'fix the bug'`)
    })

    test('a value flag consumes a following -- so it is not taken for the message separator', () => {
      expect(run('opencode run --title --').command).toBe(`opencode run --title -- -- 'fix the bug'`)
    })

    test('NAME=value prefixes, an env wrapper and an absolute path still find run', () => {
      expect(run('FOO=1 opencode run').command).toBe(`FOO=1 opencode run -- 'fix the bug'`)
      expect(run('env -u X FOO=1 /usr/bin/opencode run').command).toBe(`env -u X FOO=1 /usr/bin/opencode run -- 'fix the bug'`)
    })

    test('user arguments and hook arguments after run stay before the message', () => {
      const result = buildLaunchPlan({
        entry: OPENCODE,
        config: config({ command: 'opencode run', args: '--model x' }),
        hookArgs: ['--h'],
        prompt: 'fix the bug'
      })
      expect(result.command).toBe(`opencode run --model x --h -- 'fix the bug'`)
    })

    test('other subcommands, the bare TUI and other agents keep --prompt; global options before run are skipped', () => {
      expect(run('opencode').command).toBe(`opencode --prompt 'fix the bug'`)
      expect(run('opencode serve').command).toBe(`opencode serve --prompt 'fix the bug'`)
      expect(run('opencode --log-level DEBUG run').command).toBe(`opencode --log-level DEBUG run -- 'fix the bug'`)
      expect(run('opencode run', entry('mimo-code', { prompt: 'flag-prompt' })).command).toBe(`opencode run --prompt 'fix the bug'`)
    })

    test('opencode2 gets the same treatment', () => {
      expect(run('opencode2 run', entry('opencode2', { prompt: 'flag-prompt' })).command).toBe(`opencode2 run -- 'fix the bug'`)
    })
  })

  test('hook arguments land before a -- in the user arguments, and the prompt still goes last', () => {
    expect(
      buildLaunchPlan({ entry: CLAUDE, config: config({ args: '--continue --model x -- extra' }), hookArgs: ['--settings', 'f.json'] })
        .command
    ).toBe('claude --continue --model x --settings f.json -- extra')
    expect(
      buildLaunchPlan({
        entry: CLAUDE,
        config: config({ args: '--model x -- extra' }),
        hookArgs: ['--settings', 'f.json'],
        prompt: 'hi'
      }).command
    ).toBe(`claude --model x --settings f.json -- extra 'hi'`)
  })

  test('SC-19: hook arguments sit before the prompt part', () => {
    expect(plan(COPILOT, 'hi', { hookArgs: ['--h'] }).command).toBe(`copilot --h -i 'hi'`)
  })

  test('SC-19: hermes runs chat --query=<prompt> --tui with the startup variable gone', () => {
    const result = plan(HERMES, 'fix the bug')
    expect(result.promptDelivery).toBe('command-line')
    expect(result.paste).toBeNull()
    expect(result.command).not.toContain('fix the bug')
    expect(result.env).toEqual({ HERMES_QUIRKY_STARTUP_QUERY: 'fix the bug' })
    const ran = runFake('hermes', result.command, result.env)
    expect(ran.argv).toEqual(['chat', '--query=fix the bug', '--tui'])
    expect(ran.startupVariable).toBe('unset')
  })

  test('hermes carries a hostile prompt intact', () => {
    const prompt = `it's "q" $(touch /tmp/x) \\ \`id\`\nsecond line`
    const result = plan(HERMES, prompt)
    expect(runFake('hermes', result.command, result.env).argv).toEqual(['chat', `--query=${prompt.trim()}`, '--tui'])
  })

  test('hermes keeps an empty launch on the interactive TUI command', () => {
    expect(plan(HERMES).command).toBe('hermes --tui')
  })

  test('hermes moves override flags after chat and keeps ownership of the query and TUI mode', () => {
    const result = buildLaunchPlan({
      entry: HERMES,
      config: config({
        command: 'hermes --query override --cli --provider anthropic',
        args: '-q=second --query=third -qfourth --tui --yolo'
      }),
      prompt: 'automation prompt',
      hookArgs: ['--hook']
    })
    expect(runFake('hermes', result.command, result.env).argv).toEqual([
      'chat',
      '--query=automation prompt',
      '--provider',
      'anthropic',
      '--yolo',
      '--hook',
      '--tui'
    ])
  })

  test('hermes removes a duplicate chat subcommand but keeps an option value named chat', () => {
    const duplicate = buildLaunchPlan({
      entry: HERMES,
      config: config({ command: 'hermes --provider copilot chat --tui', args: '--provider copilot chat --yolo' }),
      prompt: 'p'
    })
    expect(runFake('hermes', duplicate.command, duplicate.env).argv).toEqual([
      'chat',
      '--query=p',
      '--provider',
      'copilot',
      '--provider',
      'copilot',
      '--yolo',
      '--tui'
    ])
    const valued = buildLaunchPlan({ entry: HERMES, config: config({ command: 'hermes --profile chat --tui' }), prompt: 'p' })
    expect(runFake('hermes', valued.command, valued.env).argv).toEqual(['chat', '--query=p', '--profile', 'chat', '--tui'])
  })

  test('hermes keeps wrapper tokens and NAME=value prefixes', () => {
    const wrapped = buildLaunchPlan({ entry: HERMES, config: config({ command: 'env -i PATH=x hermes --tui' }), prompt: 'p' })
    expect(words(wrapped.command)).toContain('sh')
    const assigned = buildLaunchPlan({ entry: HERMES, config: config({ command: 'HERMES_HOME=/tmp/x hermes --tui' }), prompt: 'p' })
    const ran = runFake('hermes', assigned.command, assigned.env)
    expect(ran.argv).toEqual(['chat', '--query=p', '--tui'])
  })

  test('a hermes command with no hermes executable falls back to a paste', () => {
    const result = buildLaunchPlan({ entry: HERMES, config: config({ command: 'custom-agent --tui' }), prompt: 'p' })
    expect(result.command).toBe('custom-agent --tui')
    expect(result.paste).toEqual({ text: 'p', submit: true })
    expect(result.promptDelivery).toBe('pending')
  })

  test('a hermes plan over 24000 bytes becomes a paste, measured in UTF-8 bytes', () => {
    const big = plan(HERMES, 'x'.repeat(24_000))
    expect(big.paste).toEqual({ text: 'x'.repeat(24_000), submit: true })
    expect(big.promptDelivery).toBe('pending')
    expect(big.command).toBe('hermes --tui')
    expect(big.env).toEqual({})
    expect(plan(HERMES, '界'.repeat(10_000)).paste).not.toBeNull()
    expect(plan(HERMES, 'x'.repeat(10_000)).paste).toBeNull()
  })

  test('stdin-after-start agents get a paste with Enter, and the command carries no prompt', () => {
    const result = plan(GOOSE, 'a\r\nb')
    expect(result.command).toBe('goose')
    expect(result.paste).toEqual({ text: 'a\r\nb', submit: true })
    expect(result.promptDelivery).toBe('pending')
  })

  test('SC-26: a draft uses the native draft flag where the agent has one', () => {
    const result = plan(CLAUDE, 'look at #5', { submitPrompt: false })
    expect(result.command).toBe(`claude --dangerously-skip-permissions --prefill 'look at #5'`)
    expect(result.promptDelivery).toBe('command-line')
    expect(result.paste).toBeNull()
  })

  test('SC-26: a draft for an agent with no flag is a paste without Enter', () => {
    for (const e of [GOOSE, CODEX, HERMES]) {
      const result = plan(e, 'look at #5', { submitPrompt: false })
      expect(result.paste).toEqual({ text: 'look at #5', submit: false })
      expect(result.promptDelivery).toBe('pending')
      expect(result.command).not.toContain('look at')
    }
  })

  test('SC-26: a blank draft is no prompt', () => {
    expect(plan(CLAUDE, '  ', { submitPrompt: false }).promptDelivery).toBeNull()
  })

  test('SC-27: a prompt over 128 KiB is pasted instead of carried', () => {
    const big = 'a'.repeat(131_073)
    const result = plan(CODEX, big)
    expect(result.command).toBe('codex --dangerously-bypass-approvals-and-sandbox')
    expect(result.paste).toEqual({ text: big, submit: true })
    expect(result.promptDelivery).toBe('pending')
  })

  test('SC-27: the limit counts UTF-8 bytes and a prompt at the limit still rides the command', () => {
    expect(plan(CODEX, 'a'.repeat(131_072)).paste).toBeNull()
    expect(plan(CODEX, '界'.repeat(43_691)).paste).not.toBeNull()
    expect(plan(CODEX, '界'.repeat(43_690)).paste).toBeNull()
  })

  test('SC-27: an oversized draft is pasted without Enter even when the agent has a draft flag', () => {
    const big = 'a'.repeat(131_073)
    const result = plan(CLAUDE, big, { submitPrompt: false })
    expect(result.command).not.toContain('--prefill')
    expect(result.paste).toEqual({ text: big, submit: false })
  })

  test('a NUL in the prompt is refused with the logic spec message', () => {
    const attempt = () => plan(CLAUDE, 'a\0b')
    expect(attempt).toThrow(PlanError)
    expect(attempt).toThrow('the prompt contains a NUL character')
  })

  test('SC-29: the grok plan line', () => {
    const result = plan(GROK, 'help')
    expect(result.command).toBe(`grok --permission-mode bypassPermissions -- 'help'`)
    expect(result.promptDelivery).toBe('command-line')
    expect(result.env).toEqual({})
  })
})

describe('resume plans', () => {
  const session = { id: 'S', transcriptPath: null }
  const withTranscript = { id: 'S', transcriptPath: '/t/S.jsonl' }
  const resume = (e: AgentEntry, record: LaunchRecord | null, rest: Partial<Parameters<typeof buildResumePlan>[0]> = {}) =>
    buildResumePlan({ entry: e, record, providerSession: session, fork: false, ...rest })

  test('SC-31: replays the recorded launch, not the current defaults', () => {
    const record = { command: 'claude', args: '--model haiku', env: {} }
    const result = resume(CLAUDE, record, { providerSession: { id: 'abc', transcriptPath: null }, hookArgs: ['--hook', 'v'] })
    expect(result.command).toBe('claude --model haiku --hook v --resume abc')
    expect(result.command).not.toContain('--dangerously-skip-permissions')
    expect(result.record).toEqual(record)
  })

  test('SC-31: a session with no record resumes with the catalog command and no arguments', () => {
    const result = resume(CLAUDE, null, { providerSession: { id: 'abc', transcriptPath: null } })
    expect(result.command).toBe('claude --resume abc')
    expect(result.record).toEqual({ command: 'claude', args: '', env: {} })
    expect(resume(HERMES_RESUMABLE, null).command).toBe('hermes --tui --resume S')
  })

  test('SC-31: environment is the entry, the recorded and the hook layers', () => {
    const tagged = entry('tagged', { env: { A: 'entry', B: 'entry' }, resume: ['--resume', '{id}'] })
    const result = resume(tagged, { command: 'tagged', args: '', env: { B: 'rec', C: 'rec' } }, { hookEnv: { C: 'hook', D: null } })
    expect(result.env).toEqual({ A: 'entry', B: 'rec', C: 'hook', D: null })
    expect(result.record.env).toEqual({ B: 'rec', C: 'rec' })
  })

  test('SC-31: the returned record is a copy', () => {
    const record = { command: 'claude', args: '', env: { A: '1' } }
    const result = resume(CLAUDE, record)
    result.record.env.A = '2'
    expect(record.env.A).toBe('1')
  })

  test('recorded arguments are re-quoted and stripArgs applies again', () => {
    const result = resume(OPENCODE, { command: 'opencode', args: '--dangerously-skip-permissions --model "a b"', env: {} })
    expect(result.command).toBe(`opencode --model 'a b' --session S`)
  })

  test('a recorded argument string that no longer tokenizes fails with the arguments message', () => {
    expect(() => resume(CLAUDE, { command: 'claude', args: '"x', env: {} })).toThrow(
      'CLI arguments are invalid: unterminated quote'
    )
  })

  test('D43: the recorded command resolves again at resume time', () => {
    const result = resume(CLAUDE, { command: 'claude', args: '', env: {} }, { resolveExecutable: () => '/h/.local/bin/claude' })
    expect(result.command).toBe('/h/.local/bin/claude --resume S')
    expect(result.record.command).toBe('claude')
  })

  describe('SC-32: one case per placeholder kind and resume shape', () => {
    test.each([
      ['{id}', CODEX, session, 'codex resume S'],
      ['{id} joined', COPILOT, session, 'copilot --resume=S'],
      ['{id} flag', GEMINI, session, 'gemini --resume S'],
      ['{transcript}', PI, withTranscript, 'pi --session /t/S.jsonl'],
      ['{transcriptOrId} with a path', OMP, withTranscript, 'omp --resume /t/S.jsonl'],
      ['{transcriptOrId} without one', OMP, session, 'omp --resume S']
    ])('%s', (_name, e, providerSession, expected) => {
      expect(resume(e, { command: e.launch, args: '', env: {} }, { providerSession }).command).toBe(expected)
    })

    test('{transcript} without a transcript path is refused', () => {
      const attempt = () => resume(PI, null)
      expect(attempt).toThrow(PlanError)
      expect(attempt).toThrow('pi needs a transcript path to resume')
      expect(() => resume(PI, null, { providerSession: { id: 'S', transcriptPath: '' } })).toThrow(
        'pi needs a transcript path to resume'
      )
    })

    test('a path with spaces is quoted', () => {
      expect(resume(PI, null, { providerSession: { id: 'S', transcriptPath: '/t/a b.jsonl' } }).command).toBe(
        `pi --session '/t/a b.jsonl'`
      )
    })

    test('a hostile session ID stays one argument', () => {
      const id = `x'; touch /tmp/pwned #`
      const result = resume(CODEX, null, { providerSession: { id, transcriptPath: null } })
      expect(words(result.command)).toEqual(['codex', 'resume', id])
    })
  })

  describe('SC-33: the Claude selector splice', () => {
    const claudeResume = (args: string, command = 'claude', hookArgs?: string[]) =>
      resume(CLAUDE, { command, args, env: {} }, { providerSession: { id: 'abc', transcriptPath: null }, hookArgs }).command

    test('replaces a saved --continue and keeps the terminator in place', () => {
      expect(claudeResume('--continue --model x -- extra')).toBe('claude --model x --resume abc -- extra')
    })

    test.each([
      '--resume stale-session',
      '--resume=stale-session',
      '-r stale-session',
      '-r=stale-session',
      '--resume= --model sonnet',
      '--continue',
      '-c',
      '--continue=1',
      '-c=1',
      '--resume stale -r older --continue -c'
    ])('replaces the stale selector in %s', (args) => {
      const tokens = words(claudeResume(args))
      expect(tokens.filter((t) => ['--resume', '--continue', '-r', '-c'].includes(t) || /^(--resume|--continue|-r|-c)=/.test(t))).toEqual([
        '--resume'
      ])
      expect(tokens.slice(-2)).toEqual(['--resume', 'abc'])
    })

    test('keeps surviving options and drops the stale locator', () => {
      expect(claudeResume('--resume stale --model sonnet')).toBe('claude --model sonnet --resume abc')
    })

    test('never mistakes a dash-leading option value for a selector', () => {
      expect(claudeResume('--model -recent')).toBe('claude --model -recent --resume abc')
      expect(claudeResume('--agent -reviewer')).toBe('claude --agent -reviewer --resume abc')
      expect(claudeResume('-rstale-session')).toBe('claude -rstale-session --resume abc')
    })

    test('a --resume followed by a flag is a bare selector with no locator to drop', () => {
      expect(claudeResume('--resume --model x')).toBe('claude --model x --resume abc')
    })

    test('hook arguments go before the resume selector, ahead of the terminator', () => {
      expect(claudeResume('--model x -- extra', 'claude', ['--hook'])).toBe('claude --model x --hook --resume abc -- extra')
      expect(claudeResume('', 'claude', ['--hook'])).toBe('claude --hook --resume abc')
    })

    test('finds claude behind a wrapper terminator or an env prefix and an absolute path', () => {
      expect(claudeResume('--resume stale', 'mise exec -- claude')).toBe('mise exec -- claude --resume abc')
      expect(claudeResume('--continue', 'FOO=1 claude')).toBe('FOO=1 claude --resume abc')
      expect(claudeResume('-c', '/h/bin/claude')).toBe('/h/bin/claude --resume abc')
    })

    test('appends unchanged when no claude executable is in command position', () => {
      expect(claudeResume('--continue', 'bash -c claude')).toBe('bash -c claude --continue --resume abc')
      expect(claudeResume('', 'my-agent-wrapper --resume')).toBe('my-agent-wrapper --resume --resume abc')
      expect(claudeResume('', 'ssh -i /k/claude devbox')).toBe('ssh -i /k/claude devbox --resume abc')
    })

    test('a claude-style entry splices a selector saved in its command override', () => {
      expect(claudeResume('--model x', 'claude --continue')).toBe('claude --model x --resume abc')
    })

    test('other agents keep plain appending', () => {
      const result = resume(GEMINI, { command: 'gemini', args: '--resume', env: {} })
      expect(result.command).toBe('gemini --resume --resume S')
    })
  })

  describe('SC-34: fork', () => {
    test.each([
      [CLAUDE, session, 'claude --resume S --fork-session'],
      [CODEX, session, 'codex fork S'],
      [GROK, session, 'grok --resume S --fork-session'],
      [PI, withTranscript, 'pi --fork /t/S.jsonl']
    ])('%#: %p forks', (e, providerSession, expected) => {
      expect(resume(e, { command: e.launch, args: '', env: {} }, { fork: true, providerSession }).command).toBe(expected)
    })

    test('the Claude splice applies to a fork too', () => {
      expect(resume(CLAUDE, { command: 'claude', args: '--continue --model x', env: {} }, { fork: true }).command).toBe(
        'claude --model x --resume S --fork-session'
      )
    })

    test('an agent with resume but no fork template can not fork', () => {
      const attempt = () => resume(OPENCODE, null, { fork: true })
      expect(attempt).toThrow(PlanError)
      expect(attempt).toThrow("opencode can't fork from Quirky yet")
    })
  })

  test('an agent with no resume template can not resume', () => {
    const attempt = () => resume(AIDER, null)
    expect(attempt).toThrow(PlanError)
    expect(attempt).toThrow("aider can't resume sessions")
  })

  test('a recorded command carrying shell syntax is quoted, not run', () => {
    const result = resume(CODEX, { command: 'touch /tmp/x; rm -rf y', args: '', env: {} })
    expect(words(result.command)).toEqual(['touch', '/tmp/x;', 'rm', '-rf', 'y', 'resume', 'S'])
  })
})

describe('launch settings in plans', () => {
  const catalog: LaunchCatalog = {
    model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }], structured: 'model' },
    options: [
      {
        id: 'effort',
        label: 'Effort',
        type: 'select',
        choices: ['low', 'high'].map((value) => ({ value, label: value })),
        flag: ['--effort', '{value}'],
        conflicts: [{ flags: ['--effort'] }],
        composed: false,
        structured: 'effort'
      }
    ],
    models: [{ id: 'opus', label: 'Opus', description: null, options: [{ id: 'effort', choices: null }] }],
    unlisted: 'accept',
    unlistedOptions: [],
    composeModel: null,
    valueFlags: ['--effort', '--model'],
    extraArgs: null
  }
  const picks: ValidSelection = { model: 'opus', values: Object.assign(Object.create(null), { effort: 'high' }), listed: true }
  const extras = (text: string): ParsedExtras => ({ tokens: words(text), kinds: new Set(['repeatable']) })
  const claude = { ...CLAUDE, label: 'Claude', launchOptions: catalog }

  test("a selection's flags land before the configured terminator and hook args keep their place", () => {
    const result = buildLaunchPlan({
      entry: claude,
      config: config({ args: '--verbose -- tail' }),
      selection: picks,
      hookArgs: ['--settings', 'x']
    })
    expect(words(result.command)).toEqual([
      'claude', '--verbose', '--model', 'opus', '--effort', 'high', '--settings', 'x', '--', 'tail'
    ])
  })

  test("a flag's value of -- is not taken as the arguments' terminator", () => {
    const result = buildLaunchPlan({
      entry: { ...claude, launchOptions: { ...catalog, valueFlags: ['--append-system-prompt'] } },
      config: config({ args: '--append-system-prompt -- --verbose' }),
      hookArgs: ['--settings', 'x']
    })
    expect(words(result.command)).toEqual(['claude', '--append-system-prompt', '--', '--verbose', '--settings', 'x'])
  })

  test('the prompt still follows the arguments', () => {
    const result = buildLaunchPlan({ entry: claude, config: config({ args: '' }), selection: picks, prompt: 'hi' })
    expect(words(result.command)).toEqual(['claude', '--model', 'opus', '--effort', 'high', 'hi'])
  })

  test('SC-21: the record holds the resolved arguments and resume replays them', () => {
    const launched = buildLaunchPlan({ entry: claude, config: config({ args: '--model haiku' }), selection: picks })
    expect(launched.record).toEqual({ command: 'claude', args: '--model opus --effort high', env: {} })
    const resumed = buildResumePlan({
      entry: claude,
      record: launched.record,
      providerSession: { id: 'abc', transcriptPath: null },
      fork: false
    })
    expect(words(resumed.command)).toEqual(['claude', '--model', 'opus', '--effort', 'high', '--resume', 'abc'])
    expect(resumed.command).not.toContain('haiku')
  })

  test('extras alone also rewrite the record, quoted', () => {
    const result = buildLaunchPlan({ entry: claude, config: config({ args: '' }), extras: extras('--add-dir "my docs"') })
    expect(result.record.args).toBe("--add-dir 'my docs'")
    expect(result.launchSettings).toEqual({
      agent: 'claude',
      options: {},
      args: { value: "--add-dir 'my docs'", source: 'explicit' },
      summary: 'Claude'
    })
  })

  test('the snapshot is the resolution of the pick', () => {
    const result = buildLaunchPlan({ entry: claude, config: EMPTY_CONFIG, selection: picks })
    expect(result.launchSettings).toEqual({
      agent: 'claude',
      options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
      args: { value: '--dangerously-skip-permissions', source: 'inherited' },
      summary: 'Claude · Opus · Effort: high'
    })
  })

  test('SC-22: a Yolo launch with no pick records its inherited arguments and keeps its command', () => {
    const result = buildLaunchPlan({ entry: claude, config: EMPTY_CONFIG })
    expect(result.command).toBe('claude --dangerously-skip-permissions')
    expect(result.record).toEqual({ command: 'claude', args: '--dangerously-skip-permissions', env: {} })
    expect(result.launchSettings).toEqual({
      agent: 'claude',
      options: {},
      args: { value: '--dangerously-skip-permissions', source: 'inherited' },
      summary: 'Claude'
    })
  })

  test('SC-22: a Manual launch with no pick has no snapshot', () => {
    const result = buildLaunchPlan({ entry: claude, config: config({ args: '' }) })
    expect(result.command).toBe('claude')
    expect(result.launchSettings).toBeNull()
  })

  test('the raw configured text is recorded untouched when nothing is picked', () => {
    const result = buildLaunchPlan({ entry: claude, config: config({ args: "--x   'y z'" }) })
    expect(result.record.args).toBe("--x   'y z'")
  })

  test('SC-16: a command override that already sets the model refuses a pick', () => {
    const attempt = () => buildLaunchPlan({ entry: claude, config: config({ command: 'claude --model sonnet' }), selection: picks })
    expect(attempt).toThrow(SelectionError)
    expect(attempt).toThrow('Agent command override conflicts with the requested launch preferences.')
  })

  test('SC-16: the catalog launch command is not an override', () => {
    const own = { ...claude, launch: 'claude --model sonnet' }
    expect(buildLaunchPlan({ entry: own, config: EMPTY_CONFIG, selection: picks }).record.args).toContain('--model opus')
  })

  test('a blank command override is not an override', () => {
    const result = buildLaunchPlan({ entry: claude, config: config({ command: '  ' }), selection: picks })
    expect(words(result.command).slice(0, 3)).toEqual(['claude', '--dangerously-skip-permissions', '--model'])
  })
})
