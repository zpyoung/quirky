import { describe, expect, test } from 'bun:test'
import type { Candidate, PluginInventory, SourceFile } from './contracts'
import { discoverCandidates, discoverUiFiles } from './audit-discovery'

const source = (file: string, content: string): SourceFile => ({ file, content })

function plugin(sources: SourceFile[], overrides: Partial<PluginInventory> = {}): PluginInventory {
  return { id: 'acme.app', directory: 'plugins/acme.app', hasUi: true, targets: [], sources, ...overrides }
}

const STATE_KINDS: Record<string, true> = {
  'conditional-render': true, 'branch-return': true, 'branch-dom-write': true, 'shared-render': true,
  'toast-call': true, 'status-role': true, 'state-text': true
}

function candidateFor(content: string, candidates: readonly Candidate[], kind: string, anchorText: string) {
  const candidate = candidates.find((item) => item.kind === kind && item.anchorText === anchorText)
  expect(candidate, `${kind}: ${anchorText}`).toBeDefined()
  expect(candidate!.category).toBe(STATE_KINDS[kind] ? 'state' : 'action')
  expect(Object.keys(candidate!).sort()).toEqual(['anchorEnd', 'anchorStart', 'anchorText', 'category', 'file', 'kind'])
  expect(content.slice(candidate!.anchorStart, candidate!.anchorEnd)).toBe(anchorText)
  return candidate!
}

test('discovers JSX child conditionals without double-counting attribute literals or classifying attribute calculations', () => {
  const file = 'plugins/acme.app/src/ui.tsx'
  const content = "export function Main() { return <div title={show ? 'yes' : 'no'} message={'Loading rows'}>{show && count}</div> }"
  const candidates = discoverCandidates(plugin([source(file, content)]), [file])
  expect(candidates.filter((item) => item.kind === 'conditional-render').map((item) => item.anchorText)).toEqual(['show &&'])
  expect(candidates.filter((item) => item.kind === 'state-text').map((item) => item.anchorText)).toEqual(["'Loading rows'"])
})

describe('UI source discovery', () => {
  test('follows relative, re-exported, dynamic and index modules with JavaScript-to-TypeScript resolution', () => {
    const inventory = plugin([
      source('plugins/acme.app/src/ui.tsx', "import './base'; export { item } from './reexport'; void import('./lazy.js'); import './nested'"),
      source('plugins/acme.app/src/base.ts', 'export const base = 1'),
      source('plugins/acme.app/src/reexport.ts', "export * from './views/index.js'"),
      source('plugins/acme.app/src/views/index.tsx', "export { item } from './leaf'"),
      source('plugins/acme.app/src/views/leaf.ts', 'export const item = 1'),
      source('plugins/acme.app/src/lazy.tsx', 'export const lazy = 1'),
      source('plugins/acme.app/src/nested/index.ts', 'export const nested = 1'),
      source('plugins/acme.app/src/main.ts', 'setTimeout(() => {}, 30_000)')
    ])

    const result = discoverUiFiles(inventory)

    expect(result.failures).toEqual([])
    expect(result.files).toEqual([
      'plugins/acme.app/src/base.ts',
      'plugins/acme.app/src/lazy.tsx',
      'plugins/acme.app/src/nested/index.ts',
      'plugins/acme.app/src/reexport.ts',
      'plugins/acme.app/src/ui.tsx',
      'plugins/acme.app/src/views/index.tsx',
      'plugins/acme.app/src/views/leaf.ts'
    ])
    expect(result.files).not.toContain('plugins/acme.app/src/main.ts')
  })

  test('resolves dotted code suffixes while preserving explicit-code and non-code import behavior', () => {
    const inventory = plugin([
      source('plugins/acme.app/src/ui.tsx', "import './list.model'; import './explicit.js'; import './missing.ts'; import './styles.css'; import './icon.svg'"),
      source('plugins/acme.app/src/list.model.ts', 'export const model = 1'),
      source('plugins/acme.app/src/explicit.js', 'export const explicit = 1'),
      source('plugins/acme.app/src/explicit.ts', 'export const explicit = 2')
    ])

    const result = discoverUiFiles(inventory)

    expect(result.files).toEqual([
      'plugins/acme.app/src/explicit.js',
      'plugins/acme.app/src/list.model.ts',
      'plugins/acme.app/src/ui.tsx'
    ])
    expect(result.failures.map(({ code, basis }) => ({ code, basis }))).toEqual([
      { code: 'ui-import-unresolved', basis: 'source-audit' }
    ])
  })

  test('reports missing UI entry and unresolved or out-of-plugin imports as source-audit evidence', () => {
    const missingEntry = discoverUiFiles(plugin([source('plugins/acme.app/src/main.ts', 'export {}')]))
    expect(missingEntry.files).toEqual([])
    expect(missingEntry.failures.map(({ code, basis }) => ({ code, basis }))).toEqual([
      { code: 'ui-entry-missing', basis: 'source-audit' }
    ])

    const imports = plugin([source(
      'plugins/acme.app/src/ui.tsx',
      "import './missing'; export * from '../../../packages/shared'"
    )])
    const result = discoverUiFiles(imports)
    expect(result.files).toEqual(['plugins/acme.app/src/ui.tsx'])
    expect(result.failures.map(({ code, basis }) => ({ code, basis }))).toEqual([
      { code: 'ui-import-unresolved', basis: 'source-audit' },
      { code: 'ui-import-outside-plugin', basis: 'source-audit' }
    ])
  })

  test('discovers each state and action candidate kind with an exact source anchor', () => {
    const file = 'plugins/acme.app/src/ui.tsx'
    const content = `
function View({ rows, condition, eventName, handler, node, child }: unknown) {
  if (!rows) return null
  switch (condition) {
    case 'busy': return <p />
    default: return null
  }
  return condition ? <EmptyState message="Loading items" /> : createElement('div', null, 'Nothing found')
}
function actions(node: unknown, condition: boolean, eventName: string, handler: unknown, props: unknown, child: unknown) {
  if (condition) node.textContent = 'Unable to retry'
  if (condition) node.appendChild(child)
  node.addEventListener('click', handler)
  node.addEventListener(eventName, handler)
  node.onclick = handler
  context.toast('Error, try again')
  const propsObject = { onRetry: handler, onChoose() {}, command: 'command:acme.app/run' }
  createElement('div', { ...props, [eventName]: handler }, 'Try again')
  return <>
    <form />
    <form onSubmit={handler} />
    <div role="alert">Nothing here</div>
    <NoticeLine />
    <FormRow error="No details" />
    <button onClick={handler} />
    <button {...props} />
  </>
}
`
    const inventory = plugin([source(file, content)])
    const candidates = discoverCandidates(inventory, [file])

    candidateFor(content, candidates, 'conditional-render', 'condition ?')
    candidateFor(content, candidates, 'branch-return', 'if (!rows)')
    candidateFor(content, candidates, 'branch-return', "case 'busy':")
    candidateFor(content, candidates, 'branch-dom-write', 'if (condition)')
    candidateFor(content, candidates, 'shared-render', '<EmptyState')
    candidateFor(content, candidates, 'shared-render', '<NoticeLine')
    candidateFor(content, candidates, 'shared-render', '<FormRow')
    candidateFor(content, candidates, 'toast-call', 'context.toast(')
    candidateFor(content, candidates, 'status-role', 'role="alert"')
    candidateFor(content, candidates, 'state-text', '"Loading items"')
    candidateFor(content, candidates, 'state-text', "'Nothing found'")
    candidateFor(content, candidates, 'state-text', "'Try again'")
    candidateFor(content, candidates, 'state-text', "'Error, try again'")
    candidateFor(content, candidates, 'state-text', "'Unable to retry'")
    candidateFor(content, candidates, 'state-text', 'Nothing here')

    candidateFor(content, candidates, 'jsx-handler', 'onClick')
    candidateFor(content, candidates, 'jsx-handler', 'onSubmit')
    candidateFor(content, candidates, 'handler-property', 'onRetry')
    candidateFor(content, candidates, 'handler-property', 'onChoose')
    candidateFor(content, candidates, 'event-listener', "node.addEventListener('click'")
    candidateFor(content, candidates, 'handler-assignment', 'node.onclick')
    candidateFor(content, candidates, 'native-form', '<form')
    candidateFor(content, candidates, 'command-entry', "command: 'command:acme.app/run'")
    candidateFor(content, candidates, 'unresolved-spread', '...props')
    candidateFor(content, candidates, 'unresolved-computed', '[eventName]')
    candidateFor(content, candidates, 'unresolved-listener', 'node.addEventListener(eventName')
  })

  test('recognizes render branches inside nested callbacks but skips their control statements', () => {
    const file = 'plugins/acme.app/src/ui.tsx'
    const content = `
function mapped(rows: unknown[]) {
  if (!rows) return null
  return rows.map((row) => <Row />)
}
function conditional(rows: unknown[], ready: boolean) {
  if (!rows) return null
  return ready ? rows.map((row) => <Row />) : null
}
function created(rows: unknown[]) {
  if (!rows) return null
  return rows.map((row) => createElement('Row', null))
}
function nested(rows: unknown[], target: unknown, condition: boolean) {
  if (condition) rows.map(() => { return <Row /> })
  if (target) rows.map(() => { target.textContent = 'value' })
}
`
    const candidates = discoverCandidates(plugin([source(file, content)]), [file])

    expect(candidates.filter((item) => item.kind === 'branch-return').map((item) => item.anchorText)).toEqual([
      'if (!rows)', 'if (!rows)', 'if (!rows)'
    ])
    candidateFor(content, candidates, 'branch-return', 'if (!rows)')
    candidateFor(content, candidates, 'conditional-render', 'ready ?')
    expect(candidates.some((item) => item.kind === 'branch-return' && item.anchorText === 'if (condition)')).toBe(false)
    expect(candidates.some((item) => item.kind === 'branch-dom-write' && item.anchorText === 'if (target)')).toBe(false)
  })

  test('prioritizes branch returns and retains distinct nested logical render anchors', () => {
    const file = 'plugins/acme.app/src/ui.tsx'
    const content = `
function View(rows: unknown[], target: unknown, a: boolean) {
  if (!rows) { target.textContent = ''; return null }
  if (target) target.appendChild(rows)
  target.onclick = () => {}
  return <div>{a && <b /> || <i />}</div>
}
`
    const candidates = discoverCandidates(plugin([source(file, content)]), [file])
    const spans = candidates.map((item) => `${item.category}:${item.anchorStart}:${item.anchorEnd}`)

    candidateFor(content, candidates, 'branch-return', 'if (!rows)')
    candidateFor(content, candidates, 'branch-dom-write', 'if (target)')
    candidateFor(content, candidates, 'handler-assignment', 'target.onclick')
    candidateFor(content, candidates, 'conditional-render', 'a &&')
    candidateFor(content, candidates, 'conditional-render', 'a && <b /> ||')
    expect(candidates.filter((item) => item.kind === 'branch-dom-write')).toHaveLength(1)
    expect(spans).toHaveLength(new Set(spans).size)
  })

  test('distinguishes literal indexed handlers from dynamic assignments', () => {
    const file = 'plugins/acme.app/src/ui.tsx'
    const content = `
function actions(el: unknown, key: string, handler: unknown) {
  el['onclick'] = handler
  el[key] = handler
}
`
    const candidates = discoverCandidates(plugin([source(file, content)]), [file])

    candidateFor(content, candidates, 'handler-assignment', "el['onclick']")
    candidateFor(content, candidates, 'unresolved-assignment', 'el[key]')
  })

  test('reports all unresolved action forms and leaves a handled form without a native-submit candidate', () => {
    const file = 'plugins/acme.app/src/ui.tsx'
    const content = `
function View(props: any, eventName: string, handler: any) {
  return <><form onSubmit={handler} /><button {...props} /></>
}
createElement('button', { ...props })
createElement('div', { [eventName]: handler })
node.addEventListener(eventName, handler)
`
    const inventory = plugin([source(file, content)])
    const candidates = discoverCandidates(inventory, [file])

    expect(candidates.filter((item) => item.kind === 'unresolved-spread')).toHaveLength(2)
    expect(candidates.filter((item) => item.kind === 'unresolved-computed')).toHaveLength(1)
    expect(candidates.filter((item) => item.kind === 'unresolved-listener')).toHaveLength(1)
    expect(candidates.filter((item) => item.kind === 'jsx-handler' && item.anchorText === 'onSubmit')).toHaveLength(1)
    expect(candidates.some((item) => item.kind === 'native-form')).toBe(false)
  })

  test('ignores candidates in plugin source files outside the UI graph', () => {
    const ui = source('plugins/acme.app/src/ui.tsx', 'export function View() { return <button /> }')
    const daemon = source('plugins/acme.app/src/main.ts', 'setTimeout(() => ({ onTimeout() {} }), 30_000)')
    const inventory = plugin([ui, daemon])
    const graph = discoverUiFiles(inventory)

    expect(discoverCandidates(inventory, graph.files)).toEqual([])
  })
})
