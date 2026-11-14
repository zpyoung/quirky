import { describe, expect, test } from 'bun:test'
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
  test('ignores escaped CSS-looking syntax in non-style CLI, markdown, and method-call literals', () => {
    const content = [
      "const args = ['tool --query=\\${filter}']",
      "const prompt = `Use --spec\\u0060 as the markdown delimiter`",
      "text.replace('var(\\x2d\\x2dcompat-px-40)', 'replacement')",
      "array.append('var(\\x2d\\x2dcompat-px-40)')"
    ].join('\n')

    expect(scanTokens(source('plugins/acme.app/src/prompts.ts', content))).toEqual([])
  })
  test('reports escaped CSS in multiline JSX style text at its source location', () => {
    const file = 'plugins/acme.app/src/style-text.tsx'
    const content = [
      'const prefix = 1',
      'const View = () => (',
      '  <style>',
      '    .button {',
      '      color: var(\\2d\\2dcompat-px-40);',
      '    }',
      '  </style>',
      ')'
    ].join('\n')
    const offset = content.indexOf('\\2d\\2dcompat-px-40')
    const evidence = scanTokens(source(file, content))

    expect(evidence).toContainEqual(expect.objectContaining({
      code: 'unresolved-style-token',
      source: locationAt(file, content, offset)
    }))
  })


  test('scans escaped CSS tokens throughout named style contexts', () => {
    const slash = '\\'
    const escapedToken = `var(${slash}x2d${slash}x2dcompat-px-40)`
    const cssEscapedToken = `var(${slash}2d${slash}2dcompat-px-40)`
    const escapedClass = `--ui-${slash}x66oo`
    const jsString = (value: string) => `'${value}'`
    const tagged = (tag: string, body: string) => `const themed = ${tag}\`${body}\``
    const cases: [string, string][] = [
      ['JSX style prop', `const View = () => <div style={{ color: ${jsString(escapedToken)} }} />`],
      ['JSX className prop', `<div className="button ${escapedClass}" />`],
      ['SVG presentation prop', `<svg><path fill="var(${slash}2d${slash}2dcompat-px-40)" /></svg>`],
      ['style element text', `<style>.x { color: ${cssEscapedToken}; }</style>`],
      ['css tagged template', tagged('css', `.x { color: ${cssEscapedToken}; }`)],
      ['style tagged template', tagged('style', `.x { color: ${cssEscapedToken}; }`)],
      ['stylesheet tagged template', tagged('stylesheet', `.x { color: ${cssEscapedToken}; }`)],
      ['keyframes tagged template', tagged('keyframes', `from { color: ${cssEscapedToken}; }`)],
      ['styled component template', tagged('styled.button', `.x { color: ${cssEscapedToken}; }`)],
      ['style object property', `const options = { style: { color: ${jsString(escapedToken)} } }`],
      ['nested styles object', `const options = { styles: { root: { color: ${jsString(escapedToken)} } } }`],
      ['custom property object key', `const options = { '--ui-theme': { color: ${jsString(escapedToken)} } }`],
      ...['style', 'styles', 'css', 'cssText', 'className', 'classes', 'stylesheet', 'paneStyles', 'rootStyle', 'buttonClassName', '_style']
        .map((name): [string, string] => [`${name} variable binding`, `const ${name} = { color: ${jsString(escapedToken)} }`]),
      ['JSX-bound style variable', `const custom = { color: ${jsString(escapedToken)} }; const View = () => <div style={custom} />`],
      ['Object.assign-bound style variable', `const custom = { color: ${jsString(escapedToken)} }; Object.assign(element.style, custom)`],
      ['createElement-bound style variable', `const custom = { color: ${jsString(escapedToken)} }; React.createElement('div', { style: custom })`],
      ['CSSProperties annotation', `const themed: CSSProperties = { color: ${jsString(escapedToken)} }`],
      ['CSSProperties satisfies expression', `const themed = { color: ${jsString(escapedToken)} } satisfies CSSProperties`],
      ['CSSProperties assertion', `const themed = ({ color: ${jsString(escapedToken)} } as CSSProperties)`],
      ['Record CSSProperties expression', `const themes = { root: { color: ${jsString(escapedToken)} } } satisfies Record<string, CSSProperties>`],
      ['DOM style property', `element.style.color = ${jsString(escapedToken)}`],
      ['CSSStyleDeclaration setProperty', `element.style.setProperty('color', ${jsString(escapedToken)})`],
      ['Object.assign DOM style', `Object.assign(element.style, { color: ${jsString(escapedToken)} })`],
      ['style setAttribute', `element.setAttribute('style', ${jsString(`color: ${escapedToken}`)})`],
      ['fill setAttribute', `element.setAttribute('fill', ${jsString(escapedToken)})`],
      ['className assignment', `element.className = '${escapedClass}'`],
      ['classList method', `element.classList.add('${escapedClass}')`],
      ['style element textContent', `const sheet = document.createElement('style'); sheet.textContent = ${jsString(`.x { color: ${escapedToken}; }`)}`],
      ['style element innerHTML', `const sheet = document.createElement('style'); sheet.innerHTML = ${jsString(`.x { color: ${escapedToken}; }`)}`],
      ['style element append', `const sheet = document.createElement('style'); sheet.append(${jsString(`.x { color: ${escapedToken}; }`)})`],
      ['CSSStyleSheet replace', `sheet.replace(${jsString(`.x { color: ${escapedToken}; }`)})`],
      ['CSSStyleSheet replaceSync', `sheet.replaceSync(${jsString(`.x { color: ${escapedToken}; }`)})`],
      ['CSSStyleSheet insertRule', `sheet.insertRule(${jsString(`.x { color: ${escapedToken}; }`)})`],
      ['CSSStyleSheet addRule', `sheet.addRule('.x', ${jsString(`color: ${escapedToken};`)})`],
      ['constructed CSSStyleSheet', `const theme = new CSSStyleSheet(); theme.replaceSync(${jsString(escapedToken)})`],
      ['EditorView.theme', `EditorView.theme({ '&': { color: ${jsString(escapedToken)} } })`],
      ['HighlightStyle.define', `HighlightStyle.define([{ tag: tags.keyword, color: ${jsString(escapedToken)} }])`]
    ]

    for (const [context, content] of cases) {
      expect(scanTokens(source('plugins/acme.app/src/style-context.tsx', content)), context).toContainEqual(
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

  test.each([
    ['throw', 'throw new UsageError(`--${name} must be a number`);'],
    ['map', 'flags.map((name) => `--${name}`);'],
    ['array', "['pr', 'merge', `--${method}`];"],
    ['call', 'ctx.fail(`could not read --${name}: ${reason}`);'],
    ['arrow', 'const flag = (name) => `--${name}`;'],
    ['jsx', 'const View = () => <span className={`--${name}`} />;']
  ])('ignores dynamic flag text in a %s position', (_position, content) => {
    expect(scanTokens(source('plugins/acme.app/src/flag-text.tsx', content))).toEqual([])
  })

  test.each([
    ['element access', 'vars[`--${token}`];'],
    ['computed property', '({ [`--${token}`]: value });'],
    ['setProperty', 'style.setProperty(`--${token}`, value);'],
    ['getPropertyValue', 'style.getPropertyValue(`--${token}`);'],
    ['computed method', 'style["setProperty"](`--${token}`, value);'],
    ['removeProperty', 'style.removeProperty(`--${token}`);']
  ])('rejects a dynamic custom-property name in %s', (_position, content) => {
    expect(scanTokens(source('plugins/acme.app/src/property-name.ts', content))).toContainEqual(
      expect.objectContaining({ code: 'unresolved-style-token', message: 'Unresolved dynamic custom-property name' })
    )
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

  test('rejects fake pass flags despite twenty declarations', () => {
    const uiPlugin = plugin({
      sources: [source('plugins/acme.app/src/ui.tsx', '<button onClick={() => save()}>Save</button>')],
      coverage: { file: 'plugins/acme.app/ui-scoreboard.json', content: JSON.stringify({
        loading: { status: 'pass' }, empty: { status: 'pass' }, error: { status: 'pass' }, commands: { status: 'pass' }
      }) },
      contributions: { methods: Array.from({ length: 20 }, (_, index) => `acme.app/method-${index}`), commands: [], cliCommands: [] }
    })
    const checks = checkPlugin(inventory([uiPlugin]), uiPlugin.id)
    for (const id of ['loading', 'empty', 'error', 'commands']) {
      expect(checkById(checks, id)).toMatchObject({ status: 'fail', applicable: true, reason: 'coverage-file-invalid' })
      expect(checkById(checks, id).evidence).toContainEqual(expect.objectContaining({ code: 'coverage-file-invalid' }))
    }
    expect(checkById(checks, 'commands').evidence).toContainEqual(expect.objectContaining({ code: 'coverage-missing' }))
  })

  test('marks no-surface state and action checks not applicable', () => {
    const daemon = plugin({ id: 'acme.service', hasUi: false, targets: [], sources: [] })
    const checks = checkPlugin(inventory([daemon]), daemon.id)

    for (const id of ['loading', 'empty', 'error', 'commands']) {
      expect(checkById(checks, id)).toMatchObject({ status: 'pass', applicable: false, reason: 'no-ui-surface' })
    }
  })
})
