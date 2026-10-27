import { describe, expect, test } from 'bun:test'
import { extrasSummary, parseExtraArgs } from '../../src/core/extras'
import { SelectionError } from '../../src/core/selection'
import type { AgentEntry, ExtraArgRule, LaunchCatalog } from '../../src/core/types'

const catalog = (allowed: ExtraArgRule[], placeholder: string): LaunchCatalog => ({
  model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }], structured: null },
  options: [],
  models: [],
  unlisted: 'accept',
  unlistedOptions: [],
  composeModel: null,
  valueFlags: [],
  extraArgs: { allowed, placeholder }
})

const agent = (id: string, label: string, launchOptions: LaunchCatalog | null): AgentEntry =>
  ({ id, label, launchOptions }) as AgentEntry

const claude = agent(
  'claude',
  'Claude',
  catalog(
    [
      { kind: 'model', flags: ['--model'] },
      { kind: 'effort', flags: ['--effort'] },
      { kind: 'repeatable', flags: ['--add-dir'] }
    ],
    '--model opus --effort high --add-dir docs'
  )
)

const codex = agent(
  'codex',
  'Codex',
  catalog(
    [
      { kind: 'model', flags: ['-m', '--model'] },
      { kind: 'effort', flags: ['-c', '--config'], valuePrefix: 'model_reasoning_effort=' }
    ],
    '-m model-id -c model_reasoning_effort=high'
  )
)

const aider = agent('aider', 'Aider', null)
const noExtras = agent('gemini', 'Gemini', { ...catalog([], ''), extraArgs: null })

const refusal = (entry: AgentEntry, text: string): string => {
  try {
    parseExtraArgs(entry, text)
  } catch (error) {
    expect(error).toBeInstanceOf(SelectionError)
    return (error as Error).message
  }
  throw new Error('expected parseExtraArgs to throw')
}

describe('SC-17: allowlist refusals', () => {
  test('SC-17: a flag outside the allowlist', () => {
    expect(refusal(claude, '--verbose')).toBe(
      `"--verbose" isn't allowed in extra arguments for Claude. Allowed: --model, --effort, --add-dir.`
    )
  })

  test('SC-17: the name of an option with a value is quoted without the value', () => {
    expect(refusal(claude, '--verbose=1')).toBe(
      `"--verbose" isn't allowed in extra arguments for Claude. Allowed: --model, --effort, --add-dir.`
    )
  })

  test('SC-17: a bare word', () => {
    expect(refusal(claude, 'docs')).toBe(
      `"docs" isn't an option. Extra arguments for Claude accept only: --model, --effort, --add-dir.`
    )
  })

  test('SC-17: the end-of-options marker', () => {
    expect(refusal(claude, '--add-dir docs -- x')).toBe(`"--" isn't allowed in extra arguments.`)
  })

  test('SC-17: an option without a value', () => {
    expect(refusal(claude, '--effort')).toBe(`"--effort" needs a value.`)
    expect(refusal(claude, '--effort --add-dir docs')).toBe(`"--effort" needs a value.`)
  })

  test('SC-17: the model set twice', () => {
    expect(refusal(claude, '--model opus --model sonnet')).toBe('Extra arguments set the model more than once.')
  })

  test('the effort set twice', () => {
    expect(refusal(claude, '--effort low --effort high')).toBe('Extra arguments set the effort more than once.')
  })

  test('SC-17: shell syntax', () => {
    expect(refusal(claude, '--add-dir $(pwd)')).toBe(`$(pwd) uses shell syntax that extra arguments don't allow.`)
  })

  test('SC-17: more than 4 KB', () => {
    expect(refusal(claude, 'x'.repeat(4097))).toBe('Extra arguments must be 4 KB or less.')
  })

  test('the size limit counts bytes, not characters', () => {
    expect(refusal(claude, 'é'.repeat(2049))).toBe('Extra arguments must be 4 KB or less.')
  })

  test('4096 bytes is within the limit', () => {
    expect(refusal(claude, 'x'.repeat(4096))).toBe(
      `"${'x'.repeat(4096)}" isn't an option. Extra arguments for Claude accept only: --model, --effort, --add-dir.`
    )
  })

  test('SC-17: a line break or control character', () => {
    const message = 'Extra arguments cannot contain control characters or line breaks.'
    expect(refusal(claude, '--add-dir docs\n--add-dir src')).toBe(message)
    expect(refusal(claude, '--add-dir a\tb')).toBe(message)
    expect(refusal(claude, '--add-dir a\u0000b')).toBe(message)
    expect(refusal(claude, '--add-dir a b')).toBe(message)
  })

  test('SC-17: codex only takes -c model_reasoning_effort', () => {
    expect(refusal(codex, '-c sandbox=none')).toBe(
      `"-c sandbox=none" isn't allowed. Codex extra arguments accept only "-c model_reasoning_effort=<level>".`
    )
  })

  test('the codex value prefix needs a level after it', () => {
    expect(refusal(codex, '-c model_reasoning_effort=')).toBe(
      `"-c model_reasoning_effort=" isn't allowed. Codex extra arguments accept only "-c model_reasoning_effort=<level>".`
    )
    expect(refusal(codex, '--config sandbox=none')).toBe(
      `"--config sandbox=none" isn't allowed. Codex extra arguments accept only "--config model_reasoning_effort=<level>".`
    )
  })

  test('codex names its allowlist with the value prefix', () => {
    expect(refusal(codex, '--search')).toBe(
      `"--search" isn't allowed in extra arguments for Codex. Allowed: --model, -c model_reasoning_effort=….`
    )
  })

  test('SC-17: an agent without an allowlist', () => {
    const message = `Extra arguments aren't supported for this agent yet.`
    expect(refusal(aider, '--model x')).toBe(message)
    expect(refusal(noExtras, '--model x')).toBe(message)
  })

  test('an unclosed quote', () => {
    expect(refusal(claude, '--add-dir "docs')).toBe('Extra arguments are invalid: Unclosed quote in command template.')
  })
})

describe('accepted extra arguments', () => {
  test('a model and an effort', () => {
    const parsed = parseExtraArgs(claude, '--model opus --effort high')
    expect(parsed?.tokens).toEqual(['--model', 'opus', '--effort', 'high'])
    expect([...(parsed?.kinds ?? [])].sort()).toEqual(['effort', 'model'])
  })

  test('SC-17: --add-dir repeats', () => {
    const parsed = parseExtraArgs(claude, '--add-dir docs --add-dir src')
    expect(parsed?.tokens).toEqual(['--add-dir', 'docs', '--add-dir', 'src'])
    expect([...(parsed?.kinds ?? [])]).toEqual(['repeatable'])
  })

  test('SC-17: blank text means no extras', () => {
    expect(parseExtraArgs(claude, '')).toBeNull()
    expect(parseExtraArgs(claude, '   ')).toBeNull()
    expect(parseExtraArgs(aider, '  ')).toBeNull()
  })

  test('the --flag=value spelling', () => {
    expect(parseExtraArgs(claude, '--model=opus')?.tokens).toEqual(['--model=opus'])
  })

  test('quoted values stay one token', () => {
    expect(parseExtraArgs(claude, `--add-dir "my docs" --add-dir 'a b'`)?.tokens).toEqual([
      '--add-dir',
      'my docs',
      '--add-dir',
      'a b'
    ])
  })

  test('surrounding whitespace is ignored', () => {
    expect(parseExtraArgs(claude, '  --model opus  ')?.tokens).toEqual(['--model', 'opus'])
  })

  test('codex takes -m and the reasoning effort config', () => {
    const parsed = parseExtraArgs(codex, '-m gpt-5.5 -c model_reasoning_effort=high')
    expect(parsed?.tokens).toEqual(['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=high'])
    expect([...(parsed?.kinds ?? [])].sort()).toEqual(['effort', 'model'])
  })

  test('codex takes the long --config spelling', () => {
    expect(parseExtraArgs(codex, '--config model_reasoning_effort=low')?.tokens).toEqual([
      '--config',
      'model_reasoning_effort=low'
    ])
  })
})

describe('SC-17: shell syntax follows Orca', () => {
  const shellSyntax = (word: string) => `${word} uses shell syntax that extra arguments don't allow.`

  test('a hash inside a word is a literal, as in Orca', () => {
    expect(parseExtraArgs(claude, '--add-dir docs#old')?.tokens).toEqual(['--add-dir', 'docs#old'])
  })

  test('an escaped semicolon is a literal, as in Orca', () => {
    expect(parseExtraArgs(claude, '--add-dir docs\\;src')?.tokens).toEqual(['--add-dir', 'docs;src'])
  })

  test.each([
    ['a semicolon', '--add-dir a;b', 'a;b'],
    ['an ampersand', '--add-dir a&b', 'a&b'],
    ['a pipe', '--add-dir a|b', 'a|b'],
    ['a redirect in', '--add-dir <in', '<in'],
    ['a redirect out', '--add-dir a>out', 'a>out'],
    ['a backtick', '--add-dir `pwd`', '`pwd`'],
    ['a word-leading hash', '--add-dir #comment', '#comment'],
    ['dollar-brace', '--add-dir ${HOME}', '${HOME}'],
    ['dollar-quote', "--add-dir $'x'", "$'x'"],
    ['dollar-double-quote', '--add-dir $"x"', '$"x"'],
    ['a command substitution in double quotes', '--add-dir "$(pwd)"', '"$(pwd)"'],
    ['a parameter expansion in double quotes', '--add-dir "${HOME}"', '"${HOME}"'],
    ['a backtick in double quotes', '--add-dir "a`b`"', '"a`b`"'],
    ['a backslash before an ordinary character in double quotes', '--add-dir "a\\qb"', '"a\\qb"'],
    ['a trailing unpaired backslash', '--add-dir docs\\', 'docs\\']
  ])('%s is refused with the word quoted', (_name, text, word) => {
    expect(refusal(claude, text)).toBe(shellSyntax(word))
  })

  test('the first divergent word is the one named', () => {
    expect(refusal(claude, '--add-dir a;b --add-dir $(c)')).toBe(shellSyntax('a;b'))
  })

  test('operators and substitutions inside single quotes are literals', () => {
    expect(parseExtraArgs(claude, `--add-dir 'a;b' --add-dir '$(pwd)' --add-dir '\`x\`'`)?.tokens).toEqual([
      '--add-dir',
      'a;b',
      '--add-dir',
      '$(pwd)',
      '--add-dir',
      '`x`'
    ])
  })

  test('escapes Bash treats as escapes in double quotes are accepted', () => {
    expect(parseExtraArgs(claude, '--add-dir "a\\$b" --add-dir "c\\"d" --add-dir "e\\\\f"')?.tokens).toEqual([
      '--add-dir',
      'a$b',
      '--add-dir',
      'c"d',
      '--add-dir',
      'e\\f'
    ])
  })

  test('a lone dollar sign and a hash after a word start are literals', () => {
    expect(parseExtraArgs(claude, '--add-dir $HOME --add-dir a#b')?.tokens).toEqual([
      '--add-dir',
      '$HOME',
      '--add-dir',
      'a#b'
    ])
  })

  test('a hash after a quoted run is still inside the word', () => {
    expect(parseExtraArgs(claude, `--add-dir ''#x`)?.tokens).toEqual(['--add-dir', '#x'])
  })
})

describe('extrasSummary', () => {
  test('lists the allowlist and the placeholder', () => {
    expect(extrasSummary(claude)).toEqual({
      supported: true,
      allowed: '--model, --effort, --add-dir',
      placeholder: '--model opus --effort high --add-dir docs',
      message: null
    })
  })

  test('shows a value-prefixed rule with an ellipsis', () => {
    expect(extrasSummary(codex)).toEqual({
      supported: true,
      allowed: '--model, -c model_reasoning_effort=…',
      placeholder: '-m model-id -c model_reasoning_effort=high',
      message: null
    })
  })

  test('SC-4: an agent without an allowlist explains why', () => {
    const unsupported = {
      supported: false,
      allowed: null,
      placeholder: null,
      message: `Extra arguments aren't supported for this agent yet.`
    }
    expect(extrasSummary(aider)).toEqual(unsupported)
    expect(extrasSummary(noExtras)).toEqual(unsupported)
  })
})
