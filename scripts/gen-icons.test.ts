import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTROL_ICON_NAMES,
  FILE_ICON_NAMES,
  TOOL_ICON_NAMES,
  assertSafeSvg,
  generateIcons,
  iconsDirectory
} from './gen-icons'

const SAFE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M0,0Z"/></svg>'

test('an SVG with an unlisted element, an event attribute or an external reference is rejected by file name', () => {
  const hostile: Record<string, string> = {
    script: '<svg><script>alert(1)</script></svg>',
    'script upper': '<svg><SCRIPT src="x"></SCRIPT></svg>',
    foreignObject: '<svg><foreignObject><div/></foreignObject></svg>',
    image: '<svg><image href="#a"/></svg>',
    'event attribute': '<svg><path d="M0,0" onload="x()"/></svg>',
    'event attribute upper': '<svg><path d="M0,0" ONCLICK = "x()"/></svg>',
    'external href': '<svg><use href="https://example.com/a.svg#b"/></svg>',
    'xlink href': '<svg><use xlink:href="//example.com/a.svg"/></svg>',
    'data href': '<svg><a href="data:text/html,x"/></svg>',
    'javascript href': '<svg><a href="javascript:alert(1)"/></svg>',
    'encoded html in a description': '<svg><desc><iframe srcdoc="&lt;script&gt;x()&lt;/script&gt;"></iframe></desc></svg>',
    'style element': '<svg><style>path { fill: url(https://example.com/a) }</style></svg>',
    'external url in an attribute': '<svg><path d="M0,0" fill="url(https://example.com/a.svg#b)"/></svg>',
    'doctype entity': '<!DOCTYPE svg [<!ENTITY x "y">]><svg><path d="M0,0"/></svg>'
  }
  for (const [label, svg] of Object.entries(hostile)) {
    expect(() => assertSafeSvg(`bad/${label}.svg`, svg)).toThrow(`bad/${label}.svg`)
  }
})

test('plain paths, groups and same-document references pass the rejection check', () => {
  expect(() => assertSafeSvg('ok.svg', SAFE)).not.toThrow()
  expect(() => assertSafeSvg('ok.svg', '<svg><g fill="url(#a)"><path d="M0,0" href="#a"/></g></svg>')).not.toThrow()
})

test('every named icon is generated and the committed files match a fresh run', () => {
  const output = generateIcons()
  expect(Object.keys(output).sort()).toEqual(['generated-controls.ts', 'generated-files.ts', 'generated-tools.ts'])
  for (const [file, text] of Object.entries(output)) {
    expect(readFileSync(join(iconsDirectory, file), 'utf8')).toBe(text)
  }
  expect(generateIcons()).toEqual(output)
  for (const name of ['git-branch', 'tray', 'list-checks', 'robot', 'flow-arrow', 'device-mobile', 'git-diff', 'folders', 'check-circle', 'chat-circle-dots', 'git-pull-request', 'info', 'vault', 'book-open-text', 'terminal-window', 'command', 'warning-circle', 'hard-drives', 'pulse', 'gauge', 'sidebar', 'squares-four']) {
    expect(TOOL_ICON_NAMES).toContain(name as never)
    expect(output['generated-tools.ts']).toContain(`'${name}'`)
  }
  for (const name of ['plus', 'magnifying-glass', 'dots-three', 'dots-three-vertical', 'minus', 'caret-down', 'caret-left', 'caret-right', 'arrows-clockwise', 'funnel', 'export', 'x', 'arrows-out', 'check', 'gear', 'globe', 'squares-four']) {
    expect(CONTROL_ICON_NAMES).toContain(name as never)
  }
  expect(FILE_ICON_NAMES).toContain('file')
})

test('generated files hold only the named icons', () => {
  const tools = generateIcons()['generated-tools.ts']!
  expect(tools).not.toContain("'acorn'")
  expect(tools.length).toBeLessThan(60_000)
})

test('every file icon is vendored in both Catppuccin flavors with its license and source commit', () => {
  const catppuccin = join(iconsDirectory, 'catppuccin')
  for (const flavor of ['mocha', 'latte']) {
    for (const name of FILE_ICON_NAMES) {
      expect(existsSync(join(catppuccin, flavor, `${name === 'file' ? '_file' : name}.svg`))).toBe(true)
    }
  }
  expect(readFileSync(join(catppuccin, 'LICENSE'), 'utf8')).toContain('MIT License')
  expect(readFileSync(join(catppuccin, 'SOURCE.md'), 'utf8')).toMatch(/[0-9a-f]{40}/)
})
