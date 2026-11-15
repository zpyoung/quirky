import { describe, expect, spyOn, test } from 'bun:test'
import * as ts from 'typescript'
import type { Candidate, CoverageFile, Evidence, PluginInventory, Ref, SourceFile } from './contracts'
import { createEvidenceResolver, parseCoverage, resolveRef, resolveTarget, resolveVia, selectCandidate } from './audit-evidence'
import type { ResolvedRef } from './audit-evidence'

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

function routeArgument(content: string, path = file): { source: ts.SourceFile; expression: ts.Expression } {
  const parsed = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0]) found = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (!found) throw new Error('Missing route argument')
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
} satisfies CoverageFile

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

  test('rejects empty anchors for every entry kind', () => {
    const state = { ...coverage.states[0], anchor: '' }
    const notState = { ...coverage.notState[0], anchor: '' }
    const actionKinds = [
      { site: { file, quote: 'onClick' }, anchor: '', route: { invoke: { file, quote: 'context.call(API)' }, target: 'acme.app/save' } },
      { site: { file, quote: 'onClick' }, anchor: '', transient: 'caret', reason: 'Moves the caret' },
      { site: { file, quote: 'onClick' }, anchor: '', notAction: 'forwarded', reason: 'Passes the callback through' }
    ]
    const invalidEntries = [
      { ...coverage, states: [state] },
      { ...coverage, notState: [notState] },
      ...actionKinds.map((action) => ({ ...coverage, actions: [action] }))
    ]

    for (const invalid of invalidEntries) expect(() => parseCoverage(JSON.stringify(invalid))).toThrow()
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

  test('keeps diagnostic locations fresh when the captured source is edited in place', () => {
    const captured = source(file, 'if (busy) return <EmptyState />\n')
    const inventory = plugin([captured])
    const original = resolveRef(inventory, [file], ref('if (busy)'))
    if (evidence(original)) throw new Error(original.message)
    captured.content = '// heading\nif (busy) return <EmptyState />\nif (busy) return null\n'
    expect(resolveRef(inventory, [file], ref('if (busy)'))).toMatchObject({
      code: 'evidence-ambiguous',
      source: { file, line: 2, column: 1 }
    })
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

  test('requires exact anchor text while selecting same-start anchors independently', () => {
    const resolved = resolveRef(inventory, [file], ref('if (busy) return <EmptyState />;\nif (empty)'))
    expect(evidence(resolved)).toBe(false)
    if (!evidence(resolved)) {
      expect(selectCandidate(resolved, candidates, 'state')).toMatchObject({ code: 'site-anchor-ambiguous', basis: 'source-audit' })
      expect(selectCandidate(resolved, candidates, 'state', 'if (empty)')).toBe(candidates[2])
      expect(selectCandidate(resolved, candidates, 'state', 'if (e')).toMatchObject({ code: 'site-anchor-ambiguous' })
      expect(selectCandidate(resolved, candidates, 'state', 'busy')).toMatchObject({ code: 'site-anchor-ambiguous' })
    }

    const overlappingQuote = resolveRef(inventory, [file], ref('if (empty) return <EmptyState />'))
    expect(evidence(overlappingQuote)).toBe(false)
    if (!evidence(overlappingQuote)) {
      const start = content.indexOf('if (empty)')
      const overlappingCandidates: Candidate[] = [
        { ...candidates[2]!, anchorEnd: start + 'if (empty)'.length, anchorText: 'if (empty)' },
        { ...candidates[2]!, anchorEnd: start + 'if (empty) return'.length, anchorText: 'if (empty) return' }
      ]
      expect(selectCandidate(overlappingQuote, overlappingCandidates, 'state', 'if (empty)')).toBe(overlappingCandidates[0])
      expect(selectCandidate(overlappingQuote, overlappingCandidates, 'state', 'if (empty) return')).toBe(overlappingCandidates[1])
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

  test('rechecks imported route constants after an in-place snapshot edit', () => {
    const ids = 'plugins/acme.app/src/ids.ts'
    const content = "import { API } from './ids'; context.call(API)"
    const imported = source(ids, "export const API = 'acme.app/save'")
    const inventory = plugin([source(file, content), imported])
    const parsed = routeArgument(content)
    expect(resolveTarget(inventory, [file, ids], parsed.source, parsed.expression)).toBe('acme.app/save')
    imported.content = "export const API = 'acme.app/remove'"
    expect(resolveTarget(inventory, [file, ids], parsed.source, parsed.expression)).toBe('acme.app/remove')
    imported.content = 'export const API = chooseRoute()'
    expect(resolveTarget(inventory, [file, ids], parsed.source, parsed.expression)).toBeUndefined()
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

  test('does not resolve local or imported constants shadowed at the expression use', () => {
    const cases = [
      "const API = 'acme.app/save'; function Component(API: string) { return <button onClick={() => context.call(API)} /> }",
      "const API = 'acme.app/save'; function use(API: string) { context.call(API) }",
      "const API = 'acme.app/save'; const use = (API: string) => context.call(API)",
      "const API = 'acme.app/save'; function use({ API }: { API: string }) { context.call(API) }",
      "const API = 'acme.app/save'; { context.call(API); let API: string }",
      "const API = 'acme.app/save'; { context.call(API); const API = 'other/save' }",
      "const API = 'acme.app/save'; try {} catch (API) { context.call(API) }",
      "const API = 'acme.app/save'; function use() { context.call(API); if (false) { var API = 'other/save' } }",
      "const API = 'acme.app/'; function use(API: string) { context.call(`${API}save`) }"
    ]
    for (const content of cases) {
      const parsed = routeArgument(content)
      expect(resolveTarget(plugin([source(file, content)]), [file], parsed.source, parsed.expression)).toBeUndefined()
    }
  })

  test('does not resolve an imported constant shadowed by a local parameter', () => {
    const ui = 'plugins/acme.app/src/ui.tsx'
    const ids = 'plugins/acme.app/src/ids.ts'
    const content = "import { API } from './ids'; function use(API: string) { context.call(API) }"
    const parsed = routeArgument(content, ui)

    expect(resolveTarget(
      plugin([source(ui, content), source(ids, "export const API = 'acme.app/save'")]),
      [ui, ids],
      parsed.source,
      parsed.expression
    )).toBeUndefined()
  })

  test('resolves an unshadowed constant through empty loop initializers and unrelated nested bindings', () => {
    const cases = [
      "const API = 'acme.app/save'; for (;;) { context.call(API); break }",
      "const API = 'acme.app/save'; function use() { { let API = 'other/save' } context.call(API) }"
    ]
    for (const content of cases) {
      const parsed = routeArgument(content)
      expect(resolveTarget(plugin([source(file, content)]), [file], parsed.source, parsed.expression)).toBe('acme.app/save')
    }
  })
})

describe('snapshot-scoped evidence resolution', () => {
  test('reuses one parsed source without bypassing quote and path validation', () => {
    const content = 'const a = 1\nconst b = 2\nconst duplicate = "same same"\n'
    const missingSourceFile = 'plugins/acme.app/src/missing.tsx'
    const inventory = plugin([source(file, content)])
    const parser = spyOn(ts, 'createSourceFile')

    try {
      const resolver = createEvidenceResolver(inventory, [file, missingSourceFile])
      const first = resolver.resolveRef(ref('const a = 1'))
      const second = resolver.resolveRef(ref('const b = 2'))
      const ambiguous = resolver.resolveRef(ref('same'))

      expectResolved(first)
      expectResolved(second)
      expect(first.source).toBe(second.source)
      expect(first.start).toBe(0)
      expect(second.start).toBe(12)
      expect(parser).toHaveBeenCalledTimes(1)
      expect(parser).toHaveBeenCalledWith(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      expect(ambiguous).toMatchObject({
        code: 'evidence-ambiguous',
        message: `Evidence quote occurs more than once in ${file}: "same"`,
        basis: 'source-audit',
        source: { file, line: 3, column: 20 }
      })

      expect(resolver.resolveRef(ref(''))).toMatchObject({
        code: 'evidence-missing',
        message: `Evidence quote is empty in ${file}`,
        basis: 'source-audit'
      })
      for (const quote of ['not present', 'const a = 3']) {
        expect(resolver.resolveRef(ref(quote))).toMatchObject({
          code: 'evidence-missing',
          message: `Evidence quote was not found in ${file}: ${JSON.stringify(quote)}`,
          basis: 'source-audit'
        })
      }

      const invalidPaths = [
        `/repo/${file}`,
        'C:/plugins/acme.app/src/ui.tsx',
        'plugins/acme.app/../other.tsx',
        'plugins/acme.app/src/./ui.tsx',
        'plugins/acme.app/src//ui.tsx',
        'plugins\\acme.app\\src\\ui.tsx',
        'plugins/acme.app/src/other.tsx'
      ]
      for (const invalidPath of invalidPaths) {
        expect(resolver.resolveRef(ref('const a = 1', invalidPath))).toMatchObject({
          code: 'evidence-path-invalid',
          message: `Evidence file is not a canonical UI path in the plugin graph: ${invalidPath}`,
          basis: 'source-audit'
        })
      }
      expect(resolver.resolveRef(ref('anything', missingSourceFile))).toMatchObject({
        code: 'evidence-path-invalid',
        message: `Evidence file has no captured source: ${missingSourceFile}`,
        basis: 'source-audit'
      })
      expect(parser).toHaveBeenCalledTimes(1)
    } finally {
      parser.mockRestore()
    }
  })

  test('uses the first captured source and parses lazily', () => {
    const firstContent = 'const first = 1\n'
    const secondContent = 'const second = 2\n'
    const inventory = plugin([source(file, firstContent), source(file, secondContent)])
    const parser = spyOn(ts, 'createSourceFile')

    try {
      const resolver = createEvidenceResolver(inventory, [file])
      expect(parser).not.toHaveBeenCalled()

      const first = resolver.resolveRef(ref('const first = 1'))
      expectResolved(first)
      expect(first.source.text).toBe(firstContent)
      expect(resolver.resolveRef(ref('const second = 2'))).toMatchObject({
        code: 'evidence-missing',
        basis: 'source-audit'
      })
      expect(parser).toHaveBeenCalledTimes(1)
      expect(parser).toHaveBeenCalledWith(file, firstContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    } finally {
      parser.mockRestore()
    }
  })

  test('preserves the JSX parser kind for JSX evidence', () => {
    const jsxFile = 'plugins/acme.app/src/widget.jsx'
    const content = '<button />'
    const parser = spyOn(ts, 'createSourceFile')

    try {
      const resolver = createEvidenceResolver(plugin([source(jsxFile, content)]), [jsxFile])
      const result = resolver.resolveRef(ref('<button />', jsxFile))
      expectResolved(result)
      expect(parser).toHaveBeenCalledTimes(1)
      expect(parser).toHaveBeenCalledWith(jsxFile, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
    } finally {
      parser.mockRestore()
    }
  })

  test('keeps overlapping quote occurrences ambiguous', () => {
    const overlapFile = 'plugins/acme.app/src/overlap.ts'
    const result = resolveRef(plugin([source(overlapFile, 'aaa')]), [overlapFile], ref('aa', overlapFile))

    expect(result).toMatchObject({
      code: 'evidence-ambiguous',
      message: `Evidence quote occurs more than once in ${overlapFile}: "aa"`,
      basis: 'source-audit',
      source: { file: overlapFile, line: 1, column: 1 }
    })
  })

  test('shares imported-target parsing with evidence quotes in the imported file', () => {
    const ui = 'plugins/acme.app/src/ui.tsx'
    const ids = 'plugins/acme.app/src/ids.ts'
    const uiContent = "import { API as prefix } from './ids';\ncontext.call(`${prefix}`)\ncontext.call(prefix)"
    const idsContent = "export const API = 'acme.app/save'\n"
    const identifier = expression(uiContent, 'prefix', ui)
    const template = expression(uiContent, '`${prefix}`', ui)
    const parser = spyOn(ts, 'createSourceFile')

    try {
      const resolver = createEvidenceResolver(plugin([source(ui, uiContent), source(ids, idsContent)]), [ui, ids])
      const results = Array.from({ length: 4 }, () => resolver.resolveTarget(identifier.source, identifier.expression))
      expect(results).toEqual(['acme.app/save', 'acme.app/save', 'acme.app/save', 'acme.app/save'])
      expect(resolver.resolveTarget(template.source, template.expression)).toBe('acme.app/save')

      const importedEvidence = resolver.resolveRef(ref("export const API = 'acme.app/save'", ids))
      expectResolved(importedEvidence)
      expect(importedEvidence.start).toBe(0)
      expect(parser).toHaveBeenCalledTimes(1)
      expect(parser).toHaveBeenCalledWith(ids, idsContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      expect(parser.mock.calls.map(([path]) => path)).toEqual([ids])
      expect(parser.mock.results[0]?.value).toBe(importedEvidence.source)
      expect(importedEvidence.source.languageVersion).toBe(ts.ScriptTarget.Latest)
      expect(importedEvidence.source.statements[0]?.parent).toBe(importedEvidence.source)
    } finally {
      parser.mockRestore()
    }
  })

  test('keeps unsupported imported target forms unresolved', () => {
    const ui = 'plugins/acme.app/src/ui.tsx'
    const ids = 'plugins/acme.app/src/ids.ts'
    const outside = 'plugins/other/ids.ts'
    const cases: { content: string; files: string[]; extraSources?: SourceFile[] }[] = [
      {
        content: "import { API } from './ids'; function use(API: string) { context.call(API) }",
        files: [ui, ids],
        extraSources: [source(ids, "export const API = 'acme.app/save'")]
      },
      {
        content: "import { API } from './ids'; context.call(API)",
        files: [ui, ids],
        extraSources: [source(ids, "const PREFIX = 'acme.app/'; export const API = PREFIX")]
      },
      {
        content: "import { API } from './ids'; context.call(API)",
        files: [ui, ids],
        extraSources: [source(ids, 'export const API = makeApi()')]
      },
      {
        content: "import { type API } from './ids'; context.call(API)",
        files: [ui, ids],
        extraSources: [source(ids, "export const API = 'acme.app/save'")]
      },
      {
        content: "import { API } from './missing'; context.call(API)",
        files: [ui]
      },
      {
        content: "import { API } from '../../other/ids.ts'; context.call(API)",
        files: [ui, outside],
        extraSources: [source(outside, "export const API = 'acme.app/save'")]
      }
    ]

    for (const scenario of cases) {
      const parsed = routeArgument(scenario.content, ui)
      const resolver = createEvidenceResolver(
        plugin([source(ui, scenario.content), ...(scenario.extraSources ?? [])]),
        scenario.files
      )
      expect(resolver.resolveTarget(parsed.source, parsed.expression)).toBeUndefined()
    }
  })

  test('keeps text and graph membership snapshots isolated between sessions', () => {
    const originalContent = 'const a = 1\nconst b = 2\nconst duplicate = "same same"\n'
    const changedContent = '\nconst a = 3\nconst b = 2\nconst duplicate = "same same"\n'
    const addedFile = 'plugins/acme.app/src/added.tsx'
    const captured = source(file, originalContent)
    const inventory = plugin([captured, source(addedFile, 'added source')])
    const files = [file]
    const parser = spyOn(ts, 'createSourceFile')

    try {
      const firstSession = createEvidenceResolver(inventory, files)
      const firstA = firstSession.resolveRef(ref('const a = 1'))
      const firstB = firstSession.resolveRef(ref('const b = 2'))
      expectResolved(firstA)
      expectResolved(firstB)
      expect(firstA.source).toBe(firstB.source)
      expect(firstA.start).toBe(0)
      expect(firstB.start).toBe(12)

      captured.content = changedContent
      files.push(addedFile)

      const firstStillOriginal = firstSession.resolveRef(ref('const a = 1'))
      const firstRejectsChangedText = firstSession.resolveRef(ref('const a = 3'))
      const firstRejectsAddedPath = firstSession.resolveRef(ref('', addedFile))
      expectResolved(firstStillOriginal)
      expect(firstStillOriginal.source).toBe(firstA.source)
      expect(firstStillOriginal.start).toBe(0)
      expect(firstRejectsChangedText).toMatchObject({ code: 'evidence-missing', basis: 'source-audit' })
      expect(firstRejectsAddedPath).toMatchObject({ code: 'evidence-path-invalid', basis: 'source-audit' })

      const secondSession = createEvidenceResolver(inventory, files)
      const secondA = secondSession.resolveRef(ref('const a = 3'))
      const secondB = secondSession.resolveRef(ref('const b = 2'))
      const secondRejectsOldText = secondSession.resolveRef(ref('const a = 1'))
      const secondSeesAddedPath = secondSession.resolveRef(ref('', addedFile))
      expectResolved(secondA)
      expectResolved(secondB)
      expect(secondA.source).toBe(secondB.source)
      expect(secondA.source).not.toBe(firstA.source)
      expect(secondA.start).toBe(1)
      expect(secondB.start).toBe(13)
      expect(secondRejectsOldText).toMatchObject({ code: 'evidence-missing', basis: 'source-audit' })
      expect(secondSeesAddedPath).toMatchObject({ code: 'evidence-missing', basis: 'source-audit' })

      expect(parser).toHaveBeenCalledTimes(2)
      expect(parser.mock.calls.map(([path]) => path)).toEqual([file, file])
      expect(parser).toHaveBeenCalledWith(file, originalContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      expect(parser).toHaveBeenCalledWith(file, changedContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    } finally {
      parser.mockRestore()
    }
  })

  test('standalone wrappers observe current source inputs on every call', () => {
    const captured = source(file, 'const a = 1\n')
    const inventory = plugin([captured])
    const first = resolveRef(inventory, [file], ref('const a = 1'))
    expectResolved(first)

    captured.content = 'const a = 2\n'
    expect(resolveRef(inventory, [file], ref('const a = 1'))).toMatchObject({
      code: 'evidence-missing',
      basis: 'source-audit'
    })
    const changed = resolveRef(inventory, [file], ref('const a = 2'))
    expectResolved(changed)
    expect(changed.source).not.toBe(first.source)

    const ui = 'plugins/acme.app/src/routes.tsx'
    const ids = 'plugins/acme.app/src/ids.ts'
    const uiContent = "import { API } from './ids';\ncontext.call(API)"
    const parsed = routeArgument(uiContent, ui)
    const imported = source(ids, "export const API = 'acme.app/old'")
    const routeInventory = plugin([source(ui, uiContent), imported])
    const files = [ui, ids]
    expect(resolveTarget(routeInventory, files, parsed.source, parsed.expression)).toBe('acme.app/old')

    imported.content = "export const API = 'acme.app/new'"
    expect(resolveTarget(routeInventory, files, parsed.source, parsed.expression)).toBe('acme.app/new')
  })
})

function expectResolved(value: ResolvedRef | Evidence): asserts value is ResolvedRef {
  if (evidence(value)) throw new Error(`Expected a resolved reference, received ${value.code}`)
}
