import { describe, expect, test } from 'bun:test'
import * as ts from 'typescript'
import type { Candidate, Evidence, PluginInventory, Ref, SourceFile } from './contracts'
import { parseCoverage, resolveRef, resolveTarget, resolveVia, selectCandidate } from './audit-evidence'

const file = 'plugins/acme.app/src/ui.tsx'
const source = (path: string, content: string): SourceFile => ({ file: path, content })

function plugin(sources: SourceFile[], overrides: Partial<PluginInventory> = {}): PluginInventory {
  return {
    id: 'acme.app', directory: 'plugins/acme.app', hasUi: true,
    targets: ['view:acme.app/main'], sources, ...overrides
  }
}

function evidence(value: unknown): value is Evidence {
  return typeof value === 'object' && value !== null && 'code' in value
}

function ref(text: string, path = file): Ref {
  return { file: path, quote: text }
}

function expression(content: string, text: string, path = file): { source: ts.SourceFile; expression: ts.Expression } {
  const parsed = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && node.getText(parsed) === text) found = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (!found) throw new Error(`Missing expression: ${text}`)
  return { source: parsed, expression: found }
}

const coverage = {
  schemaVersion: 1,
  surfaces: { 'view:acme.app/main': {
    loading: { applicable: true }, empty: { applicable: false, reason: 'No empty state', evidence: [{ file, quote: 'rows' }] },
    error: { applicable: true }
  } },
  states: [{ surface: 'view:acme.app/main', state: 'loading', site: { file, quote: 'if (busy)' },
    render: { component: 'EmptyState', element: { file, quote: '<EmptyState />' }, import: { file, quote: "import { EmptyState } from '@quirky/ui'" } } }],
  notState: [{ site: { file, quote: 'const x = 1' }, reason: 'Not a user state' }],
  actions: [{ site: { file, quote: 'onClick' }, route: { invoke: { file, quote: 'context.call(API)' }, target: 'acme.app/save' } }]
}

describe('coverage file parsing', () => {
  test('accepts a complete coverage file with each supported entry shape', () => {
    expect(parseCoverage(JSON.stringify(coverage))).toEqual(coverage)
  })

  test('rejects malformed JSON, duplicate keys at any depth, and unknown keys', () => {
    const duplicate = JSON.stringify(coverage).replace('"loading":{"applicable":true}', '"loading":{"applicable":true,"applicable":true}')
    const unknown = JSON.stringify({ ...coverage, extra: true })
    const unknownNested = JSON.stringify({ ...coverage, states: [{ ...coverage.states[0], render: { ...coverage.states[0]!.render, extra: true } }] })
    expect(() => parseCoverage('{')).toThrow()
    expect(() => parseCoverage(duplicate)).toThrow()
    expect(() => parseCoverage(unknown)).toThrow()
    expect(() => parseCoverage(unknownNested)).toThrow()
  })

  test('rejects invalid version, missing arrays, false decisions without evidence, and empty quotes', () => {
    expect(() => parseCoverage(JSON.stringify({ ...coverage, schemaVersion: 2 }))).toThrow()
    const missingActions: Partial<typeof coverage> = { ...coverage }
    delete missingActions.actions
    expect(() => parseCoverage(JSON.stringify(missingActions))).toThrow()
    const falseDecisionWithoutEvidence = {
      ...coverage,
      surfaces: { 'view:acme.app/main': { ...coverage.surfaces['view:acme.app/main'], empty: { applicable: false } } }
    }
    expect(() => parseCoverage(JSON.stringify(falseDecisionWithoutEvidence))).toThrow()
    const emptyQuote = { ...coverage, states: [{ ...coverage.states[0], site: { file, quote: '' } }] }
    expect(() => parseCoverage(JSON.stringify(emptyQuote))).toThrow()
  })
})

describe('source quote resolution', () => {
  test('resolves unique quotes and reports the shifted display location after unrelated edits', () => {
    const content = 'if (busy) return <EmptyState />\n'
    const inventory = plugin([source(file, content)])
    const original = resolveRef(inventory, [file], ref('if (busy)'))
    const shiftedContent = `const unused = 1\n${content}`
    const shifted = resolveRef(plugin([source(file, shiftedContent)]), [file], ref('if (busy)'))

    expect(evidence(original)).toBe(false)
    expect(evidence(shifted)).toBe(false)
    if (!evidence(original) && !evidence(shifted)) {
      expect(original).toMatchObject({ start: 0, text: 'if (busy)' })
      expect(shifted.source.getLineAndCharacterOfPosition(shifted.start)).toEqual({ line: 1, character: 0 })
    }
  })

  test('returns evidence-missing for changed and deleted witnesses', () => {
    const content = 'if (busy) return <EmptyState message="Loading entries" />\n'
    const result = resolveRef(plugin([source(file, content)]), [file], ref('<EmptyState message="Loading items" />'))
    expect(result).toMatchObject({ code: 'evidence-missing', basis: 'source-audit' })
  })

  test('returns evidence-ambiguous for a duplicated witness', () => {
    const content = 'if (busy) return <EmptyState />\nif (busy) return <EmptyState />'
    const result = resolveRef(plugin([source(file, content)]), [file], ref('if (busy)'))
    expect(result).toMatchObject({ code: 'evidence-ambiguous', basis: 'source-audit', source: { file, line: 1 } })
  })

  test('rejects absolute, traversing, backslash, and out-of-graph ref paths', () => {
    const inventory = plugin([source(file, 'if (busy)')])
    for (const badPath of ['/repo/plugins/acme.app/src/ui.tsx', 'plugins/acme.app/../other.tsx', 'plugins\\acme.app\\src\\ui.tsx', 'plugins/acme.app/src/other.tsx']) {
      const result = resolveRef(inventory, [file], ref('if (busy)', badPath))
      expect(result).toMatchObject({ code: 'evidence-path-invalid', basis: 'source-audit' })
    }
  })
})

describe('candidate anchor selection', () => {
  const content = 'if (busy) return <EmptyState />;\nif (empty) return <EmptyState />'
  const inventory = plugin([source(file, content)])
  const candidates: Candidate[] = [
    { category: 'state', kind: 'branch-return', file, anchorStart: 0, anchorEnd: 'if (busy)'.length, anchorText: 'if (busy)' },
    { category: 'state', kind: 'shared-render', file, anchorStart: content.indexOf('<EmptyState'), anchorEnd: content.indexOf('<EmptyState') + '<EmptyState'.length, anchorText: '<EmptyState' },
    { category: 'state', kind: 'branch-return', file, anchorStart: content.indexOf('if (empty)'), anchorEnd: content.indexOf('if (empty)') + 'if (empty)'.length, anchorText: 'if (empty)' }
  ]

  test('maps the sole candidate whose anchor is contained in the quote', () => {
    const resolved = resolveRef(inventory, [file], ref('if (busy)'))
    expect(evidence(resolved)).toBe(false)
    if (!evidence(resolved)) expect(selectCandidate(resolved, candidates, 'state')).toBe(candidates[0])
  })

  test('reports site-not-candidate when a quote contains no anchor of its category', () => {
    const resolved = resolveRef(inventory, [file], ref('if (busy)'))
    expect(evidence(resolved)).toBe(false)
    if (!evidence(resolved)) expect(selectCandidate(resolved, candidates, 'action')).toMatchObject({ code: 'site-not-candidate', basis: 'source-audit' })
  })

  test('validates an explicit anchor even when the quote holds one candidate', () => {
    const resolved = resolveRef(inventory, [file], ref('if (busy)'))
    if (evidence(resolved)) throw new Error(resolved.message)
    expect(selectCandidate(resolved, candidates, 'state', 'busy')).toMatchObject({ code: 'site-anchor-ambiguous' })
  })

  test('uses a unique anchor prefix at the candidate start to disambiguate', () => {
    const resolved = resolveRef(inventory, [file], ref('if (busy) return <EmptyState />;\nif (empty)'))
    expect(evidence(resolved)).toBe(false)
    if (!evidence(resolved)) {
      expect(selectCandidate(resolved, candidates, 'state')).toMatchObject({ code: 'site-anchor-ambiguous', basis: 'source-audit' })
      expect(selectCandidate(resolved, candidates, 'state', 'if (e')).toBe(candidates[2])
      expect(selectCandidate(resolved, candidates, 'state', 'busy')).toMatchObject({ code: 'site-anchor-ambiguous' })
    }
  })
})

describe('via declarations', () => {
  test('resolves a complete function declaration and const arrow/function expressions', () => {
    const functionText = 'function Busy() { return <div /> }'
    const functionRef = resolveRef(plugin([source(file, functionText)]), [file], ref(functionText))
    const arrowText = 'const Busy = () => <div />'
    const arrowRef = resolveRef(plugin([source(file, arrowText)]), [file], ref(arrowText))
    const expressionText = 'const Busy = function() { return null }'
    const expressionRef = resolveRef(plugin([source(file, expressionText)]), [file], ref(expressionText))

    expect(evidence(functionRef)).toBe(false)
    expect(evidence(arrowRef)).toBe(false)
    expect(evidence(expressionRef)).toBe(false)
    if (!evidence(functionRef) && !evidence(arrowRef) && !evidence(expressionRef)) {
      expect(resolveVia(functionRef)).toMatchObject({ name: 'Busy' })
      expect(resolveVia(arrowRef)).toMatchObject({ name: 'Busy' })
      expect(resolveVia(expressionRef)).toMatchObject({ name: 'Busy' })
    }
  })

  test('does not count nested body functions separately', () => {
    const text = 'function Busy() { function nested() { return null } return null }'
    const resolved = resolveRef(plugin([source(file, text)]), [file], ref(text))
    expect(evidence(resolved)).toBe(false)
    if (!evidence(resolved)) expect(resolveVia(resolved)).toMatchObject({ name: 'Busy' })
  })

  test('rejects partial declarations and quotes containing multiple declarations', () => {
    const text = 'function Busy() { return null }\nfunction Ready() { return null }'
    const inventory = plugin([source(file, text)])
    const partial = resolveRef(inventory, [file], ref('function Busy() {'))
    const multiple = resolveRef(inventory, [file], ref(text))
    expect(evidence(partial)).toBe(false)
    expect(evidence(multiple)).toBe(false)
    if (!evidence(partial)) expect(resolveVia(partial)).toMatchObject({ code: 'via-invalid', basis: 'source-audit' })
    if (!evidence(multiple)) expect(resolveVia(multiple)).toMatchObject({ code: 'via-invalid', basis: 'source-audit' })
  })
})

describe('one-hop route target resolution', () => {
  test('resolves literals, same-file constants, imported constants, and template substitutions', () => {
    const ui = 'plugins/acme.app/src/ui.tsx'
    const ids = 'plugins/acme.app/src/ids.ts'
    const content = "const API = 'acme.app/';\ncontext.call(`${API}save`)"
    const parsed = expression(content, '`${API}save`', ui)
    expect(resolveTarget(plugin([source(ui, content)]), [ui], parsed.source, parsed.expression)).toBe('acme.app/save')

    const importedContent = "import { API as prefix } from './ids';\ncontext.call(`${prefix}save`)"
    const imported = expression(importedContent, '`${prefix}save`', ui)
    expect(resolveTarget(plugin([source(ui, importedContent), source(ids, "export const API = 'acme.app/'")]), [ui, ids], imported.source, imported.expression)).toBe('acme.app/save')

    const literalContent = "export const SETTINGS = 'view:acme.app/main';\ncontext.openView(SETTINGS)"
    const literal = expression(literalContent, 'SETTINGS', ui)
    expect(resolveTarget(plugin([source(ui, literalContent)]), [ui], literal.source, literal.expression)).toBe('view:acme.app/main')
  })

  test('does not follow a second constant hop or evaluate calls and interpolated const initializers', () => {
    const cases = [
      "const FIRST = 'acme.app/'; const API = FIRST; context.call(`${API}save`)",
      "const API = makeApi(); context.call(`${API}save`)",
      "const PREFIX = 'acme.app/'; const API = `${PREFIX}`; context.call(`${API}save`)",
      'function use(methodName: string) { context.call(methodName) }'
    ]
    for (const content of cases) {
      const targetText = content.includes('methodName') ? 'methodName' : content.includes('context.call(`${API}save`)') ? '`${API}save`' : 'API'
      const parsed = expression(content, targetText)
      expect(resolveTarget(plugin([source(file, content)]), [file], parsed.source, parsed.expression)).toBeUndefined()
    }
  })
})
