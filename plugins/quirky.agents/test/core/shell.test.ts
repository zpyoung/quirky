import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { joinCommand, quote, tokenize } from '../../src/core/shell'

function tokensOf(text: string): string[] {
  const result = tokenize(text)
  if (!result.ok) throw new Error(result.error)
  return result.tokens
}

/** The words a real shell passes to `printf` for `line`, read back NUL-separated. */
function shellWords(shell: string, line: string): string[] {
  const proc = Bun.spawnSync([shell, '-c', `printf '%s\\0' ${line}`], { stdout: 'pipe', stderr: 'pipe' })
  expect(proc.exitCode).toBe(0)
  const out = proc.stdout.toString()
  return out === '' ? [] : out.slice(0, -1).split('\0')
}

const ADVERSARIAL = [
  String.raw`use \d+ and \\server\share`,
  "it's mine",
  'ends\\',
  'a "b" c',
  '$PATH *.ts',
  '$(touch /tmp/pwned) ; rm -rf x',
  '`id` && echo | cat > /dev/null &',
  'line one\nline two',
  '#not-a-comment',
  '=ls',
  '~/x {a,b} [z]?',
  '--model=haiku 5',
  '-',
  '界 emoji 🎉'
]

describe('tokenize', () => {
  test('SC-12: shell syntax inside arguments comes back as literal tokens', () => {
    expect(tokensOf('--model "haiku 5" $(touch /tmp/pwned) ; rm -rf x')).toEqual([
      '--model',
      'haiku 5',
      '$(touch',
      '/tmp/pwned)',
      ';',
      'rm',
      '-rf',
      'x'
    ])
  })

  test('SC-12: an unterminated quote is an error', () => {
    expect(tokenize('--model "haiku')).toEqual({ ok: false, error: 'unterminated quote' })
    expect(tokenize("--model 'haiku")).toEqual({ ok: false, error: 'unterminated quote' })
  })

  test('operators and expansions are ordinary characters', () => {
    expect(tokensOf('a;b c|d e&f `g` $(h) ${i} >j')).toEqual(['a;b', 'c|d', 'e&f', '`g`', '$(h)', '${i}', '>j'])
  })

  test('single quotes are literal, including backslashes and double quotes', () => {
    expect(tokensOf(`'a "b" \\n $x'`)).toEqual([`a "b" \\n $x`])
  })

  test('double quotes honour backslash escapes only for $ ` " \\', () => {
    expect(tokensOf('"a \\" b" "c\\\\d" "e\\$f" "g\\`h" "i\\nj"')).toEqual(['a " b', 'c\\d', 'e$f', 'g`h', 'i\\nj'])
  })

  test('a backslash outside quotes escapes the next character', () => {
    expect(tokensOf('a\\ b c\\"d \\;')).toEqual(['a b', 'c"d', ';'])
  })

  test('a backslash-newline pair joins lines and a trailing backslash stays literal', () => {
    expect(tokensOf('ab\\\ncd')).toEqual(['abcd'])
    expect(tokensOf('a b\\')).toEqual(['a', 'b\\'])
  })

  test('adjacent quoted and bare runs form one token', () => {
    expect(tokensOf(`a"b"'c'd`)).toEqual(['abcd'])
  })

  test('empty quotes make an empty token', () => {
    expect(tokensOf(`a '' "" b`)).toEqual(['a', '', '', 'b'])
  })

  test('whitespace of any kind separates tokens and blank text has none', () => {
    expect(tokensOf('  a\t\tb \n c  ')).toEqual(['a', 'b', 'c'])
    expect(tokensOf('   ')).toEqual([])
    expect(tokensOf('')).toEqual([])
  })
})

describe('quote', () => {
  test('plain tokens stay bare', () => {
    for (const token of ['claude', '--model', '--permission-mode=auto', '/usr/bin/x', 'a@b.c:1,2%+', '-', '--']) {
      expect(quote(token)).toBe(token)
    }
  })

  test('always forces quotes on a plain token', () => {
    expect(quote('help', true)).toBe("'help'")
  })

  test('an empty token is two single quotes', () => {
    expect(quote('')).toBe("''")
  })

  test('anything else is single-quoted', () => {
    expect(quote('a b')).toBe("'a b'")
    expect(quote('$HOME')).toBe("'$HOME'")
    expect(quote('a;b')).toBe("'a;b'")
    expect(quote('=ls')).toBe("'=ls'")
  })

  test('a quote or backslash is spliced between single-quoted runs so fish reads the same bytes', () => {
    expect(quote("it's")).toBe(`'it'"'"'s'`)
    expect(quote(String.raw`\\server\share`)).toBe(`"\\\\""\\\\"'server'"\\\\"'share'`)
    expect(quote('ends\\')).toBe(`'ends'"\\\\"`)
  })

  test('round-trips through tokenize', () => {
    for (const value of ADVERSARIAL) {
      expect(tokensOf(quote(value))).toEqual([value])
      expect(tokensOf(quote(value, true))).toEqual([value])
    }
  })
})

describe('joinCommand', () => {
  test('joins quoted tokens with single spaces', () => {
    expect(joinCommand(['claude', '--model', 'haiku 5'])).toBe("claude --model 'haiku 5'")
    expect(joinCommand([])).toBe('')
  })

  test('round-trips a token list through tokenize', () => {
    expect(tokensOf(joinCommand(ADVERSARIAL))).toEqual(ADVERSARIAL)
  })

  test('SC-12: a real sh reads back exactly the original words', () => {
    expect(shellWords('/bin/sh', joinCommand(ADVERSARIAL))).toEqual(ADVERSARIAL)
  })

  test('SC-12: nothing in the arguments is executed', () => {
    const marker = `/tmp/qa-pwned-${process.pid}`
    const words = tokensOf(`--model "haiku 5" $(touch ${marker}) ; rm -rf x`)
    expect(shellWords('/bin/sh', joinCommand(words))).toEqual(words)
    expect(existsSync(marker)).toBe(false)
  })

  const bash = Bun.which('bash')
  const zsh = Bun.which('zsh')
  const fish = Bun.which('fish')
  for (const [name, path] of [['bash', bash], ['zsh', zsh], ['fish', fish]] as const) {
    test.skipIf(!path)(`a real ${name} reads back exactly the original words`, () => {
      const words = ADVERSARIAL.filter((value) => !value.includes('\n'))
      const line = joinCommand(words)
      const proc = Bun.spawnSync([path as string, '-c', `printf '%s\\n' ${line}`], { stdout: 'pipe', stderr: 'pipe' })
      expect(proc.exitCode).toBe(0)
      expect(proc.stdout.toString().split('\n').slice(0, -1)).toEqual(words)
    })
  }
})
