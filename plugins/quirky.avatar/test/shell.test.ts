import { describe, expect, test } from 'bun:test'
import { MAX_SHELL_CHARS, MAX_SHELL_DEPTH, parseShell } from '../src/gate/shell'
import type { ShellCommand, ShellRedirect, ShellScript, ShellWord } from '../src/gate/shell'

const env = { home: '/home/u' }
const word = (text: string, dynamic = false, subs: number[] = []): ShellWord => ({ text, dynamic, subs })
const words = (...texts: string[]): ShellWord[] => texts.map((text) => word(text))
const redirect = (kind: ShellRedirect['kind'], target: ShellWord | string): ShellRedirect => ({
  kind,
  target: typeof target === 'string' ? word(target) : target
})
const assignment = (name: string, value: ShellWord | string): ShellCommand['assignments'][number] => ({
  name,
  value: typeof value === 'string' ? word(value) : value
})
const command = (commandWords: ShellWord[] = [], options: Partial<ShellCommand> = {}): ShellCommand => ({
  scope: 0,
  sep: null,
  detached: false,
  assignments: [],
  words: commandWords,
  redirects: [],
  ...options
})
const script = (commands: ShellCommand[], parents: number[] = [-1]): ShellScript => ({ commands, parents })
const parse = (source: string): ShellScript | null => parseShell(source, env)

const slashNewline = '\\' + '\n'

describe('parseShell words and separators', () => {
  test('keeps simple commands, separators, and pipeline detachment', () => {
    expect(parse('ls -la && git status; cat a | head -5 || true')).toEqual(script([
      command(words('ls', '-la')),
      command(words('git', 'status'), { sep: '&&' }),
      command(words('cat', 'a'), { sep: ';', detached: true }),
      command(words('head', '-5'), { sep: '|', detached: true }),
      command(words('true'), { sep: '||' })
    ]))
  })

  test('normalizes newlines, list terminators, and |&', () => {
    expect(parse('a\nb;;c;&d|&e')).toEqual(script([
      command(words('a')),
      command(words('b'), { sep: ';' }),
      command(words('c'), { sep: ';' }),
      command(words('d'), { sep: ';', detached: true }),
      command(words('e'), { sep: '|', detached: true })
    ]))
  })

  test('does not detach logical lists or give a first command a preceding separator', () => {
    expect(parse('\n# heading\n\nls || pwd && id')).toEqual(script([
      command(words('ls')),
      command(words('pwd'), { sep: '||' }),
      command(words('id'), { sep: '&&' })
    ]))
  })

  test('marks background jobs and the complete background list detached', () => {
    expect(parse('sleep 5 & ls')).toEqual(script([
      command(words('sleep', '5'), { detached: true }),
      command(words('ls'), { sep: '&' })
    ]))
    expect(parse('a && b &')).toEqual(script([
      command(words('a'), { detached: true }),
      command(words('b'), { sep: '&&', detached: true })
    ]))
  })

  test('removes quote syntax while preserving each word boundary and empty words', () => {
    expect(parse(String.raw`echo 'a b' "c d" e\ f "g\"h" 'i'\''j' ''`)).toEqual(script([
      command(words('echo', 'a b', 'c d', 'e f', 'g"h', "i'j", ''))
    ]))
    expect(parse('echo "a\\nb"')).toEqual(script([command(words('echo', 'a\\nb'))]))
    expect(parse('echo \"a\\`b\"')).toEqual(script([command(words('echo', 'a`b'))]))
    expect(parse('echo "a\\\\b"')).toEqual(script([command(words('echo', 'a\\b'))]))
  })

  test('joins adjacent quoted and unquoted pieces in a redirect target', () => {
    expect(parse('>"/home/u/x"y')).toEqual(script([
      command([], { redirects: [redirect('write', '/home/u/xy')] })
    ]))
  })
})

describe('parseShell line continuations and comments', () => {
  test('removes backslash-newline outside single quotes', () => {
    const cases: Array<[string, ShellCommand[]]> = [
      ['cp a.txt ' + slashNewline + '/home/u/.zshrc', [command(words('cp', 'a.txt', '/home/u/.zshrc'))]],
      ['git pu' + slashNewline + 'sh origin main', [command(words('git', 'push', 'origin', 'main'))]],
      ['echo "a' + slashNewline + 'b"', [command(words('echo', 'ab'))]],
      [
        "echo 'a" + slashNewline + "b'",
        [command(words('echo', 'a\\\nb'))]
      ],
      ['cat a.txt ' + slashNewline + '| head -3', [
        command(words('cat', 'a.txt'), { detached: true }),
        command(words('head', '-3'), { sep: '|', detached: true })
      ]]
    ]
    for (const [source, commands] of cases) {
      expect(parse(source)).toEqual(script(commands))
    }
  })

  test('treats an unquoted word-start hash as a comment through that line', () => {
    expect(parse('echo a # ; rm -rf /home/u/x')).toEqual(script([command(words('echo', 'a'))]))
    expect(parse('echo a #x\nrm b')).toEqual(script([
      command(words('echo', 'a')),
      command(words('rm', 'b'), { sep: ';' })
    ]))
    expect(parse("echo a#b c#d '# no' \"# no\"")).toEqual(script([
      command(words('echo', 'a#b', 'c#d', '# no', '# no'))
    ]))
  })
})

describe('parseShell dynamic words and known home values', () => {
  test('marks shell expansions dynamic while retaining their quote-removed text', () => {
    const cases: Array<[string, ShellWord] | [string, ShellWord, ShellCommand[], number[]]> = [
      ['$X', word('$X', true)],
      ['${X}', word('${X}', true)],
      ['"$X"', word('$X', true)],
      ['a$X', word('a$X', true)],
      ['$1', word('$1', true)],
      ['$?', word('$?', true)],
      ['$@', word('$@', true)],
      ['"${X:-y}"', word('${X:-y}', true)],
      ["'$X'", word('$X')],
      ['\\$X', word('$X')],
      ['"\\$X"', word('$X')],
      ['a$', word('a$')],
      ['"$"', word('$')],
      ['$', word('$')],
      ['$(pwd)', word('$(pwd)', true, [1]), [command(words('pwd'), { scope: 1 })], [-1, 0]],
      ['`pwd`', word('`pwd`', true, [1]), [command(words('pwd'), { scope: 1 })], [-1, 0]],
      ['"$(pwd)"', word('$(pwd)', true, [1]), [command(words('pwd'), { scope: 1 })], [-1, 0]],
      ['x$(pwd)y', word('x$(pwd)y', true, [1]), [command(words('pwd'), { scope: 1 })], [-1, 0]],
      ['$((1+2))', word('$((1+2))', true)],
      ['<(ls)', word('<(ls)', true, [1]), [command(words('ls'), { scope: 1 })], [-1, 0]],
      ['>(cat)', word('>(cat)', true, [1]), [command(words('cat'), { scope: 1 })], [-1, 0]],
      ['~other/x', word('~other/x', true)],
      ['~+', word('~+', true)],
      ['~-/x', word('~-/x', true)],
      ["$'a\\tb'", word("$'a\\tb'", true)],
      ["$'ab'", word('ab')],
      ['*.ts', word('*.ts')],
      ['src/**/[ab]?.ts', word('src/**/[ab]?.ts')],
      ['{a,b}', word('{a,b}')],
      ['a{1..3}', word('a{1..3}')],
      ['{}', word('{}')]
    ]
    for (const [source, expected, nestedCommands = [], parents = [-1]] of cases) {
      expect(parse('echo ' + source)).toEqual(script([
        ...nestedCommands,
        command([word('echo'), expected])
      ], parents))
    }
  })

  test('expands only a leading unquoted tilde and HOME references', () => {
    const cases: Array<[string, ShellWord]> = [
      ['~', word('/home/u')],
      ['~/x', word('/home/u/x')],
      ['$HOME/x', word('/home/u/x')],
      ['${HOME}/x', word('/home/u/x')],
      ['"$HOME/x"', word('/home/u/x')],
      ['"${HOME}"/x', word('/home/u/x')],
      ["'~/x'", word('~/x')],
      ['"~/x"', word('~/x')],
      ['a~/x', word('a~/x')],
      ['$HOMER', word('$HOMER', true)],
      ['${HOME:-/x}', word('${HOME:-/x}', true)],
      ['${HOME}$X', word('${HOME}$X', true)]
    ]
    for (const [source, expected] of cases) {
      expect(parse('echo ' + source)).toEqual(script([command([word('echo'), expected])]))
    }
  })
})

describe('parseShell scopes and assignments', () => {
  test('emits substitution commands before the word that contains them', () => {
    expect(parse('echo "$(pwd ; git push -f origin main)"')).toEqual(script([
      command(words('pwd'), { scope: 1 }),
      command(words('git', 'push', '-f', 'origin', 'main'), { scope: 1, sep: ';' }),
      command([word('echo'), word('$(pwd ; git push -f origin main)', true, [1])])
    ], [-1, 0]))
  })

  test('finds commands inside backticks and counts nested scopes in opening order', () => {
    expect(parse('echo "`pwd; id`"')).toEqual(script([
      command(words('pwd'), { scope: 1 }),
      command(words('id'), { scope: 1, sep: ';' }),
      command([word('echo'), word('`pwd; id`', true, [1])])
    ], [-1, 0]))

    expect(parse('echo "$(echo "$(echo `id`)")"')).toEqual(script([
      command(words('id'), { scope: 3 }),
      command([word('echo'), word('`id`', true, [3])], { scope: 2 }),
      command([word('echo'), word('$(echo `id`)', true, [2])], { scope: 1 }),
      command([word('echo'), word('$(echo "$(echo `id`)")', true, [1])])
    ], [-1, 0, 1, 2]))
  })

  test('does not close a substitution on a quoted right parenthesis', () => {
    expect(parse('echo "$(echo \')\' ; id)"')).toEqual(script([
      command(words('echo', ')'), { scope: 1 }),
      command(words('id'), { scope: 1, sep: ';' }),
      command([word('echo'), word("$(echo ')' ; id)", true, [1])])
    ], [-1, 0]))
  })

  test('records leading assignments separately and keeps later assignments as words', () => {
    expect(parse('x=$(id) y=2')).toEqual(script([
      command(words('id'), { scope: 1 }),
      command([], {
        assignments: [assignment('x', word('$(id)', true, [1])), assignment('y', '2')]
      })
    ], [-1, 0]))

    expect(parse('A=1 B="$X" env ls')).toEqual(script([
      command(words('env', 'ls'), {
        assignments: [assignment('A', '1'), assignment('B', word('$X', true))]
      })
    ]))
    expect(parse('env A=1')).toEqual(script([command(words('env', 'A=1'))]))
    expect(parse('A+=x env')).toEqual(script([command(words('env'), { assignments: [assignment('A', word('x', true))] })]))
    expect(parse('1A=x env')).toEqual(script([command(words('1A=x', 'env'))]))
    expect(parse("'A=1' env")).toEqual(script([command(words('A=1', 'env'))]))
  })

  test('finds substitutions nested in parameter and arithmetic expansions', () => {
    for (const source of ['echo ${X:-$(id)}', 'echo $(( $(id) + 1 ))']) {
      const expansion = source.startsWith('echo ${') ? '${X:-$(id)}' : '$(( $(id) + 1 ))'
      expect(parse(source)).toEqual(script([
        command(words('id'), { scope: 1 }),
        command([word('echo'), word(expansion, true, [1])])
      ], [-1, 0]))
    }
  })

  test('records subshell scopes and process-substitution scopes', () => {
    expect(parse('(cd /tmp && ls); pwd')).toEqual(script([
      command(words('cd', '/tmp'), { scope: 1 }),
      command(words('ls'), { scope: 1, sep: '&&' }),
      command(words('pwd'), { sep: ';' })
    ], [-1, 0]))

    expect(parse('diff <(ls a) >(cat b)')).toEqual(script([
      command(words('ls', 'a'), { scope: 1 }),
      command(words('cat', 'b'), { scope: 2 }),
      command([word('diff'), word('<(ls a)', true, [1]), word('>(cat b)', true, [2])])
    ], [-1, 0, 0]))
  })

  test('treats a right parenthesis outside a scope as a list separator', () => {
    expect(parse('a ) b')).toEqual(script([
      command(words('a')),
      command(words('b'), { sep: ';' })
    ]))
  })
})

describe('parseShell redirects', () => {
  test('classifies output, input, and descriptor-duplication redirects precisely', () => {
    const cases: Array<[string, ShellRedirect['kind'], ShellWord]> = [
      ['> a', 'write', word('a')],
      ['>a', 'write', word('a')],
      ['>> a', 'write', word('a')],
      ['>| a', 'write', word('a')],
      ['&> a', 'write', word('a')],
      ['&>> a', 'write', word('a')],
      ['2> a', 'write', word('a')],
      ['2>>a', 'write', word('a')],
      ['<> a', 'write', word('a')],
      ['>& a', 'write', word('a')],
      ['>&a', 'write', word('a')],
      ['>"/home/u/.zshrc"', 'write', word('/home/u/.zshrc')],
      [">'/home/u/.zshrc'", 'write', word('/home/u/.zshrc')],
      ['> /home/u/.z"shrc"', 'write', word('/home/u/.zshrc')],
      ['> $OUT', 'write', word('$OUT', true)],
      ['>&2', 'dup', word('2')],
      ['2>&1', 'dup', word('1')],
      ['>&-', 'dup', word('-')],
      ['<&0', 'dup', word('0')],
      ['< a', 'read', word('a')],
      ['<<< "x y"', 'read', word('x y')]
    ]
    for (const [source, kind, target] of cases) {
      expect(parse('echo hi ' + source)).toEqual(script([
        command(words('echo', 'hi'), { redirects: [redirect(kind, target)] })
      ]))
    }
  })

  test('keeps a substitution in a redirect target and its nested commands', () => {
    expect(parse('echo hi > "$(echo x)"')).toEqual(script([
      command(words('echo', 'x'), { scope: 1 }),
      command(words('echo', 'hi'), {
        redirects: [redirect('write', word('$(echo x)', true, [1]))]
      })
    ], [-1, 0]))
  })

  test('supports redirects before words, redirect-only commands, and source order', () => {
    expect(parse('> out echo hi')).toEqual(script([
      command(words('echo', 'hi'), { redirects: [redirect('write', 'out')] })
    ]))
    expect(parse('> /home/u/x')).toEqual(script([
      command([], { redirects: [redirect('write', '/home/u/x')] })
    ]))
    expect(parse('echo hi 2>&1 > /dev/null')).toEqual(script([
      command(words('echo', 'hi'), {
        redirects: [redirect('dup', '1'), redirect('write', '/dev/null')]
      })
    ]))
  })
})

describe('parseShell heredocs', () => {
  test('reads heredoc body data without turning it into commands', () => {
    expect(parse('cat <<EOF > /home/u/.zshrc\nhi\nEOF')).toEqual(script([
      command(words('cat'), {
        redirects: [redirect('heredoc', 'hi\n'), redirect('write', '/home/u/.zshrc')]
      })
    ]))
  })

  test('parses substitutions in an unquoted heredoc body as nested scopes', () => {
    expect(parse('cat <<EOF\n$(git push -f origin main)\nEOF')).toEqual(script([
      command(words('git', 'push', '-f', 'origin', 'main'), { scope: 1 }),
      command(words('cat'), {
        redirects: [redirect('heredoc', word('$(git push -f origin main)\n', true, [1]))]
      })
    ], [-1, 0]))
  })

  test('keeps a quoted heredoc body literal for each quoted delimiter form', () => {
    for (const delimiter of ["'EOF'", '"EOF"', '\\EOF']) {
      expect(parse('cat <<' + delimiter + '\n$(git push -f origin main); rm -rf /\nEOF')).toEqual(script([
        command(words('cat'), {
          redirects: [redirect('heredoc', '$(git push -f origin main); rm -rf /\n')]
        })
      ]))
    }
  })

  test('strips leading tabs with <<- and resumes commands after the delimiter', () => {
    expect(parse('cat <<-EOF\n\ta\n\tEOF\nrm b')).toEqual(script([
      command(words('cat'), { redirects: [redirect('heredoc', 'a\n')] }),
      command(words('rm', 'b'), { sep: ';' })
    ]))
  })

  test('keeps pipeline separators around heredoc bodies and reads multiple bodies in order', () => {
    expect(parse('cat <<EOF | grep x\nbody\nEOF\nls')).toEqual(script([
      command(words('cat'), { detached: true, redirects: [redirect('heredoc', 'body\n')] }),
      command(words('grep', 'x'), { sep: '|', detached: true }),
      command(words('ls'), { sep: ';' })
    ]))
    expect(parse('cat <<A <<B\n1\nA\n2\nB')).toEqual(script([
      command(words('cat'), {
        redirects: [redirect('heredoc', '1\n'), redirect('heredoc', '2\n')]
      })
    ]))
  })

  test('ignores quote and parenthesis characters inside nested heredoc bodies', () => {
    const source = 'git commit -m "$(cat <<\'EOF\'\nfix: a thing\n\nIt\'s (done) and "quoted".\nEOF\n)"'
    expect(parse(source)).toEqual(script([
      command(words('cat'), {
        scope: 1,
        redirects: [redirect('heredoc', 'fix: a thing\n\nIt\'s (done) and "quoted".\n')]
      }),
      command([
        ...words('git', 'commit', '-m'),
        word("$(cat <<'EOF'\nfix: a thing\n\nIt's (done) and \"quoted\".\nEOF\n)", true, [1])
      ])
    ], [-1, 0]))
  })

  test('preserves line continuations in quoted-delimiter heredoc bodies', () => {
    expect(parse("cat <<'EOF'\na" + slashNewline + 'b\nEOF')).toEqual(script([
      command(words('cat'), { redirects: [redirect('heredoc', 'a\\\nb\n')] })
    ]))
  })
})

describe('parseShell malformed input and limits', () => {
  test('returns null for every specified unreadable source', () => {
    const malformed = [
      "echo 'abc",
      'echo "abc',
      'echo `id',
      'echo "$(ls',
      'echo ${X',
      '(ls',
      "echo $'a",
      'echo >',
      'echo > ; ls',
      'echo hi > | cat',
      'cat <<EOF\nno end',
      'cat <<$X\na\n$X',
      '\0',
      'x'.repeat(MAX_SHELL_CHARS + 1),
      '$('.repeat(MAX_SHELL_DEPTH + 1) + 'id' + ')'.repeat(MAX_SHELL_DEPTH + 1)
    ]
    for (const source of malformed) {
      expect(parse(source)).toBeNull()
    }
  })

  test('accepts the exact character and nesting limits', () => {
    expect(MAX_SHELL_CHARS).toBe(1_048_576)
    expect(MAX_SHELL_DEPTH).toBe(32)

    const maxLength = parse('echo ' + 'a'.repeat(MAX_SHELL_CHARS - 'echo '.length))
    expect(maxLength).not.toBeNull()
    const maxLengthWord = maxLength?.commands[0]?.words[1]
    expect(maxLength?.commands).toHaveLength(1)
    expect(maxLengthWord?.dynamic).toBe(false)
    expect(maxLengthWord?.subs).toEqual([])
    expect(maxLengthWord?.text).toHaveLength(MAX_SHELL_CHARS - 'echo '.length)
    expect(maxLengthWord?.text[0]).toBe('a')
    expect(maxLengthWord?.text.at(-1)).toBe('a')

    const maxDepth = parse('$('.repeat(MAX_SHELL_DEPTH) + 'id' + ')'.repeat(MAX_SHELL_DEPTH))
    expect(maxDepth).not.toBeNull()
    expect(maxDepth?.parents).toHaveLength(MAX_SHELL_DEPTH + 1)
  })
})

describe('parseShell totality and linear-time families', () => {
  test('never throws for empty, incomplete, or unusual punctuation', () => {
    for (const source of ['', '   ', '\\', ')', '}', ';;', '&', '|', '<<', '$(', '#', '"']) {
      expect(() => parse(source)).not.toThrow()
      const result = parse(source)
      expect(result === null || (Array.isArray(result.commands) && Array.isArray(result.parents))).toBe(true)
    }
  })

  const performanceCases: Array<[string, string]> = [
    ['many shell words', 'sh '.repeat(80_000)],
    ['many command separators', 'ls;'.repeat(80_000)],
    ['many quoted words', 'echo ' + '"a" '.repeat(58_750)],
    ['many redirects', 'echo ' + '>a '.repeat(78_333)],
    ['many assignments', 'A=1 '.repeat(60_000)],
    ['excessively nested substitutions', '$('.repeat(120_000)],
    ['many quote delimiters', "'".repeat(240_000)]
  ]

  for (const [family, source] of performanceCases) {
    test(`parses ${family} within the 1000 ms bound`, () => {
      const started = performance.now()
      parse(source)
      expect(performance.now() - started).toBeLessThan(1000)
    })
  }
})

describe('reviewed shell reader boundaries', () => {
  const marker = "printf 'RAN%s\\n' 1"
  const bt = '`'
  const bs = '\\'
  const sources: [string, string][] = [
    ['escaped nested backticks', `echo ${bt}echo ${bs}${bt}${marker}${bs}${bt}${bt}`],
    ['escaped double quotes in backticks', `echo ${bt}echo ${bs}${bs}"; ${marker}; echo ${bs}${bs}"${bt}`],
    ['escaped double quotes in double-quoted backticks', `echo "${bt}echo ${bs}${bs}"; ${marker}; echo ${bs}${bs}"${bt}"`],
    ['comments ending at the backtick boundary', `echo ${bt}echo a #${bt} ; ${marker}\n: ${bt} # ${bt}`],
    ['carriage return within a word', `echo a\r#x; ${marker}`],
    ['carriage return starting a word', `echo a;\r# ; ${marker}`],
    ['vertical tab within a word', `echo a\v#x; ${marker}`],
    ['form feed within a word', `echo a\f#x; ${marker}`],
    ['continued heredoc delimiter', `cat <<E${bs}\nOF\n$(${marker})\nEOF`],
    ['outer heredoc followed by multiline subshell', `cat <<'EOF'; (echo a\nEOF\n)\n${marker}\nEOF`],
    ['literal backslash in parameter single quotes', `echo \${x:-'${bs}'} ; ${marker} ; : '}'${bs}'`]
  ]
  for (const [name, source] of sources) {
    test(name, () => {
      const parsed = parse(source)
      expect(parsed).not.toBeNull()
      expect(parsed?.commands.some((item) => item.words[0]?.text === 'printf')).toBe(true)
    })
  }

  const ambiguous: [string, string][] = [
    ['single quotes across backtick boundaries', `echo ${bt}echo 'a${bt} ; ${marker} ; echo ${bt}b'${bt}`],
    ['locale-quoted heredoc delimiter', `cat <<$"EOF"\nEOF\n${marker}\n$EOF`],
    ['unmatched closing parenthesis in command-substitution heredoc', `echo $(cat <<'EOF'\na) ; ${marker}; : $(cat <<'EOF'\nEOF\n)`],
    ['zsh evaluating parameter flag', `x='$(${marker})'; echo \${(e)x}`]
  ]
  for (const [name, source] of ambiguous) {
    test(`holds shell-dependent ${name}`, () => {
      expect(parse(source)).toBeNull()
    })
  }

  const supported: [string, string][] = [
    ['subshell and-list', `(echo a) && ${marker}`],
    ['subshell pipeline', `(echo a) | cat; ${marker}`],
    ['subshell or-list', `(echo a) || (${marker})`],
    ['heredoc after closed subshell', `(cat <<EOF)\n$(${marker})\nEOF`],
    ['two heredocs across command substitution', `cat <<A; echo $(cat <<B\n1\nA\n2\nB\n); ${marker}`]
  ]
  for (const [name, source] of supported) {
    test(`reads ${name}`, () => {
      const parsed = parse(source)
      expect(parsed).not.toBeNull()
      expect(parsed?.commands.some((item) => item.words[0]?.text === 'printf')).toBe(true)
    })
  }

  test('does not split non-shell whitespace into a comment boundary', () => {
    for (const separator of ['\r', '\v', '\f']) {
      expect(parse(`echo a${separator}#b`)).toEqual(script([command(words('echo', `a${separator}#b`))]))
    }
  })
})
