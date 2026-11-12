import { describe, expect, test } from 'bun:test'
import { MAX_SHELL_CHARS, MAX_SHELL_DEPTH, parseShell } from '../src/gate/shell'
import * as shellModule from '../src/gate/shell'
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
      ['a{1..3}', word('a{1..3}', true)],
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
      ['<<< "x y"', 'heredoc', word('x y')]
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

  test('treats a here-string as input data while retaining nested commands', () => {
    expect(parse('cat <<< "$(git push -f origin main)"')).toEqual(script([
      command(words('git', 'push', '-f', 'origin', 'main'), { scope: 1 }),
      command(words('cat'), {
        redirects: [redirect('heredoc', word('$(git push -f origin main)', true, [1]))]
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

  test('uses quoted cat heredocs as known substitution values', () => {
    const heredocCat = (scope: number, body: string): ShellCommand => command(words('cat'), {
      scope,
      redirects: [redirect('heredoc', body)]
    })
    const cases: Array<[string, ShellScript]> = [
      [
        'git commit -m "$(cat <<\'EOF\'\nfix: a thing\n\nIt\'s (done).\nEOF\n)"',
        script([
          heredocCat(1, 'fix: a thing\n\nIt\'s (done).\n'),
          command([...words('git', 'commit', '-m'), word("fix: a thing\n\nIt's (done).", false, [1])])
        ], [-1, 0])
      ],
      [
        'echo "a $(cat <<\'EOF\'\nb\n\n\nEOF\n) c"',
        script([
          heredocCat(1, 'b\n\n\n'),
          command([word('echo'), word('a b c', false, [1])])
        ], [-1, 0])
      ],
      [
        'echo "$(cat <<"EOF"\n$X\nEOF\n)"',
        script([
          heredocCat(1, '$X\n'),
          command([word('echo'), word('$X', false, [1])])
        ], [-1, 0])
      ],
      [
        'echo "$(cat <<\\EOF\n$X\nEOF\n)"',
        script([
          heredocCat(1, '$X\n'),
          command([word('echo'), word('$X', false, [1])])
        ], [-1, 0])
      ],
      [
        'echo "$(cat <<-\'EOF\'\n\tx\n\tEOF\n)"',
        script([
          heredocCat(1, 'x\n'),
          command([word('echo'), word('x', false, [1])])
        ], [-1, 0])
      ],
      [
        'echo "$(cat <<\'EOF\'\na\nEOF\n)$(cat <<\'EOF\'\nb\nEOF\n)"',
        script([
          heredocCat(1, 'a\n'),
          heredocCat(2, 'b\n'),
          command([word('echo'), word('ab', false, [1, 2])])
        ], [-1, 0, 0])
      ],
      [
        'A="$(cat <<\'EOF\'\nvalue\nEOF\n)" true',
        script([
          heredocCat(1, 'value\n'),
          command(words('true'), { assignments: [assignment('A', word('value', false, [1]))] })
        ], [-1, 0])
      ],
      [
        'echo > "$(cat <<\'EOF\'\nvalue\nEOF\n)"',
        script([
          heredocCat(1, 'value\n'),
          command(words('echo'), { redirects: [redirect('write', word('value', false, [1]))] })
        ], [-1, 0])
      ]
    ]
    for (const [source, expected] of cases) {
      expect(parse(source)).toEqual(expected)
    }
  })

  test('keeps other command-substitution heredoc shapes dynamic', () => {
    const cases: Array<[string, string]> = [
      ['unquoted substitution', 'echo $(cat <<\'EOF\'\na --no-verify\nEOF\n)'],
      ['backtick substitution', 'echo "`cat <<\'EOF\'\na\nEOF\n`"'],
      ['unquoted delimiter', 'echo "$(cat <<EOF\na\nEOF\n)"'],
      ['additional cat word', 'echo "$(cat - <<\'EOF\'\na\nEOF\n)"'],
      ['additional command', 'echo "$(cat <<\'EOF\' | tr a b\na\nEOF\n)"'],
      ['different command', 'echo "$(tac <<\'EOF\'\na\nEOF\n)"'],
      ['qualified cat command', 'echo "$(/bin/cat <<\'EOF\'\na\nEOF\n)"'],
      ['command assignment', 'echo "$(X=1 cat <<\'EOF\'\na\nEOF\n)"'],
      ['additional redirect', 'echo "$(cat <<\'EOF\' 2>/dev/null\na\nEOF\n)"'],
      ['non-stdin heredoc', 'echo "$(cat 3<<\'EOF\'\na\nEOF\n)"'],
      ['here-string', 'echo "$(cat <<< \'a\')"'],
      ['parameter expansion', 'echo "${X:-$(cat <<\'EOF\'\na\nEOF\n)}"'],
      ['separate dynamic expansion', 'echo "$X $(cat <<\'EOF\'\na\nEOF\n)"']
    ]
    for (const [, source] of cases) {
      const parsed = parse(source)
      expect(parsed).not.toBeNull()
      const outer = parsed?.commands.find((item) => item.scope === 0)
      const lastWord = outer?.words[outer.words.length - 1]
      expect(lastWord).toBeDefined()
      expect(lastWord?.dynamic).toBe(true)
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
      command([...words('git', 'commit', '-m'), word('fix: a thing\n\nIt\'s (done) and "quoted".', false, [1])])
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
  test('reads a 100,000-line quoted cat heredoc within the 1000 ms bound', () => {
    const source = 'echo "$(cat <<\'EOF\'\n' + 'a\n'.repeat(100_000) + 'EOF\n)"'
    const started = performance.now()
    const parsed = parse(source)
    expect(performance.now() - started).toBeLessThan(1000)
    const outer = parsed?.commands.find((item) => item.scope === 0)
    const lastWord = outer?.words[outer.words.length - 1]
    expect(lastWord?.text.length).toBe(199_999)
    expect(lastWord?.dynamic).toBe(false)
    expect(lastWord?.subs).toEqual([1])
  })
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

describe('round 2 reader mutation guards', () => {
  test('unescapes backslash-dollar in a double-quoted backtick body', () => {
    const parsed = parse('echo `echo "\\$(printf RAN)"`')
    expect(parsed?.commands.map((item) => item.words.map((item) => item.text))).toEqual([
      ['printf', 'RAN'],
      ['echo', '$(printf RAN)'],
      ['echo', '`echo "\\$(printf RAN)"`']
    ])
  })

  for (const [name, prefix] of [['vertical tab', '\v'], ['form feed', '\f']]) {
    test(`keeps word-start ${name} from turning a following hash into a comment`, () => {
      expect(parse(`${prefix}#x; printf RAN`)).toEqual(script([
        command(words(`${prefix}#x`)),
        command(words('printf', 'RAN'), { sep: ';' })
      ]))
    })
  }

  test('resets the heredoc queue before a later command with a quoted body character', () => {
    expect(parse("cat <<A\nx\nA\ncat <<B\n'\nB\nprintf RAN #'\n")).toEqual(script([
      command(words('cat'), { redirects: [redirect('heredoc', 'x\n')] }),
      command(words('cat'), { sep: ';', redirects: [redirect('heredoc', "'\n")] }),
      command(words('printf', 'RAN'), { sep: ';' })
    ]))
  })

  test('refuses an evaluating zsh flag nested in a parameter fallback', () => {
    expect(parse("y='$(printf RAN)'; echo ${x:-${(e)y}}")).toBeNull()
  })

  const ambiguous: [string, string][] = [
    ['a nested subshell', 'echo $( (cat <<EOF\n)\nEOF\n) ); printf RAN'],
    ['a balanced pair before a stray closing parenthesis', 'echo $(cat <<EOF\n( ) )\nEOF\n); printf RAN'],
    ['an earlier backtick scope', 'echo `printf EARLIER`; echo $(cat <<EOF\n)\nEOF\n); printf RAN']
  ]
  for (const [name, source] of ambiguous) {
    test(`refuses a substitution heredoc with ${name}`, () => {
      expect(parse(source)).toBeNull()
    })
  }

  test('shares scope ids and parents with a command substitution inside backticks', () => {
    expect(parse('echo `echo $(printf RAN)`')).toEqual(script([
      command(words('printf', 'RAN'), { scope: 2 }),
      command([word('echo'), word('$(printf RAN)', true, [2])], { scope: 1 }),
      command([word('echo'), word('`echo $(printf RAN)`', true, [1])])
    ], [-1, 0, 1]))
  })
})

describe('brace expansion', () => {
  const expectEchoWords = (source: string, expected: string[]) => {
    expect(parse(`echo ${source}`)).toEqual(script([
      command(words('echo', ...expected))
    ]))
  }

  describe('scenario 1: lists expand in shell order', () => {
    const rows: Array<{ name: string; source: string; words: string[] }> = [
      { name: 'a list is one word per alternative', source: '{a,b}', words: ['a', 'b'] },
      { name: 'keeps text before and after a list', source: 'x{a,b}y', words: ['xay', 'xby'] },
      { name: 'takes the product of two lists', source: '{a,b}{c,d}', words: ['ac', 'ad', 'bc', 'bd'] },
      { name: 'leftmost list changes slowest across three lists', source: '{a,b}{c,d}{e,f}', words: ['ace', 'acf', 'ade', 'adf', 'bce', 'bcf', 'bde', 'bdf'] },
      { name: 'expands a nested list', source: '{a,{b,c}}', words: ['a', 'b', 'c'] },
      { name: 'expands nested products inside an alternative', source: '{a,b,{c,d}{e,f}}', words: ['a', 'b', 'ce', 'cf', 'de', 'df'] },
      { name: 'retains hidden path components', source: 'x/.{,a}./y', words: ['x/../y', 'x/.a./y'] },
      { name: 'keeps an empty alternative when surrounding text makes a word', source: 'a.txt{,.bak}', words: ['a.txt', 'a.txt.bak'] },
      { name: 'keeps repeated empty alternatives', source: '{,,}x', words: ['x', 'x', 'x'] },
      { name: 'treats a dotted list alternative as literal text', source: '{a..b,c}', words: ['a..b', 'c'] },
      { name: 'preserves an assignment-like prefix', source: 'x={a,b}', words: ['x=a', 'x=b'] },
      { name: 'preserves a glob suffix', source: '{a,b}*', words: ['a*', 'b*'] }
    ]

    for (const { name, source, words: expected } of rows) {
      test(`expands ${source}: ${name}`, () => expectEchoWords(source, expected))
    }
  })

  describe('scenario 2: plain and unpaired braces stay literal', () => {
    const rows: Array<{ source: string; words: string[] }> = [
      { source: '{}', words: ['{}'] },
      { source: '{a}', words: ['{a}'] },
      { source: 'stash@{0}', words: ['stash@{0}'] },
      { source: 'HEAD@{upstream}', words: ['HEAD@{upstream}'] },
      { source: '{a,b', words: ['{a,b'] },
      { source: 'a,b}', words: ['a,b}'] },
      { source: '{a,{b}', words: ['{a,{b}'] },
      { source: '{a},{b}', words: ['{a},{b}'] },
      { source: '{a,b}}', words: ['a}', 'b}'] },
      { source: '{{a,b}', words: ['{a', '{b'] },
      { source: '{{{a,b}', words: ['{{a', '{{b'] },
      { source: '{a,{b,c}', words: ['{a,b', '{a,c'] },
      { source: '{{a,b},c', words: ['{a,c', '{b,c'] },
      { source: '{a,b}{', words: ['a{', 'b{'] },
      { source: '}{a,b}', words: ['}a', '}b'] },
      { source: '{a{b,c}}', words: ['{ab}', '{ac}'] },
      { source: '{a,{},b}', words: ['a', '{}', 'b'] },
      { source: '{a,{b},c}', words: ['a', '{b}', 'c'] },
      { source: '{a,b}{}', words: ['a{}', 'b{}'] }
    ]

    for (const { source, words: expected } of rows) {
      test(`preserves unmatched or plain braces in ${source}`, () => expectEchoWords(source, expected))
    }

    test('keeps spaces in a brace expression as ordinary word boundaries', () => {
      expect(parse('echo {a , b}')).toEqual(script([
        command(words('echo', '{a', ',', 'b}'))
      ]))
    })
  })

  describe('scenario 3: quoted and escaped syntax is inactive', () => {
    const rows: Array<{ source: string; words: string[] }> = [
      { source: "'{a,b}'", words: ['{a,b}'] },
      { source: '"{a,b}"', words: ['{a,b}'] },
      { source: '\\{a,b}', words: ['{a,b}'] },
      { source: '\\{a,b\\}', words: ['{a,b}'] },
      { source: '{a\\,b}', words: ['{a,b}'] },
      { source: '{a,b\\}', words: ['{a,b}'] },
      { source: "$'{a,b}'", words: ['{a,b}'] },
      { source: '{a,"b,c"}', words: ['a', 'b,c'] },
      { source: '"{a,b}"{c,d}', words: ['{a,b}c', '{a,b}d'] },
      { source: "{a,b}'{c,d}'", words: ['a{c,d}', 'b{c,d}'] },
      { source: '"a"{b,c}"d"', words: ['abd', 'acd'] },
      { source: '{a,b}\\ c', words: ['a c', 'b c'] },
      { source: '{\\{,a}', words: ['{', 'a'] },
      { source: '\\${a,b}', words: ['$a', '$b'] },
      { source: "'$'{a,b}", words: ['$a', '$b'] },
      { source: '"$"{a,b}', words: ['$a', '$b'] }
    ]

    for (const { source, words: expected } of rows) {
      test(`expands only active syntax in ${source}`, () => expectEchoWords(source, expected))
    }
  })

  describe('scenario 4: home and leading tilde resolve per produced word', () => {
    const rows: Array<{ source: string; words: string[] }> = [
      { source: '~/{a,b}', words: ['/home/u/a', '/home/u/b'] },
      { source: '$HOME/{a,b}', words: ['/home/u/a', '/home/u/b'] },
      { source: '${HOME}/{a,b}', words: ['/home/u/a', '/home/u/b'] },
      { source: '{~/a,~/b}', words: ['/home/u/a', '/home/u/b'] },
      { source: '~{/a,/b}', words: ['/home/u/a', '/home/u/b'] },
      { source: '{~,x}/y', words: ['/home/u/y', 'x/y'] },
      { source: '{,x}~/y', words: ['/home/u/y', 'x~/y'] },
      { source: "{'~',x}/y", words: ['~/y', 'x/y'] },
      { source: 'a{~,b}', words: ['a~', 'ab'] },
      { source: '${HOME}{a,b}', words: ['/home/ua', '/home/ub'] },
      { source: '"$HOME"{a,b}', words: ['/home/ua', '/home/ub'] }
    ]

    for (const { source, words: expected } of rows) {
      test(`resolves home values after expansion of ${source}`, () => expectEchoWords(source, expected))
    }
  })

  describe('scenario 5: unsupported brace words stay dynamic', () => {
    const dynamicWord = (source: string, text = source) => {
      expect(parse(`echo ${source}`)).toEqual(script([
        command([word('echo'), word(text, true)])
      ]))
    }

    const sequenceCases = [
      '{1..3}', 'a{1..3}', '{a..c}', '-{o..o}', '{01..03}', '{1..b}', '{a..}', '{..}',
      '{{1..3},x}', '{a,b}{1..2}', '{a..b}{c,d}'
    ]
    for (const source of sequenceCases) {
      test(`leaves sequence syntax dynamic in ${source}`, () => dynamicWord(source))
    }

    for (const source of ['{a,}', '{,}', '{,a}{,}']) {
      test(`leaves an expansion that could produce an empty word dynamic in ${source}`, () => dynamicWord(source))
    }

    test('exposes the supported brace-word limit', () => {
      expect(shellModule).toHaveProperty('MAX_BRACE_WORDS', 64)
    })

    const overLimitList = '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}'
    test('marks a product beyond MAX_BRACE_WORDS dynamic', () => dynamicWord(overLimitList))

    const sixtyFiveAlternatives = '{' + Array.from({ length: 65 }, (_, index) => `w${index}`).join(',') + '}'
    test('marks 65 alternatives dynamic', () => dynamicWord(sixtyFiveAlternatives))

    test('expands exactly MAX_BRACE_WORDS in left-to-right shell order', () => {
      const parsed = parse('echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}')
      const expanded = parsed?.commands[0]?.words.slice(1)
      expect(expanded).toHaveLength(64)
      expect(expanded?.every((item) => !item.dynamic)).toBe(true)
      expect([expanded?.[0]?.text, expanded?.at(-1)?.text]).toEqual(['acegik', 'bdfhjl'])
    })

    test('expands at MAX_SHELL_DEPTH but leaves deeper nesting dynamic', () => {
      const atLimit = '{a,'.repeat(MAX_SHELL_DEPTH) + 'b' + '}'.repeat(MAX_SHELL_DEPTH)
      expect(parse(`echo ${atLimit}`)).toEqual(script([
        command([word('echo'), ...Array.from({ length: MAX_SHELL_DEPTH }, () => word('a')), word('b')])
      ]))

      const tooDeep = '{a,'.repeat(MAX_SHELL_DEPTH + 1) + 'b' + '}'.repeat(MAX_SHELL_DEPTH + 1)
      expect(parse(`echo ${tooDeep}`)).toEqual(script([
        command([word('echo'), word(tooDeep, true)])
      ]))
    })

    for (const source of ['{~root,x}', '{~+,x}', '~{a,b}']) {
      test(`leaves dynamic tilde syntax unseen in ${source}`, () => dynamicWord(source))
    }

    const ambiguousHomeCases: Array<[string, string]> = [
      ['$HOME{a,b}', '$HOME{a,b}'],
      ["$HOME{'a',b}", '$HOME{a,b}'],
      ['{a,$HOME}x', '{a,$HOME}x'],
      ['{$HOME,a}/x', '{$HOME,a}/x'],
      ['{a,$HOME}', '{a,$HOME}']
    ]
    for (const [source, text] of ambiguousHomeCases) {
      test(`leaves an ambiguous unbraced HOME reference dynamic in ${source}`, () => dynamicWord(source, text))
    }

    for (const [source, text] of [
      ['{a,$X}', '{a,$X}'],
      ['{a,b}"$X"', '{a,b}$X']
    ]) {
      test(`does not partially expand a word dynamic for another reason: ${source}`, () => dynamicWord(source, text))
    }

    test('does not expand a brace list in a command-substitution word that is otherwise dynamic', () => {
      expect(parse('echo {a,b}$(echo x)')).toEqual(script([
        command(words('echo', 'x'), { scope: 1 }),
        command([word('echo'), word('{a,b}$(echo x)', true, [1])])
      ], [-1, 0]))
    })

    test('keeps known substitutions while falling back from an unsupported brace sequence', () => {
      expect(parse("echo {1..3}\"$(cat <<'EOF'\nx\nEOF\n)\"")).toEqual(script([
        command(words('cat'), {
          scope: 1,
          redirects: [redirect('heredoc', 'x\n')]
        }),
        command([
          word('echo'),
          word("{1..3}$(cat <<'EOF'\nx\nEOF\n)", true, [1])
        ])
      ], [-1, 0]))
    })
  })

  describe('scenario 6: expansion applies to command words and redirect targets only', () => {
    test('expands the command name and words after a prefix assignment', () => {
      expect(parse('X=1 {ls,-la}')).toEqual(script([
        command(words('ls', '-la'), { assignments: [assignment('X', '1')] })
      ]))
    })

    test('does not expand a prefix assignment value', () => {
      expect(parse('Y={a,b} ls')).toEqual(script([
        command(words('ls'), { assignments: [assignment('Y', '{a,b}')] })
      ]))
    })

    const redirectCases: Array<[string, ShellRedirect['kind'], string[]]> = [
      ['< {a,b}', 'read', ['a', 'b']],
      ['> {a,b}.txt', 'write', ['a.txt', 'b.txt']],
      ['>> {a,b}', 'write', ['a', 'b']],
      ['>| {a,b}', 'write', ['a', 'b']],
      ['<> {a,b}', 'write', ['a', 'b']],
      ['&> {a,b}', 'write', ['a', 'b']],
      ['&>> {a,b}', 'write', ['a', 'b']],
      ['>& {a,b}', 'write', ['a', 'b']],
      ['<& {a,b}', 'dup', ['a', 'b']]
    ]
    for (const [operatorAndTarget, kind, targets] of redirectCases) {
      test(`creates one ${kind} redirect per brace-expanded target for ${operatorAndTarget}`, () => {
        expect(parse(`echo hi ${operatorAndTarget}`)).toEqual(script([
          command(words('echo', 'hi'), { redirects: targets.map((target) => redirect(kind, target)) })
        ]))
      })
    }

    test('classifies each expanded descriptor or file target separately', () => {
      expect(parse('echo hi >& {1,out.txt}')).toEqual(script([
        command(words('echo', 'hi'), { redirects: [redirect('dup', '1'), redirect('write', 'out.txt')] })
      ]))
    })

    test('keeps a dynamic sequence or empty redirect target as one redirect', () => {
      expect(parse('echo hi > o{3..3}')).toEqual(script([
        command(words('echo', 'hi'), { redirects: [redirect('write', word('o{3..3}', true))] })
      ]))
      expect(parse('echo hi >> {a,}')).toEqual(script([
        command(words('echo', 'hi'), { redirects: [redirect('write', word('{a,}', true))] })
      ]))
    })

    test('does not expand a here-string word', () => {
      expect(parse('cat <<< {a,b}')).toEqual(script([
        command(words('cat'), { redirects: [redirect('heredoc', '{a,b}')] })
      ]))
    })

    test('does not expand a heredoc delimiter or its body', () => {
      expect(parse('cat <<{a,b}\n{x,y}\n{a,b}\n')).toEqual(script([
        command(words('cat'), { redirects: [redirect('heredoc', '{x,y}\n')] })
      ]))
    })

    test('does not expand brace-like text inside parameter or arithmetic expansions', () => {
      expect(parse('echo ${X:-{a,b}} $(({a,b}))')).toEqual(script([
        command([word('echo'), word('${X:-{a,b}}', true), word('$(({a,b}))', true)])
      ]))
    })

    const nestedScopeCases: Array<[string, ShellScript]> = [
      ['echo "$(ls {a,b})"', script([
        command(words('ls', 'a', 'b'), { scope: 1 }),
        command([word('echo'), word('$(ls {a,b})', true, [1])])
      ], [-1, 0])],
      ['echo "`ls {a,b}`"', script([
        command(words('ls', 'a', 'b'), { scope: 1 }),
        command([word('echo'), word('`ls {a,b}`', true, [1])])
      ], [-1, 0])],
      ['(ls {a,b})', script([
        command(words('ls', 'a', 'b'), { scope: 1 })
      ], [-1, 0])],
      ['echo <(ls {a,b})', script([
        command(words('ls', 'a', 'b'), { scope: 1 }),
        command([word('echo'), word('<(ls {a,b})', true, [1])])
      ], [-1, 0])],
      ['echo >(ls {a,b})', script([
        command(words('ls', 'a', 'b'), { scope: 1 }),
        command([word('echo'), word('>(ls {a,b})', true, [1])])
      ], [-1, 0])]
    ]
    for (const [source, expected] of nestedScopeCases) {
      test(`expands command words inside nested scope ${source}`, () => expect(parse(source)).toEqual(expected))
    }
  })

  describe('scenario 7: expanded words retain source substitutions', () => {
    test('copies a known substitution scope to every produced word', () => {
      expect(parse("echo {a,b}\"$(cat <<'EOF'\nx\nEOF\n)\"")).toEqual(script([
        command(words('cat'), {
          scope: 1,
          redirects: [redirect('heredoc', 'x\n')]
        }),
        command([
          word('echo'),
          word('ax', false, [1]),
          word('bx', false, [1])
        ])
      ], [-1, 0]))
    })
    test('does not reactivate braces produced by a known substitution', () => {
      expect(parse("echo \"$(cat <<'EOF'\n{a,b}\nEOF\n)\"{c,d}")).toEqual(script([
        command(words('cat'), {
          scope: 1,
          redirects: [redirect('heredoc', '{a,b}\n')]
        }),
        command([
          word('echo'),
          word('{a,b}c', false, [1]),
          word('{a,b}d', false, [1])
        ])
      ], [-1, 0]))
    })

    test('does not expand a leading tilde produced by a known substitution', () => {
      expect(parse("echo \"$(cat <<'EOF'\n~/x\nEOF\n)\"{a,b}")).toEqual(script([
        command(words('cat'), {
          scope: 1,
          redirects: [redirect('heredoc', '~/x\n')]
        }),
        command([
          word('echo'),
          word('~/xa', false, [1]),
          word('~/xb', false, [1])
        ])
      ], [-1, 0]))
    })
  })

  describe('scenario 8: brace parsing stays total and below the time bound', () => {
    const cases: Array<{
      name: string
      source: () => string
      assert: (parsed: ShellScript) => void
    }> = [
      {
        name: '240,000 unmatched opening braces',
        source: () => 'echo ' + '{'.repeat(240_000),
        assert: (parsed) => {
          const item = parsed.commands[0]?.words[1]
          expect(parsed.commands[0]?.words).toHaveLength(2)
          expect(item?.text).toHaveLength(240_000)
          expect(item?.dynamic).toBe(false)
        }
      },
      {
        name: '48,000 adjacent brace lists',
        source: () => 'echo ' + '{a,b}'.repeat(48_000),
        assert: (parsed) => {
          const item = parsed.commands[0]?.words[1]
          expect(parsed.commands[0]?.words).toHaveLength(2)
          expect(item?.dynamic).toBe(true)
          expect(item?.text).toBe('{a,b}'.repeat(48_000))
        }
      },
      {
        name: '120,001 alternatives in one list',
        source: () => 'echo {' + 'a,'.repeat(120_000) + 'b}',
        assert: (parsed) => {
          const item = parsed.commands[0]?.words[1]
          expect(parsed.commands[0]?.words).toHaveLength(2)
          expect(item?.dynamic).toBe(true)
          expect(item?.text).toBe('{' + 'a,'.repeat(120_000) + 'b}')
        }
      },
      {
        name: '100,000 nested brace groups',
        source: () => 'echo ' + '{a,'.repeat(100_000) + 'b' + '}'.repeat(100_000),
        assert: (parsed) => {
          const item = parsed.commands[0]?.words[1]
          expect(parsed.commands[0]?.words).toHaveLength(2)
          expect(item?.dynamic).toBe(true)
        }
      },
      {
        name: '120,000 nested plain groups',
        source: () => 'echo ' + '{'.repeat(120_000) + '}'.repeat(120_000),
        assert: (parsed) => {
          const item = parsed.commands[0]?.words[1]
          expect(parsed.commands[0]?.words).toHaveLength(2)
          expect(item?.dynamic).toBe(true)
        }
      },
      {
        name: '200,000 plain groups followed by one list',
        source: () => 'echo ' + '{x}'.repeat(200_000) + '{a,b}',
        assert: (parsed) => {
          const items = parsed.commands[0]?.words.slice(1)
          expect(items).toHaveLength(2)
          expect(items?.map((item) => item.text.length)).toEqual([600_001, 600_001])
          expect(items?.map((item) => item.text.slice(-1))).toEqual(['a', 'b'])
          expect(items?.every((item) => !item.dynamic)).toBe(true)
        }
      },
      {
        name: '340,000 words from repeated brace lists',
        source: () => 'echo ' + '{a,b} '.repeat(170_000),
        assert: (parsed) => {
          const items = parsed.commands[0]?.words.slice(1)
          expect(items).toHaveLength(340_000)
          expect(items?.slice(0, 4).map((item) => item.text)).toEqual(['a', 'b', 'a', 'b'])
          expect(items?.slice(-2).map((item) => item.text)).toEqual(['a', 'b'])
        }
      },
      {
        name: '57,600 products of six brace lists',
        source: () => 'echo ' + ('x'.repeat(1_000) + '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l} ').repeat(900),
        assert: (parsed) => {
          const items = parsed.commands[0]?.words.slice(1)
          expect(items).toHaveLength(57_600)
          expect(items?.[0]?.text).toBe('x'.repeat(1_000) + 'acegik')
          expect(items?.at(-1)?.text).toBe('x'.repeat(1_000) + 'bdfhjl')
        }
      }
    ]

    for (const { name, source, assert } of cases) {
      test(`parses ${name} in under 1000 ms`, () => {
        const input = source()
        const started = performance.now()
        const parsed = parse(input)
        const elapsed = performance.now() - started
        expect(parsed).not.toBeNull()
        expect(elapsed).toBeLessThan(1_000)
        if (parsed === null) throw new Error('parseShell returned null')
        assert(parsed)
      })
    }
  })
})
