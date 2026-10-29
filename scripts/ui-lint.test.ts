import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { formatDiagnostic, parsePluginConfig, runUiLint, scanSourceContent } from './ui-lint'

function rules(source: string, file: string, options: { plugin?: boolean } = {}) {
  return scanSourceContent(file, source, options).map(({ rule }) => rule)
}

test('CSS scanner finds raw style colors and pixel dimensions but ignores comments, strings, URLs, and non-style syntax', () => {
  const source = `/* color: red; padding: 91px */\n.card {\n  color: #ff0000;\n  padding: 13px;\n  margin: 0px;\n  grid-template-columns: minmax(0, 1fr) 30%;\n  background-image: url("icons/#fff.svg");\n  content: "red 42px";\n}`
  const diagnostics = scanSourceContent('src/view.css', source)
  expect(diagnostics.map(({ rule }) => rule)).toEqual(['ui/no-raw-color', 'ui/no-raw-pixel'])
  expect(diagnostics.map(formatDiagnostic)).toEqual([
    'src/view.css:3:10 ui/no-raw-color: Replace raw color literals with semantic UI tokens.',
    'src/view.css:4:12 ui/no-raw-pixel: Replace raw pixel dimensions with semantic UI tokens.'
  ])
  expect(rules('.x { color/**/: red; }', 'src/comment.css')).toEqual(['ui/no-raw-color'])
})

test('CSS scanner resumes after sibling rules and nested groups', () => {
  const source = '.safe { color: var(--ui-text); }\n.bad { color: red; }\n@media (width > 30em) { .nested { padding: 13px; } .later { color: blue; } }\n.last { margin: 7px; }'
  const diagnostics = scanSourceContent('src/siblings.css', source)
  expect(diagnostics.map(({ rule, line }) => [rule, line])).toEqual([
    ['ui/no-raw-color', 2],
    ['ui/no-raw-pixel', 3],
    ['ui/no-raw-color', 3],
    ['ui/no-raw-pixel', 4]
  ])
})

test('only canonical primitive custom-property values may define raw colors and pixels', () => {
  const source = ':root { --surface: #101010; --rail-width: 13px; color: red; padding: 4px; }'
  expect(rules(source, 'packages/ui/src/design-system/tokens.css')).toEqual([
    'ui/no-raw-color',
    'ui/no-raw-pixel'
  ])
  expect(rules(source, 'packages/ui/src/design-system/compatibility-tokens.css')).toEqual([
    'ui/no-raw-color',
    'ui/no-raw-pixel'
  ])
  expect(rules(source, 'packages/ui/src/styles.css')).toHaveLength(4)
})

test('TypeScript scanner checks inline styles and referenced style maps, not ordinary data or prose', () => {
  const source = `const styleMap = { padding: 13, background: '#ff0000' }\nconst data = { color: '#00ff00' }\nconst prose = 'red #000 20px'\nconst valid = { opacity: 0.5, lineHeight: 1.2, width: 0, height: '100%', gridTemplateColumns: '1fr' }\nconst view = <div style={{ color: 'var(--ui-text)', ...valid, borderWidth: 2 }} />\nconst other = <div style={styleMap} />`
  const diagnostics = scanSourceContent('src/view.tsx', source)
  expect(diagnostics.map(({ rule }) => rule)).toEqual(['ui/no-raw-pixel', 'ui/no-raw-color', 'ui/no-raw-pixel'])
  expect(diagnostics.map(({ line, column }) => [line, column])).toEqual([[1, 29], [1, 46], [5, 76]])
})

test('CodeMirror theme declaration objects are style contexts while neighboring color data is not', () => {
  const source = `const palette = { color: '#010203' }\nconst extension = EditorView.theme({ '&': { color: '#ff0000', padding: '12px' } })`
  const diagnostics = scanSourceContent('src/editor.ts', source)
  expect(diagnostics.map(({ rule }) => rule)).toEqual(['ui/no-raw-color', 'ui/no-raw-pixel'])
  expect(diagnostics.map(({ line }) => line)).toEqual([2, 2])
})

test('CSS declaration strings are inspected only when used as style contexts', () => {
  const source = `const styleText = 'color: red; padding: 14px'\nconst prose = 'color: blue; padding: 12px'\nconst view = <div style={styleText} />\nconst literal = <span style="color: blue; padding: 12px" />`
  const diagnostics = scanSourceContent('src/styles.tsx', source)
  expect(diagnostics.map(({ rule }) => rule)).toEqual([
    'ui/no-raw-color',
    'ui/no-raw-pixel',
    'ui/no-raw-color',
    'ui/no-raw-pixel'
  ])
  expect(diagnostics.map(({ line }) => line)).toEqual([1, 1, 4, 4])
})

test('style template interpolations check static colors and pixels but allow percentages and URL fragments', () => {
  const source = "const rule = css`.panel { color: ${'#ff0000'}; padding: ${13}px; grid-template-columns: ${50}%; background-image: url(#${'fff'}) }`"
  const diagnostics = scanSourceContent('src/template.ts', source)
  expect(diagnostics.map(({ rule }) => rule)).toEqual(['ui/no-raw-color', 'ui/no-raw-pixel'])
})

test('HTML and SVG styles are checked without scanning prose, comments, or script strings', () => {
  const source = `<p title="#fff">#fff</p>
<!-- <style>.bad { color: red }</style> -->
<script>const sample = "<style>.bad { color: red }</style>"</script>
<svg><path fill="#ff0000" stroke-width="2px" /></svg>
<div style="color: blue; padding: 13px"></div>`
  const diagnostics = scanSourceContent('src/icon.svg', source)
  expect(diagnostics.map(({ rule }) => rule)).toEqual([
    'ui/no-raw-color',
    'ui/no-raw-pixel',
    'ui/no-raw-color',
    'ui/no-raw-pixel'
  ])
  expect(diagnostics.map(({ line }) => line)).toEqual([4, 4, 5, 5])
})

test('plugin mode prohibits stylesheet files, imports, style elements, and DOM stylesheet injection', () => {
  expect(rules('.x { color: red; padding: 2px; }', 'plugins/example/theme.css', { plugin: true })).toEqual([
    'ui/no-plugin-css',
    'ui/no-raw-color',
    'ui/no-raw-pixel'
  ])
  const source = `import './theme.css'\nconst node = document.createElement('style')\nnode.textContent = '.x { color: red }'\nconst sheet = new CSSStyleSheet()\nsheet.replaceSync('.x { padding: 2px }')\nexport const element = <style>{'.x { color: red }'}</style>`
  expect(rules(source, 'plugins/example/src/view.tsx', { plugin: true })).toEqual([
    'ui/no-plugin-css',
    'ui/no-plugin-css',
    'ui/no-raw-color',
    'ui/no-plugin-css',
    'ui/no-plugin-css',
    'ui/no-raw-pixel',
    'ui/no-plugin-css',
    'ui/no-raw-color'
  ])
})

test('plugins may load the canonical shared stylesheet but not their own CSS', () => {
  const source = `import '@quirky/ui/styles.css'; const shared = import('@quirky/ui/styles.css'); require('@quirky/ui/styles.css'); import './local.css'`
  expect(rules(source, 'plugins/example/src/ui.tsx', { plugin: true })).toEqual(['ui/no-plugin-css'])
})

test('opted-in HTML scripts cannot inject a stylesheet element', () => {
  const source = `<script>const node = document.createElement('style'); node.textContent = '.x { color: red }'</script>`
  expect(rules(source, 'plugins/example/index.html', { plugin: true })).toEqual([
    'ui/no-plugin-css',
    'ui/no-raw-color'
  ])
})

test('plugin configuration is strict, unique, and limited to known immediate directories', () => {
  expect(parsePluginConfig('[]', ['example.plugin'])).toEqual([])
  expect(parsePluginConfig('["example.plugin"]', ['example.plugin'])).toEqual(['example.plugin'])
  expect(() => parsePluginConfig('{"plugins":[]}', ['example.plugin'])).toThrow()
  expect(() => parsePluginConfig('["unknown"]', ['example.plugin'])).toThrow()
  expect(() => parsePluginConfig('not-json', ['example.plugin'])).toThrow()
  expect(() => parsePluginConfig('["example.plugin","example.plugin"]', ['example.plugin'])).toThrow()
  expect(() => parsePluginConfig('[1]', ['example.plugin'])).toThrow()
})

test('root lint scans all UI source, skips fixtures and unopted plugins, and enforces opted-in plugin trees', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-lint-enforcement-'))
  const put = (relativePath: string, content: string) => {
    const path = join(root, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const run = () => {
    const diagnostics: string[] = []
    const originalError = console.error
    console.error = (...values: unknown[]) => diagnostics.push(values.join(' '))
    try {
      return { status: runUiLint(root), diagnostics }
    } finally {
      console.error = originalError
    }
  }
  try {
    put('packages/ui/src/prose.ts', `const prose = '#fff red 13px'`)
    put('packages/ui/src/vendor/ignored.css', '.bad { color: red; padding: 13px; }')
    put('packages/ui/src/fixtures/ignored.css', '.bad { color: red; padding: 13px; }')
    put('plugins/example/theme.css', '.bad { color: red; padding: 13px; }')
    put('plugins/test/ignored.css', '.bad { color: red; padding: 13px; }')
    put('scripts/ui-lint-plugins.json', '[]')
    expect(run()).toEqual({ status: 0, diagnostics: [] })
    put('packages/ui/src/always.css', '.card { color: red; }')
    const uiAlways = run()
    expect(uiAlways.status).toBe(1)
    expect(uiAlways.diagnostics.some((message) => message.includes('packages/ui/src/always.css:1:') && message.includes('ui/no-raw-color'))).toBe(true)
    expect(uiAlways.diagnostics.some((message) => message.includes('plugins/example/theme.css'))).toBe(false)
    put('packages/ui/src/always.css', '.card { color: var(--ui-text); }')
    expect(run()).toEqual({ status: 0, diagnostics: [] })
    put('scripts/ui-lint-plugins.json', '["example"]')

    const enforced = run()
    expect(enforced.status).toBe(1)
    expect(enforced.diagnostics.some((message) => message.includes(' ui/no-raw-color:'))).toBe(true)
    expect(enforced.diagnostics.some((message) => message.includes(' ui/no-raw-pixel:'))).toBe(true)
    expect(enforced.diagnostics).toContain('plugins/example/theme.css:1:1 ui/no-plugin-css: Plugin source must use shared UI components and tokens instead of stylesheet CSS.')
    expect(enforced.diagnostics.some((message) => message.includes('plugins/example/theme.css:1:'))).toBe(true)
    expect(enforced.diagnostics.some((message) => message.includes('packages/ui/src/vendor'))).toBe(false)
    expect(enforced.diagnostics.some((message) => message.includes('packages/ui/src/fixtures'))).toBe(false)

    put('scripts/ui-lint-plugins.json', '["../outside"]')
    expect(run().diagnostics[0]).toContain('safe immediate plugin directory ID')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('root lint excludes Git-ignored generated plugin output but scans tracked plugin source', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-lint-gitignore-'))
  const put = (relativePath: string, content: string) => {
    const path = join(root, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  const run = () => {
    const diagnostics: string[] = []
    const originalError = console.error
    console.error = (...values: unknown[]) => diagnostics.push(values.join(' '))
    try {
      return { status: runUiLint(root), diagnostics }
    } finally {
      console.error = originalError
    }
  }
  try {
    git('init', '-q')
    mkdirSync(join(root, 'packages/ui/src'), { recursive: true })
    put('.gitignore', 'plugins/example/mobile/assets/mobile/\n')
    put('scripts/ui-lint-plugins.json', '["example"]')
    put('plugins/example/mobile/assets/mobile/page.css', '.bad { color: #fff; }')
    put('plugins/example/mobile/assets/mobile/authored.html', '<div style="color: #00ff00"></div>')
    put('plugins/example/source.html', '<div style="color: #ff0000"></div>')
    git('add', '--', '.gitignore', 'scripts/ui-lint-plugins.json', 'plugins/example/source.html')
    git('add', '-f', '--', 'plugins/example/mobile/assets/mobile/authored.html')

    const result = run()
    expect(result.status).toBe(1)
    const diagnosticFilesAndRules = result.diagnostics.map((message) => {
      const match = message.match(/^(.+):\d+:\d+ (ui\/[^:]+):/)
      if (!match) throw new Error(`Unexpected UI lint diagnostic format: ${message}`)
      return { file: match[1]!, rule: match[2]! }
    })
    expect(diagnosticFilesAndRules).toEqual([
      { file: 'plugins/example/mobile/assets/mobile/authored.html', rule: 'ui/no-raw-color' },
      { file: 'plugins/example/source.html', rule: 'ui/no-raw-color' }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
