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
const SOURCE_CITATIONS: Record<string, string[]> = {
  'host-frame-ownership': ['scripts/ui-review/capture.ts'],
  'host-underline-tabs': [
    'g3-62 scenarios 1 and 8',
    'packages/ui/src/design-system/components.css',
    'docs/quirk/specs/2026-11-05-worktrees-plugin-redesign/logic.md'
  ],
  'palette-retained-spacing': ['g3-62 scenario 12'],
  'palette-selected-colors': ['g3-62 scenario 7'],
  'worktrees-approved-redesign': [
    'docs/quirk/specs/2026-11-05-worktrees-plugin-redesign/logic.md',
    'docs/quirk/specs/2026-10-28-m6-orchestration-ui/logic.md'
  ]
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
const LEGACY_TAB_TEXT = 'The tablist is ui-tabs ui-tabs--underline, with a 1px solid var(--ui-border) bottom rule. Selected tabs have no top border, zero radius, var(--ui-surface) background, var(--ui-text) foreground, and an inset 2px bottom accent underline. Unselected tabs are transparent, have no top border or shadow, and use var(--ui-muted). This governs Open views and palette Search scope; other Tabs keep their existing boxed default. An underline is not a defect merely because it differs from the older golden.'
const TREATMENT_PHRASES = {
  header: [
    'ToolPanelFrame header tabs', 'Tasks (Issues, PRs, Projects)',
    'Agent Session History (Workspace, Project, All)',
    'the tablist has no bottom rule', 'wraps whole tabs onto another row when narrow',
    '2px by 4px padding', '7px radius', 'transparent background', 'transparent 1px border',
    'selected tab keeps a transparent background with a 1px var(--ui-accent) border and var(--ui-text)',
    'neither boxed nor underline tabs', 'this compact look is not a defect'
  ],
  savedViews: [
    'Worktrees saved-view tabs (All, Needs you and starred views)',
    'single scrolling row with no tablist bottom rule',
    'transparent and borderless in var(--ui-muted)',
    'selected tab uses var(--ui-text) with a 2px var(--ui-accent) bottom border',
    'neither boxed nor the Open views underline tablist'
  ],
  standalone: [
    'Other standalone Tabs, such as those in dialogs and settings, keep their existing boxed default',
    '1px var(--ui-border) border', 'rounded top corners', 'var(--ui-selected) behind the selected tab'
  ]
} as const

function treatmentFailures(text: string, treatment: keyof typeof TREATMENT_PHRASES): string[] {
  return TREATMENT_PHRASES[treatment].filter((phrase) => !text.includes(phrase))
}

function target(id: string, title: string): CaptureTarget {
  return { id, plugin: null, title, kind: id.startsWith('host:') ? 'host' : 'view' }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const LEGACY_WORKTREES_TEXT = 'The approved Worktrees redesign supersedes the older shell golden for this component. Worktrees rows are single-line 26px, with 4px gaps and 12px indentation; selection is neutral var(--ui-selected) with a bold name, not blue. Saved-view tabs, filter and changed lines, header actions, hierarchy, counts, and rail attention badges are approved capabilities. Their presence or one-line density is not a defect. Overflow, illegible names, missing controls, and incorrect implementation of these rules remain defects. This rule does not apply Worktrees row anatomy to Remote workspaces.'
const ORCHESTRATION_ROW_PHRASES = [
  'Orchestration session rows nested under a worktree are not checkout rows',
  'Coordinator followed by a session name',
  'Orphaned coordinator',
  'Coordinator unavailable',
  'Worker assignment unverified',
  '34px minimum',
  'wrap their full text',
  'the single-line 26px checkout anatomy does not apply to them',
  'That second line, the 34px height and that wrapping are not defects'
]

function orchestrationRowFailures(text: string): string[] {
  return ORCHESTRATION_ROW_PHRASES.filter((phrase) => !text.includes(phrase))
}

for (const theme of ['dark', 'light'] as const) {
  const text = hostContractContext(target('host:shell', 'Shell'), theme)
    .rules.find(({ id }) => id === 'worktrees-approved-redesign')!.text

  test(`${theme}: checkout anatomy is limited to checkout rows`, () => {
    for (const phrase of ['Worktree checkout rows', 'activity mark', 'worktree name', 'up to two tag chips plus +N', 'one right-side fact']) {
      expect(text).toContain(phrase)
    }
    for (const pattern of [/26px/, /4px gaps/, /12px indentation/, /neutral .*--ui-selected/i, /bold name/, /one-line/]) {
      expect(text).toMatch(pattern)
    }
  })

  test(`${theme}: orchestration titles and descriptions may wrap above their shared minimum height`, () => {
    expect(text).toMatch(/Orchestration session rows[^.]*not checkout rows/)
    expect(orchestrationRowFailures(text)).toEqual([])
  })

  test(`${theme}: both row kinds retain legibility and control requirements`, () => {
    expect(text).toMatch(/clips or overlaps text[^.]*illegible names[^.]*missing controls[^.]*in either kind of row/)
    expect(text).toContain('This rule does not apply Worktrees row anatomy to Remote workspaces')
  })

  test(`${theme}: removing the orchestration exception loses the required guidance`, () => {
    expect(LEGACY_WORKTREES_TEXT).toHaveLength(583)
    expect(orchestrationRowFailures(LEGACY_WORKTREES_TEXT)).toEqual(ORCHESTRATION_ROW_PHRASES)
    const withoutException = text.split('. ')
      .filter((sentence) => !/Orchestration|34px/.test(sentence)).join('. ')
    expect(orchestrationRowFailures(text)).toEqual([])
    expect(orchestrationRowFailures(withoutException).length).toBeGreaterThan(0)
  })

  test(`${theme}: Worktrees guidance stays one ASCII line within the context limit`, () => {
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).not.toMatch(/[\r\n]/)
    expect(text).toMatch(/^[\x20-\x7e]+$/)
  })
}

test('each theme receives the five sorted, cited host rules and checked-in token values', () => {
  for (const theme of ['dark', 'light'] as const) {
    const context = hostContractContext(target('host:palette', 'Untrusted title'), theme)
    expect(Object.keys(context).sort()).toEqual(['rules', 'schemaVersion', 'targetId', 'theme'])
    expect(context).toMatchObject({ schemaVersion: 1, targetId: 'host:palette', theme })
    expect(context.rules.map(({ id }) => id)).toEqual(RULE_IDS)
    for (const rule of context.rules) {
      expect(Object.keys(rule).sort()).toEqual(['id', 'source', 'text'])
      for (const citation of SOURCE_CITATIONS[rule.id]!) expect(rule.source).toContain(citation)
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
  expect(rule('host-underline-tabs')).toMatch(/Other standalone Tabs.*boxed default/i)

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

for (const theme of ['dark', 'light'] as const) {
  const context = hostContractContext(target('host:palette', 'Palette'), theme)
  const text = context.rules.find(({ id }) => id === 'host-underline-tabs')!.text

  test(`${theme}: tool-panel header tabs are compact rather than boxed or underline`, () => {
    expect(treatmentFailures(text, 'header')).toEqual([])
  })

  test(`${theme}: Worktrees saved-view tabs use their own scrolling strip`, () => {
    expect(treatmentFailures(text, 'savedViews')).toEqual([])
  })

  test(`${theme}: the underline tablist bottom rule belongs only to Open views and palette scope`, () => {
    expect(text).toMatch(/Open views and palette Search scope[^.]*ui-tabs ui-tabs--underline[^.]*1px solid var\(--ui-border\) bottom rule/)
    expect(text).toContain('inset 2px bottom accent underline')
    expect(text.indexOf('1px solid var(--ui-border) bottom rule')).toBeLessThan(text.indexOf('ToolPanelFrame header tabs'))
  })

  test(`${theme}: boxed defaults apply only to other standalone Tabs`, () => {
    expect(treatmentFailures(text, 'standalone')).toEqual([])
    expect(text).toMatch(/Other standalone Tabs[^.]*keep their existing boxed default/)
    expect(text).not.toMatch(/This governs Open views and palette Search scope; other Tabs keep their existing boxed default/)
  })

  test(`${theme}: approved treatments do not excuse real tab defects`, () => {
    expect(text).toContain("A tablist that matches its own treatment is not a defect for lacking another treatment's border, underline or box")
    expect(text).toContain('Clipped or partial labels, unreadable text, a missing selected state and overlap remain defects')
  })

  test(`${theme}: the legacy blanket rule fails each treatment distinction`, () => {
    const legacyContext = {
      ...context,
      rules: context.rules.map((rule) => rule.id === 'host-underline-tabs' ? { ...rule, text: LEGACY_TAB_TEXT } : rule)
    }
    const legacyText = legacyContext.rules.find(({ id }) => id === 'host-underline-tabs')!.text
    expect(legacyText).toHaveLength(497)
    for (const treatment of ['header', 'savedViews', 'standalone'] as const) {
      expect(treatmentFailures(text, treatment)).toEqual([])
      expect(treatmentFailures(legacyText, treatment)).toEqual([...TREATMENT_PHRASES[treatment]])
    }
  })

  test(`${theme}: tab guidance fits the gate and single-line prompt context`, () => {
    expect(text.length).toBeLessThanOrEqual(3000)
    expect(text).not.toMatch(/[\r\n]/)
  })
}

test('the tab guidance retires the digest recorded in docs/quirk/evidence/g3-68-plugin-baseline.md', () => {
  const context = hostContractContext(target('view:quirky.accounts/session-accessory', 'Accounts'), 'dark')
  expect(digest(serializeContractContext(context))).not.toBe('a42800e1234e171fcf18cf045ea18eaa208d2f102fa46cb2626950aa58a969cf')
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
