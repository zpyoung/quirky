import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { formatDiagnostic, parsePluginConfig, runUiLint, scanSourceContent, scanToolLayoutRules, scanToolManifest } from './ui-lint'

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

test('root lint scans UI source, skips fixtures, and enforces opted-in plugins', () => {
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
    expect(enforced.diagnostics.some((message) => message.includes('plugins/example/theme.css:1:'))).toBe(true)
    expect(enforced.diagnostics.some((message) => message.includes('packages/ui/src/vendor'))).toBe(false)
    expect(enforced.diagnostics.some((message) => message.includes('packages/ui/src/fixtures'))).toBe(false)

    put('scripts/ui-lint-plugins.json', '["../outside"]')
    expect(run().status).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repository inventory ignores generated artifacts but still enforces tracked and new plugin source', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-lint-git-inventory-'))
  const put = (name: string, content: string) => {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        QUIRKY_HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1'
      }
    })
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
    git('init', '--quiet')
    put('.gitignore', 'plugins/example/generated/\nplugins/example/ignored-source.tsx\n')
    put('packages/ui/src/prose.ts', 'export const title = "Fixture"')
    put('scripts/ui-lint-plugins.json', '["example"]')
    put('plugins/example/generated/page.css', '.card { color: red; padding: 13px; }')
    expect(run()).toEqual({ status: 0, diagnostics: [] })

    put('plugins/example/ignored-source.tsx', 'export const tracked = <div style={{ color: "red" }} />')
    git('add', '--force', '--', 'plugins/example/ignored-source.tsx')
    put('plugins/example/source.tsx', 'export const fresh = <div style={{ color: "red" }} />')
    const enforced = run()
    expect(enforced.status).toBe(1)
    expect(enforced.diagnostics.map((line) => line.match(/^(.*?):\d+:\d+ (ui\/[^:]+):/)?.slice(1))).toEqual([
      ['plugins/example/ignored-source.tsx', 'ui/no-raw-color'],
      ['plugins/example/source.tsx', 'ui/no-raw-color']
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const MANIFEST = `{
  "id": "example",
  "contributes": {
    "panel": [
      { "id": "good", "icon": "git-branch", "hue": "blue" },
      { "id": "bad", "icon": "nope", "hue": "chartreuse" }
    ],
    "sidebar-section": [
      { "id": "no-fields", "title": "Plain" },
      { "id": "icon-only", "icon": "robot" },
      { "id": "hue-only", "hue": "coral" },
      { "id": "bad-icon", "icon": "server" }
    ],
    "activity-item": [{ "id": "act", "icon": "activity", "hue": "mint" }],
    "command": [{ "id": "cmd", "icon": "not-a-tool-icon", "hue": "nope" }],
    "view": [{ "id": "view", "icon": "not-a-tool-icon" }]
  }
}`

test('ui/tool-icon-hue reports manifest tool icons and hues outside the generated sets with file:line:col', () => {
  const diagnostics = scanToolManifest('plugins/example/quirky-plugin.json', MANIFEST)
  expect(diagnostics.map(({ rule }) => rule)).toEqual(Array(4).fill('ui/tool-icon-hue'))
  expect(diagnostics.map(({ file, line, column }) => `${file}:${line}:${column}`)).toEqual([
    'plugins/example/quirky-plugin.json:6:30',
    'plugins/example/quirky-plugin.json:6:45',
    'plugins/example/quirky-plugin.json:12:35',
    'plugins/example/quirky-plugin.json:14:46'
  ])
  expect(diagnostics[0]!.message).toContain('"nope"')
  expect(diagnostics[1]!.message).toContain('"chartreuse"')
  expect(diagnostics[1]!.message).toContain('blue')
  expect(formatDiagnostic(diagnostics[2]!)).toStartWith('plugins/example/quirky-plugin.json:12:35 ui/tool-icon-hue:')
})

test('ui/tool-icon-hue accepts manifests with no tool contributions, no icon or hue, or unparsable content', () => {
  expect(scanToolManifest('m.json', '{ "id": "x" }')).toEqual([])
  expect(scanToolManifest('m.json', '{ "contributes": { "panel": [{ "id": "a" }] } }')).toEqual([])
  expect(scanToolManifest('m.json', '{ "contributes": { "panel": "nope" } }')).toEqual([])
  expect(scanToolManifest('m.json', 'not json {')).toEqual([])
})

const RULES_SOURCE = `const RULES: { id: string; icon: string; hue?: string }[] = [
  { id: 'a', title: 'A', icon: 'git-branch' },
  { id: 'b', title: 'B', icon: 'files', defaultSlot: 'right-top' },
  { id: 'c', title: 'C', icon: 'robot', hue: 'coral' },
  { id: 'd', title: 'D', icon: 'pulse', hue: 'chartreuse' }
]
const OTHER = [{ icon: 'ignored', hue: 'ignored' }]`

test('ui/tool-icon-hue reads the RULES table, tolerating rows that have no hue yet', () => {
  const diagnostics = scanToolLayoutRules('packages/daemon/src/plugins/tool-layout.ts', RULES_SOURCE)
  expect(diagnostics.map(({ line, column, rule }) => [line, column, rule])).toEqual([
    [3, 32, 'ui/tool-icon-hue'],
    [5, 46, 'ui/tool-icon-hue']
  ])
  expect(diagnostics[0]!.message).toContain('"files"')
  expect(diagnostics[1]!.message).toContain('"chartreuse"')
  expect(scanToolLayoutRules('x.ts', 'export const nothing = 1')).toEqual([])
})

test('root lint checks plugin manifests and the RULES table', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-lint-tool-identity-'))
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
    put('packages/ui/src/prose.ts', 'export const title = "Fixture"')
    put('scripts/ui-lint-plugins.json', '[]')
    put('plugins/example/quirky-plugin.json', '{ "contributes": { "panel": [{ "id": "a", "icon": "git-branch", "hue": "blue" }] } }')
    put('packages/daemon/src/plugins/tool-layout.ts', RULES_SOURCE)
    const rulesOnly = run()
    expect(rulesOnly.status).toBe(1)
    expect(rulesOnly.diagnostics.map((line) => line.split(' ')[0])).toEqual([
      'packages/daemon/src/plugins/tool-layout.ts:3:32',
      'packages/daemon/src/plugins/tool-layout.ts:5:46'
    ])

    put('packages/daemon/src/plugins/tool-layout.ts', 'export const RULES = []')
    put('plugins/example/quirky-plugin.json', MANIFEST)
    const manifestsOnly = run()
    expect(manifestsOnly.status).toBe(1)
    expect(manifestsOnly.diagnostics).toHaveLength(4)
    expect(manifestsOnly.diagnostics[0]).toContain('plugins/example/quirky-plugin.json:6:30 ui/tool-icon-hue')

    put('plugins/example/quirky-plugin.json', '{ "contributes": { "panel": [{ "id": "a", "icon": "git-branch", "hue": "blue" }] } }')
    expect(run()).toEqual({ status: 0, diagnostics: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generated icon files and the vendored Catppuccin SVGs may hold raw colors', () => {
  const svg = '<svg><path fill="#cdd6f4" stroke="#89b4fa" d="M0 0"/></svg>'
  expect(rules(svg, 'packages/ui/src/design-system/icons/catppuccin/mocha/typescript.svg')).toEqual([])
  expect(rules(svg, 'packages/ui/src/design-system/icons/other.svg')).not.toEqual([])
  expect(rules("export const x = { fill: '#cdd6f4', width: '13px' }", 'packages/ui/src/design-system/icons/generated-files.ts')).toEqual([])
})
