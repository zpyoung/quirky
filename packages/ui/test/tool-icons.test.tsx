import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'
import { UI_TOOL_HUES } from '@quirky/protocol'
import { DEFAULT_THEME, LIGHT_THEME } from '@quirky/protocol'
import { AgentIcon, ControlIcon, FileIcon, ProjectTile, ToolIcon, uiTokens } from '../src/design-system'
import { fileIconName } from '../src/design-system/icons/file-icon-map'
import { FILE_ICON_NAMES } from '../src/design-system/icons/generated-files'

let createRoot: (container: HTMLElement) => Root
let root: Root | null = null
let container: HTMLDivElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
})

async function render(node: Parameters<Root['render']>[0]) {
  await act(async () => root!.render(node))
}

const tokensCss = readFileSync(join(import.meta.dir, '../src/design-system/tokens.css'), 'utf8')

function block(selector: string): string {
  const start = tokensCss.indexOf(`${selector} {`)
  return tokensCss.slice(start, tokensCss.indexOf('}', start))
}
function declarations(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/(--ui-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]))
}
const dark = declarations(block(":root,\n[data-theme='dark']"))
const light = declarations(block("[data-theme='light']"))
const STATUS = ['--ui-working', '--ui-needs-you', '--ui-failing', '--ui-accent']

function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

describe('tokens', () => {
  test('the frame, card gap, hue and tile tokens exist in both themes', () => {
    expect(dark['--ui-rail']).toBe('#0c0d0f')
    expect(light['--ui-rail']).toBe('#eef0f3')
    expect(DEFAULT_THEME.colors.bg).toBe('#0c0d0f')
    expect(LIGHT_THEME.colors.bg).toBe('#eef0f3')
    expect(dark['--ui-card-gap']).toBe('5px')
    for (const hue of UI_TOOL_HUES) {
      expect(dark[`--ui-hue-${hue}`]).toMatch(/^#[0-9a-f]{6}$/)
      expect(light[`--ui-hue-${hue}`]).toMatch(/^#[0-9a-f]{6}$/)
      expect(uiTokens.hue[hue]).toBe(`--ui-hue-${hue}`)
    }
    expect(dark['--ui-hue-blue']).toBe('#6fb3ff')
    expect(light['--ui-hue-plum']).toBe('#8350bd')
  })

  test('tile colors read under white text and never equal a status color', () => {
    for (const [theme, tokens] of [['dark', dark], ['light', light]] as const) {
      const statuses = STATUS.map((name) => tokens[name]!.toLowerCase())
      for (let n = 1; n <= 8; n += 1) {
        const color = tokens[`--ui-tile-${n}`]!
        expect(color).toMatch(/^#[0-9a-f]{6}$/)
        expect(statuses).not.toContain(color.toLowerCase())
        expect(1.05 / (luminance(color) + 0.05), `${theme} tile ${n}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(tokens['--ui-tile-9']).toBeUndefined()
    }
  })
})

describe('fileIconName', () => {
  test('maps exact filenames before extensions', () => {
    expect(fileIconName('package.json')).toBe('package-json')
    expect(fileIconName('web/Dockerfile')).toBe('docker')
    expect(fileIconName('.gitignore')).toBe('git')
    expect(fileIconName('C:\\repo\\Cargo.lock')).toBe('cargo-lock')
    expect(fileIconName('bun.lock')).toBe('bun-lock')
    expect(fileIconName('tsconfig.build.json')).toBe('typescript-config')
    expect(fileIconName('a/b/.env.local')).toBe('env')
  })

  test('maps the common languages and asset types by extension, ignoring case', () => {
    const cases: Record<string, string> = {
      'a.ts': 'typescript', 'a.TSX': 'typescript-react', 'a.js': 'javascript', 'a.jsx': 'javascript-react', 'a.json': 'json',
      'NOTES.MD': 'markdown', 'a.css': 'css', 'a.html': 'html', 'a.sh': 'bash', 'a.py': 'python', 'a.rs': 'rust',
      'main.go': 'go', 'a.yml': 'yaml', 'a.YAML': 'yaml', 'a.toml': 'toml', 'a.sql': 'database', 'a.png': 'image',
      'a.JPG': 'image', 'x.lock': 'lock', 'types.d.ts': 'typescript-def'
    }
    for (const [path, expected] of Object.entries(cases)) expect(fileIconName(path), path).toBe(expected as never)
  })

  test('falls back to file for no extension, unknown dotfiles, unknown extensions and object-prototype names', () => {
    for (const path of ['', 'bin/run', '.mystery', 'a.unknownext', 'dir/', 'constructor', 'a.constructor', 'trailing.']) {
      expect(fileIconName(path), path).toBe('file')
    }
  })

  test('only returns names the generated set contains', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.d.ts', 'Makefile', 'LICENSE', 'x.mp3', 'x.mkv', 'vite.config.ts', 'x.tgz']) {
      expect(FILE_ICON_NAMES).toContain(fileIconName(path) as never)
    }
  })
})

describe('ToolIcon', () => {
  test('draws the duotone mark colored by its hue token and is decorative by default', async () => {
    await render(h(ToolIcon, { name: 'git-branch', hue: 'blue' }))
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256')
    expect(svg.getAttribute('style')).toContain('var(--ui-hue-blue)')
    expect(svg.querySelectorAll('path').length).toBe(2)
    expect(svg.innerHTML).toContain('opacity="0.2"')
  })

  test('takes a size and an accessible label', async () => {
    await render(h(ToolIcon, { name: 'robot', hue: 'coral', size: 20, label: 'Agents' }))
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Agents')
    expect(svg.hasAttribute('aria-hidden')).toBe(false)
  })

  test('an unknown name draws its first letter in the muted color and does not throw', async () => {
    await render(h(ToolIcon, { name: 'zebra', hue: 'mint' }))
    const fallback = container.querySelector('.ui-icon-fallback')!
    expect(container.querySelector('svg')).toBeNull()
    expect(fallback.textContent).toBe('z')
    expect(fallback.getAttribute('aria-hidden')).toBe('true')
    expect(fallback.getAttribute('style')).toBeNull()
    await render(h(ToolIcon, { name: '', hue: 'mint' }))
    expect(container.querySelector('.ui-icon-fallback')!.textContent).toBe('?')
  })

  test('a name that exists on Object.prototype is unknown, not an icon', async () => {
    await render(h(ToolIcon, { name: 'constructor', hue: 'blue' }))
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.ui-icon-fallback')!.textContent).toBe('c')
  })
})

describe('ControlIcon', () => {
  test('draws the regular weight in currentColor', async () => {
    await render(h(ControlIcon, { name: 'plus' }))
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelectorAll('path').length).toBe(1)
    expect(svg.getAttribute('style')).toBeNull()
  })

  test('an unknown name draws its first letter', async () => {
    await render(h(ControlIcon, { name: 'nope' }))
    expect(container.querySelector('.ui-icon-fallback')!.textContent).toBe('n')
  })
})

describe('FileIcon', () => {
  test('draws the icon for the path in the Mocha flavor in dark', async () => {
    document.documentElement.dataset.theme = 'dark'
    await render(h(FileIcon, { path: 'src/app.ts' }))
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('data-icon')).toBe('typescript')
    expect(svg.getAttribute('data-flavor')).toBe('mocha')
    expect(svg.innerHTML).toContain('#89b4fa')
  })

  test('follows the active theme at runtime without remounting', async () => {
    document.documentElement.dataset.theme = 'dark'
    await render(h(FileIcon, { path: 'src/app.ts' }))
    const before = container.querySelector('svg')!
    const mocha = before.innerHTML
    await act(async () => {
      document.documentElement.dataset.theme = 'light'
    })
    const after = container.querySelector('svg')!
    expect(after).toBe(before)
    expect(after.getAttribute('data-flavor')).toBe('latte')
    expect(after.innerHTML).not.toBe(mocha)
    await act(async () => {
      document.documentElement.dataset.theme = 'dark'
    })
    expect(container.querySelector('svg')!.getAttribute('data-flavor')).toBe('mocha')
  })

  test('uses the nearest themed ancestor, so side-by-side themes each get their own flavor', async () => {
    document.documentElement.dataset.theme = 'dark'
    await render(h('div', { 'data-theme': 'light' }, h(FileIcon, { path: 'a.py' })))
    expect(container.querySelector('svg')!.getAttribute('data-flavor')).toBe('latte')
  })

  test('paths with no extension and dotfiles get the right icon', async () => {
    await render(h('div', null, h(FileIcon, { path: 'bin/run' }), h(FileIcon, { path: '.gitignore' }), h(FileIcon, { path: '.mystery' })))
    expect([...container.querySelectorAll('svg')].map((svg) => svg.getAttribute('data-icon'))).toEqual(['file', 'git', 'file'])
  })

  test('takes a size and a label', async () => {
    await render(h(FileIcon, { path: 'a.md', size: 24, label: 'Markdown file' }))
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('aria-label')).toBe('Markdown file')
  })
})

describe('ProjectTile', () => {
  const tile = () => container.querySelector<HTMLElement>('.ui-project-tile')!

  test('uses the project color when it is not a status color', async () => {
    await render(h(ProjectTile, { name: 'quirky', color: '#3366cc' }))
    expect(tile().style.background).toBe('#3366cc')
    expect(tile().textContent).toBe('QU')
    expect(tile().getAttribute('aria-hidden')).toBe('true')
  })

  test('rejects a status color in either theme and either case, picking a tile color from the name', async () => {
    for (const color of [...STATUS.map((name) => dark[name]!), ...STATUS.map((name) => light[name]!)]) {
      for (const variant of [color, color.toUpperCase(), ` ${color.toUpperCase()} `]) {
        await render(h(ProjectTile, { name: 'quirky', color: variant }))
        expect(tile().style.background, variant).toMatch(/^var\(--ui-tile-[1-8]\)$/)
      }
    }
  })

  test('a missing or empty color picks a tile color, and the same name always picks the same one', async () => {
    const pick = async (name: string, color?: string | null) => {
      await render(h(ProjectTile, { name, color }))
      return tile().style.background
    }
    const first = await pick('quirky')
    expect(first).toMatch(/^var\(--ui-tile-[1-8]\)$/)
    expect(await pick('quirky', null)).toBe(first)
    expect(await pick('quirky', '')).toBe(first)
    expect(await pick('quirky', '#4CC38A')).toBe(first)
    const used = new Set<string>()
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu']) used.add(await pick(name))
    expect(used.size).toBeGreaterThan(3)
  })

  test('also rejects the status colors of a theme applied at runtime', async () => {
    document.documentElement.style.setProperty('--ui-accent', '#abcdef')
    await render(h(ProjectTile, { name: 'quirky', color: '#ABCDEF' }))
    expect(tile().style.background).toMatch(/^var\(--ui-tile-[1-8]\)$/)
  })

  test('letters come from the first two separated words, else the first two letters', async () => {
    const letters = async (name: string) => {
      await render(h(ProjectTile, { name }))
      return tile().textContent
    }
    expect(await letters('my-project')).toBe('MP')
    expect(await letters('my_project_x')).toBe('MP')
    expect(await letters('my project')).toBe('MP')
    expect(await letters('  spaced   out ')).toBe('SO')
    expect(await letters('quirky')).toBe('QU')
    expect(await letters('q')).toBe('Q')
    expect(await letters('a--b')).toBe('AB')
    expect(await letters('-lead')).toBe('LE')
    expect(await letters('')).toBe('?')
    expect(await letters('   ')).toBe('?')
    expect(await letters('--')).toBe('?')
  })

  test('takes a size and a label', async () => {
    await render(h(ProjectTile, { name: 'quirky', size: 20, label: 'quirky project' }))
    expect(tile().getAttribute('role')).toBe('img')
    expect(tile().getAttribute('aria-label')).toBe('quirky project')
    expect(tile().hasAttribute('aria-hidden')).toBe(false)
    expect(tile().style.getPropertyValue('--ui-tile-size')).toBe('20px')
  })
})

describe('AgentIcon', () => {
  const MARKS: readonly [id: string, mark: string][] = [
    ['claude', 'claude'], ['claude-agent-teams', 'claude'], ['codex', 'codex'], ['opencode', 'opencode'], ['opencode2', 'opencode'],
    ['opencode-go', 'opencode'], ['pi', 'pi'], ['gemini', 'gemini'], ['aider', 'aider'], ['cursor', 'cursor'], ['rovo', 'atlassian'],
    ['antigravity', 'antigravity'], ['kimi', 'kimi'], ['grok', 'grok'], ['zcode', 'zai'], ['copilot', 'copilot'], ['qoder-cn', 'qoder']
  ]

  for (const [id, mark] of MARKS) {
    test(`${id} draws the ${mark} mark`, async () => {
      await render(h(AgentIcon, { id }))
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('data-icon')).toBe(mark)
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('fill')).toBe('currentColor')
      expect(svg.getAttribute('width')).toBe('16')
      expect(svg.querySelector('path')).not.toBeNull()
    })
  }

  const MONOGRAMS: readonly [id: string, letter: string][] = [
    ['omp', 'O'], ['minimax', 'M'], ['hermes', 'H'], ['some-plugin-agent', 'S'], ['constructor', 'C'], ['__proto__', '_'], ['', '?']
  ]

  for (const [id, letter] of MONOGRAMS) {
    test(`"${id}" has no mark and falls back to the monogram ${letter}`, async () => {
      await render(h(AgentIcon, { id }))
      expect(container.querySelector('svg')).toBeNull()
      const monogram = container.querySelector('.ui-agent-monogram')!
      expect(monogram.textContent).toBe(letter)
      expect(monogram.getAttribute('aria-hidden')).toBe('true')
    })
  }

  test('a size reaches both the mark and the monogram box', async () => {
    await render(h('div', null, h(AgentIcon, { id: 'claude', size: 20 }), h(AgentIcon, { id: 'omp', size: 20 })))
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('20')
    expect(container.querySelector<HTMLElement>('.ui-agent-monogram')!.style.getPropertyValue('--ui-icon-box')).toBe('20px')
  })
})

describe('gallery', () => {
  test('shows each new component in both themes, with file icons and popups following their section', async () => {
    const { Gallery } = await import('../src/gallery')
    await render(h(Gallery))
    const sections = [...container.querySelectorAll<HTMLElement>('.ui-gallery-theme')]
    expect(sections.map((section) => section.dataset.theme)).toEqual(['dark', 'light'])
    for (const section of sections) {
      const category = (name: string) => section.querySelector(`[data-category="${name}"]`)!
      expect(category('ToolIcon').querySelectorAll('svg').length).toBeGreaterThan(10)
      expect(category('ToolIcon').querySelector('.ui-icon-fallback')).not.toBeNull()
      expect(category('ControlIcon').querySelectorAll('svg').length).toBeGreaterThan(5)
      expect(category('ProjectTile').querySelectorAll('.ui-project-tile').length).toBeGreaterThan(5)
      expect(category('AgentIcon').querySelectorAll('svg').length).toBeGreaterThan(5)
      expect(category('AgentIcon').querySelector('.ui-agent-monogram')).not.toBeNull()
      const flavors = new Set([...category('FileIcon').querySelectorAll('svg')].map((svg) => svg.getAttribute('data-flavor')))
      expect([...flavors]).toEqual([section.dataset.theme === 'dark' ? 'mocha' : 'latte'])
    }
    const open = sections[1]!.querySelector<HTMLButtonElement>('[data-category="PopupMenu"] button')!
    await act(async () => open.click())
    expect(document.querySelectorAll('.ui-popup')).toHaveLength(1)
    expect(document.querySelector('.ui-popup')!.getAttribute('data-theme')).toBe('light')
    const first = sections[0]!.querySelector<HTMLButtonElement>('[data-category="PopupMenu"] button')!
    await act(async () => first.click())
    expect(document.querySelectorAll('.ui-popup')).toHaveLength(1)
    expect(document.querySelector('.ui-popup')!.getAttribute('data-theme')).toBe('dark')
  })
})
