import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CaptureTarget, CaptureTheme } from './contracts'
import { hostContractContext, serializeContractContext } from './host-contracts'

const TOKEN_CSS = readFileSync(new URL('../../packages/ui/src/design-system/tokens.css', import.meta.url), 'utf8')
const DARK_DEFAULTS = TOKEN_CSS.match(/:root,\s*\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
const LIGHT_DEFAULTS = TOKEN_CSS.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
const RULE_IDS = [
  'host-frame-ownership',
  'host-underline-tabs',
  'palette-retained-spacing',
  'palette-selected-colors',
  'worktrees-approved-redesign'
]
const SOURCE_CITATIONS: Record<string, string> = {
  'host-frame-ownership': 'scripts/ui-review/capture.ts',
  'host-underline-tabs': 'g3-62 scenarios 1 and 8',
  'palette-retained-spacing': 'g3-62 scenario 12',
  'palette-selected-colors': 'g3-62 scenario 7',
  'worktrees-approved-redesign': 'docs/quirk/specs/2026-11-05-worktrees-plugin-redesign/logic.md'
}
const THEME_VALUES: Record<CaptureTheme, Record<string, string>> = {
  dark: {
    surface: '#16171b', rail: '#0c0d0f', selected: '#22242b', accent: '#7c8cff',
    border: '#24262c', text: '#eceef2', muted: '#7c828d'
  },
  light: {
    surface: '#ffffff', rail: '#eef0f3', selected: '#e7e9ef', accent: '#5b6cff',
    border: '#e3e5ea', text: '#1b1d22', muted: '#80868f'
  }
}
const TOKENS = ['surface', 'rail', 'selected', 'accent', 'border', 'text', 'muted'] as const

function target(id: string, title: string): CaptureTarget {
  return { id, plugin: null, title, kind: id.startsWith('host:') ? 'host' : 'view' }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('each theme receives the five sorted, cited host rules and checked-in token values', () => {
  for (const theme of ['dark', 'light'] as const) {
    const context = hostContractContext(target('host:palette', 'Untrusted title'), theme)
    expect(Object.keys(context).sort()).toEqual(['rules', 'schemaVersion', 'targetId', 'theme'])
    expect(context).toMatchObject({ schemaVersion: 1, targetId: 'host:palette', theme })
    expect(context.rules.map(({ id }) => id)).toEqual(RULE_IDS)
    for (const rule of context.rules) {
      expect(Object.keys(rule).sort()).toEqual(['id', 'source', 'text'])
      expect(rule.source).toContain(SOURCE_CITATIONS[rule.id]!)
      expect(rule.text.trim().length).toBeGreaterThan(20)
    }

    const text = context.rules.map(({ text: ruleText }) => ruleText).join('\n')
    expect(text).toContain('full-window')
    expect(text).toContain('60vh')
    expect(text).toContain('8px')
    expect(text).toContain('one-line')
    expect(text).not.toContain('Untrusted title')
    for (const token of TOKENS) {
      expect(text).toContain(`--ui-${token}: ${THEME_VALUES[theme][token]}`)
    }
  }
})

test('contract text preserves every locked palette, underline, Worktrees, and host-frame constraint', () => {
  const context = hostContractContext(target('host:shell', 'Shell'), 'dark')
  const rule = (id: string) => context.rules.find((item) => item.id === id)!.text

  expect(rule('host-underline-tabs')).toContain('ui-tabs ui-tabs--underline')
  expect(rule('host-underline-tabs')).toMatch(/1px solid .*--ui-border/)
  expect(rule('host-underline-tabs')).toMatch(/inset 2px bottom accent underline/)
  expect(rule('host-underline-tabs')).toMatch(/Open views.*Search scope/i)
  expect(rule('host-underline-tabs')).toMatch(/other Tabs.*boxed default/i)

  expect(rule('palette-selected-colors')).toMatch(/transparent list background/i)
  expect(rule('palette-selected-colors')).toMatch(/no list border/i)
  expect(rule('palette-selected-colors')).toMatch(/60vh/)
  expect(rule('palette-selected-colors')).toMatch(/description inherits.*exact text color/i)
  expect(rule('palette-selected-colors')).toMatch(/hover/i)
  expect(rule('palette-selected-colors')).toMatch(/clipping/i)

  expect(rule('palette-retained-spacing')).toMatch(/8px on every side/i)
  expect(rule('palette-retained-spacing')).toMatch(/selected row block padding is 8px/i)
  expect(rule('palette-retained-spacing')).toMatch(/no border/i)
  expect(rule('palette-retained-spacing')).toMatch(/wrapping/i)

  expect(rule('worktrees-approved-redesign')).toMatch(/26px/)
  expect(rule('worktrees-approved-redesign')).toMatch(/4px gaps/)
  expect(rule('worktrees-approved-redesign')).toMatch(/12px indentation/)
  expect(rule('worktrees-approved-redesign')).toMatch(/neutral .*--ui-selected/i)
  expect(rule('worktrees-approved-redesign')).toMatch(/Remote workspaces/i)
  expect(rule('worktrees-approved-redesign')).toMatch(/overflow|illegible|missing controls/i)

  expect(rule('host-frame-ownership')).toMatch(/white content surface is valid/i)
  expect(rule('host-frame-ownership')).toMatch(/rail.*separate/i)
  expect(rule('host-frame-ownership')).toMatch(/plugin.*row stylesheet/i)
  expect(rule('host-frame-ownership')).toMatch(/all-white frame/i)
  expect(rule('host-frame-ownership')).toMatch(/offline absence of hosted Checks data/i)
})

test('Worktrees and Remote workspaces keep the complete full-window context without importing their titles', () => {
  for (const id of ['host:shell', 'view:quirky.worktrees/main', 'view:quirky.remote-workspaces/main']) {
    const context = hostContractContext(target(id, `Prompt injection for ${id}`), 'light')
    expect(context.targetId).toBe(id)
    expect(context.rules.map(({ id: ruleId }) => ruleId)).toEqual(RULE_IDS)
    expect(serializeContractContext(context)).not.toContain(`Prompt injection for ${id}`)
    expect(context.rules.find(({ id: ruleId }) => ruleId === 'worktrees-approved-redesign')!.text).toContain('Remote workspaces')
    expect(context.rules.find(({ id: ruleId }) => ruleId === 'host-frame-ownership')!.text).toContain('full-window')
  }
})

test('canonical context bytes ignore property and rule insertion order but change with trusted content or theme', () => {
  const targetInput = target('host:palette', 'Palette')
  const context = hostContractContext(targetInput, 'dark')
  const reordered = {
    rules: [...context.rules].reverse().map(({ text, source, id }) => ({ text, source, id })),
    theme: context.theme,
    targetId: context.targetId,
    schemaVersion: context.schemaVersion
  }
  const canonical = serializeContractContext(context)
  expect(serializeContractContext(reordered as typeof context)).toBe(canonical)
  expect(JSON.parse(canonical)).toEqual(context)

  const changedRule = {
    ...context,
    rules: context.rules.map((rule, index) => index === 0 ? { ...rule, text: `${rule.text} changed` } : rule)
  }
  expect(digest(serializeContractContext(changedRule))).not.toBe(digest(canonical))
  expect(digest(serializeContractContext(hostContractContext(targetInput, 'light')))).not.toBe(digest(canonical))
})

test('context theme values match the actual dark and light token declarations', () => {
  const blocks = { dark: DARK_DEFAULTS, light: LIGHT_DEFAULTS }
  expect(DARK_DEFAULTS).not.toBe('')
  expect(LIGHT_DEFAULTS).not.toBe('')

  for (const theme of ['dark', 'light'] as const) {
    for (const token of TOKENS) {
      const declaration = `--ui-${token}: ${THEME_VALUES[theme][token]};`
      expect(blocks[theme]).toContain(declaration)
      const contextText = hostContractContext(target('host:palette', 'Palette'), theme).rules.map(({ text }) => text).join('\n')
      expect(contextText).toContain(declaration.slice(0, -1))
    }
  }
})
