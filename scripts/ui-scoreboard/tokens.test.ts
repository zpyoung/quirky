import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_IDS, type Inventory, type PluginInventory, type SourceFile } from './contracts'
import { checkHostTokens, checkPlugin, scanTokens, sharedTokenEvidence } from './tokens'

const source = (file: string, content: string): SourceFile => ({ file, content })

function plugin(overrides: Partial<PluginInventory> = {}): PluginInventory {
  return {
    id: 'acme.app',
    directory: 'plugins/acme.app',
    hasUi: true,
    targets: ['view:acme.app/main'],
    sources: [],
    ...overrides
  }
}

function inventory(plugins: PluginInventory[], sharedSources: SourceFile[] = []): Inventory {
  return {
    repoRoot: '/repo',
    commit: 'test-commit',
    sourceDigest: 'test-digest',
    dirty: false,
    plugins,
    targets: [],
    sharedSources,
    exclusions: [],
    failures: []
  }
}

function checkById<T extends { id: string }>(checks: T[], id: string): T {
  const result = checks.find((check) => check.id === id)
  expect(result).toBeDefined()
  return result!
}

function locationAt(file: string, content: string, offset: number) {
  const before = content.slice(0, offset)
  const newline = before.lastIndexOf('\n')
  return { file, line: before.split('\n').length, column: offset - newline }
}

describe('compatibility token scanning', () => {
  test('reports literal names in nested values with repository-relative positions', () => {
    const file = 'plugins/acme.app/src/view.tsx'
    const content = [
      'export const style = {',
      '  padding: "var(--compat-px-40)",',
      '  width: "calc(2 * var(--compat-px-20))",',
      '  color: "var(--compat-text-muted, var(--ui-surface))"',
      '}'
    ].join('\n')
    const evidence = scanTokens(source(file, content))

    for (const token of ['--compat-px-40', '--compat-px-20', '--compat-text-muted']) {
      const offset = content.indexOf(token)
      expect(evidence).toContainEqual(expect.objectContaining({ message: expect.stringContaining(token), source: locationAt(file, content, offset) }))
    }
    expect(evidence).toHaveLength(3)
  })

  test('ignores JavaScript comments while retaining literal positions', () => {
    const file = 'plugins/acme.app/src/view.tsx'
    const content = [
      '// --compat-px-40',
      '/* var(--compat-px-32) */',
      'const style = { padding: "var(--compat-px-16)" }'
    ].join('\n')
    const evidence = scanTokens(source(file, content))
    const offset = content.indexOf('--compat-px-16')

    expect(evidence).toHaveLength(1)
    expect(evidence[0]!).toMatchObject({ message: expect.stringContaining('--compat-px-16'), source: locationAt(file, content, offset) })
  })

  test('masks CSS and HTML comments without shifting source locations', () => {
    const cssFile = 'plugins/acme.app/src/view.css'
    const css = '/* --compat-px-40\n * --compat-px-32\n */ .row { color: var(--compat-px-16); }'
    const cssOffset = css.indexOf('--compat-px-16')
    const cssEvidence = scanTokens(source(cssFile, css))
    const htmlFile = 'plugins/acme.app/src/view.html'
    const html = '<!-- var(--compat-px-40) -->\n<div style="color: var(--compat-px-8)"></div>'
    const htmlOffset = html.indexOf('--compat-px-8')
    const htmlEvidence = scanTokens(source(htmlFile, html))

    expect(cssEvidence).toHaveLength(1)
    expect(cssEvidence[0]!.source).toEqual(locationAt(cssFile, css, cssOffset))
    expect(htmlEvidence).toHaveLength(1)
    expect(htmlEvidence[0]!.source).toEqual(locationAt(htmlFile, html, htmlOffset))
  })

  test('ignores SCSS line comments while preserving later source positions', () => {
    const file = 'plugins/acme.app/src/theme.scss'
    const content = '// --compat-px-40\n.row { color: var(--compat-px-16); }'
    const offset = content.indexOf('--compat-px-16')
    const evidence = scanTokens(source(file, content))

    expect(evidence).toHaveLength(1)
    expect(evidence[0]!.source).toEqual(locationAt(file, content, offset))
  })

  test('does not mask comment markers inside quoted CSS content', () => {
    const file = 'packages/ui/src/generated/content.css'
    const content = 'a::before { content: \"/*--compat-px-40*/\"; }'
    const offset = content.indexOf('--compat-px-40')
    const evidence = scanTokens(source(file, content))

    expect(evidence).toHaveLength(1)
    expect(evidence[0]!.source).toEqual(locationAt(file, content, offset))
  })
  test('finds source after more than one mebibyte of harmless input', () => {
    const file = 'plugins/acme.app/src/large.ts'
    const content = `//${'x'.repeat(1024 * 1024 + 17)}\nconst style = 'var(--compat-px-40)'`
    const offset = content.indexOf('--compat-px-40')
    const evidence = scanTokens(source(file, content))

    expect(evidence).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('--compat-px-40'),
      source: locationAt(file, content, offset)
    }))
  })

  const javascriptExtensions: Record<string, true> = { '.ts': true, '.tsx': true, '.js': true, '.jsx': true, '.mts': true, '.cts': true, '.mjs': true, '.cjs': true }
  const htmlExtensions: Record<string, true> = { '.html': true, '.htm': true, '.svg': true }
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.html', '.htm', '.svg', '.css', '.scss', '.sass', '.less']

  for (const extension of extensions) {
    test(`scans ${extension}`, () => {
      const content = extension in javascriptExtensions
        ? 'const style = "var(--compat-px-40)"'
        : extension in htmlExtensions
          ? '<div style="color: var(--compat-px-40)"></div>'
          : '.row { color: var(--compat-px-40); }'

      expect(scanTokens(source(`plugins/acme.app/src/probe${extension}`, content))).toHaveLength(1)
    })
  }

  test('ignores non-source files and excluded test, fixture, and build trees', () => {
    expect(scanTokens(source('plugins/acme.app/README.md', 'var(--compat-px-40)'))).toEqual([])

    for (const directory of ['node_modules', 'vendor', 'dist', 'build', 'coverage', '.git', 'test', 'tests', '__tests__', '__test__', '_test', '_tests', 'fixture', 'fixtures', '__fixtures__', '_fixtures']) {
      expect(scanTokens(source(`plugins/acme.app/src/${directory}/probe.tsx`, 'const style = "var(--compat-px-40)"'))).toEqual([])
    }
  })

  test('does not treat compatibility definitions or their stylesheet import as consumption', () => {
    const definition = source('packages/ui/src/design-system/compatibility-tokens.css', ':root { --compat-px-40: 40px; }')
    const loader = source('packages/ui/src/styles.css', '@import "./design-system/compatibility-tokens.css";')

    expect(scanTokens(definition)).toEqual([])
    expect(scanTokens(loader)).toEqual([])
    expect(sharedTokenEvidence(inventory([], [definition, loader]))).toEqual([])
  })

  test('accepts literal semantic names and safe hue and tile templates', () => {
    const content = [
      'const surface = "var(--ui-surface)"',
      'const space = "var(--ui-space-16)"',
      'const hue = `var(--ui-hue-${hueName})`',
      'const tile = `var(--ui-tile-${tileIndex(name)})`',
      'const width = `${size}px`',
      'const calculation = `calc(${size}px * 2)`'
    ].join('\n')

    expect(scanTokens(source('plugins/acme.app/src/semantic.tsx', content))).toEqual([])
  })

  test('accepts literal member and index access through an imported UI token catalog', () => {
    const content = [
      "import { uiTokens as tokens } from '@quirky/ui'",
      'const surface = `var(${tokens.color.surface})`',
      'const space = `var(${tokens.space[16]})`',
      'const row = `var(${tokens.row.double})`'
    ].join('\n')

    expect(scanTokens(source('plugins/acme.app/src/semantic.tsx', content))).toEqual([])
  })

  test('rejects unknown, shadowed, and non-direct token catalog bindings as unresolved', () => {
    const cases = [
      {
        file: 'plugins/acme.app/src/unknown.tsx',
        content: "import { uiTokens } from '@quirky/ui'\nconst style = `var(${uiTokens.color.unknown})`"
      },
      {
        file: 'plugins/acme.app/src/shadowed.tsx',
        content: "import { uiTokens } from '@quirky/ui'\nfunction style(uiTokens: unknown) { return `var(${uiTokens.color.surface})` }"
      },
      {
        file: 'plugins/acme.app/src/var-shadowed.tsx',
        content: "import { uiTokens } from '@quirky/ui'\nfunction style() { if (true) { var uiTokens = {} } return `var(${uiTokens.color.accent})` }"
      },
      {
        file: 'plugins/acme.app/src/switch-same-case.ts',
        content: "import { uiTokens } from '@quirky/ui'\nfunction style(replacement, kind) { switch (kind) { case 1: const uiTokens = replacement; return `var(${uiTokens.color.surface})`; } }"
      },
      {
        file: 'plugins/acme.app/src/switch-other-case.ts',
        content: "import { uiTokens } from '@quirky/ui'\nfunction style(replacement, kind) { switch (kind) { case 1: return `var(${uiTokens.color.surface})`; case 2: const uiTokens = replacement; break; } }"
      },
      {
        file: 'plugins/acme.app/src/indirect.tsx',
        content: "import { uiTokens } from './tokens'\nconst style = `var(${uiTokens.color.surface})`"
      }
    ]

    for (const item of cases) {
      expect(scanTokens(source(item.file, item.content))).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unresolved-style-token', source: expect.any(Object) })
      ]))
    }
  })

  test('marks escaped, concatenated, and dynamic compatibility fragments unresolved', () => {
    const cases = [
      {
        file: 'plugins/acme.app/src/concatenated.ts',
        content: "const style = 'var(--com' + 'pat-px-40)'"
      },
      {
        file: 'plugins/acme.app/src/dynamic.ts',
        content: 'const style = `var(--compat-px-${size})`'
      },
      {
        file: 'plugins/acme.app/src/partial.ts',
        content: 'const property = `--compat-${name}`'
      },
      {
        file: 'plugins/acme.app/src/js-escaped.ts',
        content: "const style = 'var(\\x2d\\x2dcompat-px-40)'"
      },
      {
        file: 'plugins/acme.app/src/css-escaped.css',
        content: 'a { color: var(--compat-px-\\34 0); }'
      }
    ]

    for (const item of cases) {
      const evidence = scanTokens(source(item.file, item.content))
      expect(evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unresolved-style-token', source: expect.any(Object) })
      ]))
    }
  })

  test('rejects CSS escapes in JavaScript strings and template segments without decoding them', () => {
    const cases = [
      {
        file: 'plugins/acme.app/src/css-escaped-string.ts',
        content: 'const style = "var(--\\\\63ompat-px-40)"'
      },
      {
        file: 'plugins/acme.app/src/css-escaped-template.ts',
        content: 'const style = `var(--\\\\63ompat-px-40)`'
      }
    ]

    for (const item of cases) {
      expect(scanTokens(source(item.file, item.content))).toContainEqual(
        expect.objectContaining({ code: 'unresolved-style-token' })
      )
    }
  })

  test('rejects visible dynamic custom-property prefixes but accepts numeric interpolation', () => {
    for (const content of ['const property = `--${prefix}`', 'const property = ` --${x}`', 'const style = `{--${x}: 1}`']) {
      expect(scanTokens(source('plugins/acme.app/src/dynamic-property.ts', content))).toContainEqual(
        expect.objectContaining({ code: 'unresolved-style-token' })
      )
    }
    expect(scanTokens(source('plugins/acme.app/src/numeric-property.ts', 'const width = `${size}px`'))).toEqual([])
  })

  test('accepts a BEM modifier in a plain template literal', () => {
    expect(scanTokens(source('plugins/acme.app/src/bem.ts', 'const c = `ui-button--${variant}`'))).toEqual([])
  })

  test('accepts BEM modifier templates in JSX className', () => {
    expect(scanTokens(source('plugins/acme.app/src/bem.tsx', 'const View = () => <span className={`git-row__status git-row__status--${tone}`} />'))).toEqual([])
  })

  test('treats arbitrary JavaScript escape spellings as unresolved', () => {
    const content = "const style = 'var(\\u002d\\x2dcompat-px-40)'"
    const evidence = scanTokens(source('plugins/acme.app/src/arbitrary-escape.ts', content))

    expect(evidence).toContainEqual(expect.objectContaining({ code: 'unresolved-style-token' }))
  })

  test('rejects escaped CSS and HTML var arguments without decoding them', () => {
    const css = 'a { color: var(\\00002d\\00002dcompat-px-40); }'
    const html = '<div style="color: var(--ui-\\66oo)"></div>'
    const cssEvidence = scanTokens(source('plugins/acme.app/src/escaped-var.css', css))
    const htmlEvidence = scanTokens(source('plugins/acme.app/src/escaped-var.html', html))

    expect(cssEvidence).toContainEqual(expect.objectContaining({ code: 'unresolved-style-token' }))
    expect(htmlEvidence).toContainEqual(expect.objectContaining({ code: 'unresolved-style-token' }))
  })
  test('rejects visible dynamic var arguments assembled through concatenation', () => {
    const cases = [
      "const css = 'var(' + unknownToken + ')'",
      "const css = 'var(--' + fragment + ')'"
    ]

    for (const content of cases) {
      expect(scanTokens(source('plugins/acme.app/src/dynamic-concat.ts', content))).toContainEqual(
        expect.objectContaining({ code: 'unresolved-style-token' })
      )
    }
  })
})

describe('scoreboard token checks', () => {
  test('returns the five static checks in contract order and never adds screenshots', () => {
    const checks = checkPlugin(inventory([plugin()]), 'acme.app')

    expect(checks.map(({ id }) => id)).toEqual(CHECK_IDS.filter((id) => id !== 'screenshots'))
    expect(checks).toHaveLength(5)
  })

  test('shares shared-CSS token findings with UI plugins and the host exactly once', () => {
    const shared = source('packages/ui/src/design-system/tasks-detail.css', '.task { color: var(--compat-px-40); padding: var(--compat-px-16); }')
    const uiPlugin = plugin({ sources: [source('plugins/acme.app/src/ui.tsx', 'const color = "var(--ui-surface)"')] })
    const daemon = plugin({
      id: 'acme.daemon',
      hasUi: false,
      targets: [],
      sources: [source('plugins/acme.daemon/src/index.ts', 'const color = "var(--compat-px-16)"')]
    })
    const data = inventory([uiPlugin, daemon], [shared])
    const sharedEvidence = sharedTokenEvidence(data)
    const uiTokenCheck = checkById(checkPlugin(data, uiPlugin.id), 'compatibility-tokens')
    const daemonTokenCheck = checkById(checkPlugin(data, daemon.id), 'compatibility-tokens')
    const hostTokenCheck = checkHostTokens(data)
    const sharedReferences = uiTokenCheck.evidence.filter((item) => item.sharedEvidence === 'compatibility-tokens')

    expect(sharedEvidence).toHaveLength(2)
    expect(sharedEvidence[0]!.source).toEqual(locationAt(shared.file, shared.content, shared.content.indexOf('--compat-px-40')))
    expect(uiTokenCheck.status).toBe('fail')
    expect(sharedReferences).toHaveLength(1)
    expect(sharedReferences).toEqual([
      expect.objectContaining({ code: 'shared-compatibility-tokens', sharedEvidence: 'compatibility-tokens' })
    ])
    expect(sharedReferences[0]!.source).toBeUndefined()
    expect(daemonTokenCheck.status).toBe('fail')
    expect(daemonTokenCheck.evidence.some((item) => item.source?.file === daemon.sources[0]!.file)).toBe(true)
    expect(daemonTokenCheck.evidence.some((item) => item.sharedEvidence === 'compatibility-tokens')).toBe(false)
    expect(hostTokenCheck).toMatchObject({ id: 'compatibility-tokens', status: 'fail', applicable: true })
    expect(hostTokenCheck.evidence).toEqual([
      expect.objectContaining({ code: 'shared-compatibility-tokens', sharedEvidence: 'compatibility-tokens' })
    ])
  })

  test('host token checks pass without shared findings', () => {
    const check = checkHostTokens(inventory([], [source('packages/ui/src/styles.css', '.x { color: var(--ui-surface); }')]))

    expect(check).toMatchObject({ id: 'compatibility-tokens', status: 'pass', applicable: true })
    expect(check.evidence).toEqual([])
  })

  test('a compatibility use moved into shared CSS still fails every UI token check', () => {
    const shared = source('packages/ui/src/shell/tool-shell.css', '.toolbar { padding: var(--compat-px-24); }')
    const uiPlugin = plugin({ hasUi: false, targets: ['panel:acme.app/main'] })
    const data = inventory([uiPlugin], [shared])
    const tokenCheck = checkById(checkPlugin(data, uiPlugin.id), 'compatibility-tokens')

    const sharedEvidence = sharedTokenEvidence(data)

    expect(tokenCheck.status).toBe('fail')
    expect(sharedEvidence).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ file: shared.file }) }))
    expect(tokenCheck.evidence).toContainEqual(expect.objectContaining({
      code: 'shared-compatibility-tokens',
      sharedEvidence: 'compatibility-tokens'
    }))
    expect(tokenCheck.evidence.filter((item) => item.sharedEvidence === 'compatibility-tokens')).toHaveLength(1)
    expect(tokenCheck.evidence.filter((item) => item.sharedEvidence === 'compatibility-tokens')[0]!.source).toBeUndefined()
  })

  test('a daemon-only plugin scans its own source without inheriting shared findings', () => {
    const daemon = plugin({
      id: 'acme.service',
      hasUi: false,
      targets: [],
      sources: [source('plugins/acme.service/src/index.ts', 'const token = "var(--compat-px-40)"')]
    })
    const data = inventory([daemon], [source('packages/ui/src/styles.css', '.x { color: var(--compat-px-16); }')])
    const tokenCheck = checkById(checkPlugin(data, daemon.id), 'compatibility-tokens')

    expect(tokenCheck.status).toBe('fail')
    expect(tokenCheck.evidence.some((item) => item.source?.file === daemon.sources[0]!.file)).toBe(true)
    expect(tokenCheck.evidence.some((item) => item.sharedEvidence === 'compatibility-tokens')).toBe(false)
  })

  test('reports not-implemented states and commands despite coverage and twenty declarations', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-scoreboard-token-tests-'))
    const directory = join(root, 'plugins/acme.app')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'quirky-plugin.json'), JSON.stringify({
      id: 'acme.app',
      ui: 'dist/ui.js',
      commands: Array.from({ length: 20 }, (_, index) => ({ id: `command-${index}` }))
    }))
    writeFileSync(join(directory, 'ui-scoreboard.json'), JSON.stringify({
      loading: { status: 'pass' },
      empty: { status: 'pass' },
      error: { status: 'pass' },
      commands: { status: 'pass' }
    }))

    try {
      const uiPlugin = plugin({ directory, hasUi: true, targets: [] })
      const checks = checkPlugin(inventory([uiPlugin]), uiPlugin.id)

      for (const id of ['loading', 'empty', 'error', 'commands']) {
        const check = checkById(checks, id)
        expect(check).toMatchObject({ status: 'fail', applicable: true })
        expect(check.reason).toBe('not-implemented')
        expect(check.evidence).toContainEqual(expect.objectContaining({ code: 'not-implemented' }))
        expect(check.evidence.some((item) => /source-audit follow-up/i.test(item.message))).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('marks no-surface state and action checks not applicable', () => {
    const daemon = plugin({ id: 'acme.service', hasUi: false, targets: [], sources: [] })
    const checks = checkPlugin(inventory([daemon]), daemon.id)

    for (const id of ['loading', 'empty', 'error', 'commands']) {
      expect(checkById(checks, id)).toMatchObject({ status: 'pass', applicable: false, reason: 'no-ui-surface' })
    }
  })
})
