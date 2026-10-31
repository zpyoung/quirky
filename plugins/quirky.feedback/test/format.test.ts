import { expect, test } from 'bun:test'
import type { Capture, Comment } from '../src/contract'
import { formatCommentsAsMarkdown } from '../src/format'

function capture(overrides: Partial<Capture> = {}): Capture {
  return {
    kind: 'element',
    owner: 'quirky.git',
    elementPath: 'main > button.save',
    selector: 'main > button.save',
    role: 'button',
    accessibleName: 'Save changes',
    visibleText: 'Save',
    nearbyText: ['Cancel', 'Help'],
    attributes: { class: 'save primary', title: 'Save it', 'aria-label': 'Save changes' },
    rect: { x: 10, y: 20, width: 100, height: 30 },
    computedStyles: { display: 'flex', backgroundColor: 'rgb(0, 0, 255)' },
    component: 'SaveButton',
    source: 'plugins/quirky.git/src/Save.tsx',
    sourceCaller: 'plugins/quirky.git/src/Panel.tsx',
    build: { version: '1.2.3', commit: 'abc123', channel: 'dev' },
    ...overrides
  }
}

function comment(text: string, overrides: Partial<Capture> = {}, intent: Comment['intent'] = 'change'): Comment {
  return { id: text, createdAt: 1, intent, comment: text, capture: capture(overrides) }
}

test('empty input returns an empty string', () => {
  expect(formatCommentsAsMarkdown([])).toBe('')
})

test('renders the heading, numbering and fields in Annotate order', () => {
  const output = formatCommentsAsMarkdown([comment('make it blue'), comment('why', {}, 'question')])
  const lines = output.split('\n')
  expect(lines[0]).toBe('## Quirky UI Feedback')
  expect(lines[1]).toBe('')
  expect(lines[2]).toBe('### 1. SaveButton button "Save changes"')
  const headings = lines.filter((line) => line.startsWith('### '))
  expect(headings[1]).toBe('### 2. SaveButton button "Save changes"')
  const labels = lines.slice(3, lines.indexOf('', 3)).map((line) => line.match(/^\*\*([^*]+):\*\*/)?.[1] ?? line)
  expect(labels).toEqual([
    'Intent', 'Plugin', 'App', 'Selector', 'Location', 'Source', 'Used by', 'React', 'Bounds', 'Classes',
    'Attributes', '- `title="Save it"`', '- `aria-label="Save changes"`', 'Text', 'Nearby text', '- `Cancel`', '- `Help`',
    'Computed styles', '- display: flex', '- background\\-color: rgb(0, 0, 255)', 'Feedback'
  ])
  expect(output).toContain('**Intent:** change')
  expect(output).toContain('**Intent:** question')
  expect(output).toContain('**Plugin:** `quirky.git`')
  expect(output).toContain('**App:** `Quirky 1.2.3 (abc123, dev)`')
  expect(output).toContain('**Selector:** `main > button.save`')
  expect(output).toContain('**Location:** `main > button.save`')
  expect(output).toContain('**Source:** `plugins/quirky.git/src/Save.tsx`')
  expect(output).toContain('**Used by:** `plugins/quirky.git/src/Panel.tsx`')
  expect(output).toContain('**React:** `SaveButton`')
  expect(output).toContain('**Bounds:** x=10, y=20, 100x30')
  expect(output).toContain('**Classes:** `save primary`')
  expect(output).toContain('**Text:** `Save`')
  expect(output).toContain('**Feedback:** make it blue')
})

test('omits empty fields and falls back to the path tag when there is no name', () => {
  const output = formatCommentsAsMarkdown([comment('x', {
    component: null, source: null, sourceCaller: null, accessibleName: null, visibleText: null,
    nearbyText: [], attributes: {}, computedStyles: {}, selector: ''
  })])
  expect(output).toContain('### 1. button\n')
  for (const label of ['Selector', 'Source', 'Used by', 'React', 'Classes', 'Attributes', 'Text', 'Nearby text', 'Computed styles']) {
    expect(output).not.toContain(`**${label}:**`)
  }
})

test('a terminal comment carries no text fields', () => {
  const output = formatCommentsAsMarkdown([comment('this pane is slow', {
    kind: 'terminal-pane',
    elementPath: 'div.workspace > div',
    selector: '[data-terminal-pane="t1"]',
    role: null, accessibleName: null, visibleText: null, nearbyText: null, attributes: null,
    computedStyles: {}, component: null, source: null, sourceCaller: null
  })])
  expect(output).toContain('### 1. terminal\\-pane\n')
  expect(output).toContain('**Selector:** `[data-terminal-pane="t1"]`')
  expect(output).toContain('**Feedback:** this pane is slow')
  for (const label of ['Text', 'Nearby text', 'Attributes', 'Classes', 'Computed styles']) {
    expect(output).not.toContain(`**${label}:**`)
  }
})

test('captured text cannot break out of its code span or inject headings', () => {
  const output = formatCommentsAsMarkdown([comment('ok', {
    visibleText: 'a `b` c',
    nearbyText: ['x\n# Injected heading', '``'],
    accessibleName: '# Heading `tick`',
    component: 'Evil`Name',
    elementPath: 'div`x'
  })])
  expect(output).toContain('**Text:** ``a `b` c``')
  expect(output).toContain('- `x # Injected heading`')
  expect(output).toContain('**React:** ``Evil`Name``')
  expect(output).toContain('**Location:** ``div`x``')
  expect(output.split('\n').filter((line) => line.startsWith('#'))).toEqual(['## Quirky UI Feedback', expect.stringMatching(/^### 1\. /)])
  expect(output).toContain('\\# Heading \\`tick\\`')
})

test('multi-line comments keep every line escaped', () => {
  const output = formatCommentsAsMarkdown([comment('first\n# second')])
  expect(output).toContain('**Feedback:** first\n\\# second')
})
