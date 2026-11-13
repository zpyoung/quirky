import { describe, expect, test } from 'bun:test'
import type { CheckResult, CoverageFile, Inventory, PluginInventory, Ref } from './contracts'
import { auditPlugin } from './audit'

const file = 'plugins/acme.app/src/ui.tsx'
const ref = (quote: string, path = file): Ref => ({ file: path, quote })
const sharedImport = "import { EmptyState, InlineError } from '@quirky/ui'"
const busy = '<EmptyState message="Loading items" />'
const empty = '<EmptyState message="No items yet" />'
const error = '<InlineError message="Could not load" />'
const save = "context.call('acme.app/save', {})"
const fullSource = `${sharedImport}
export function Main({ status }: { status: string }) {
  if (status === 'busy') return ${busy}
  if (status === 'none') return ${empty}
  if (status === 'bad') return ${error}
  return <button onClick={() => ${save}}>Save</button>
}`

function fullCoverage(): CoverageFile {
  return {
    schemaVersion: 1,
    surfaces: { 'view:acme.app/main': { loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } } },
    states: (['loading', 'empty', 'error'] as const).map((state, index) => ({
      surface: 'view:acme.app/main', state,
      site: ref(["if (status === 'busy')", "if (status === 'none')", "if (status === 'bad')"][index]!),
      render: { component: state === 'error' ? 'InlineError' : 'EmptyState', element: ref([busy, empty, error][index]!), import: ref(sharedImport) }
    })),
    notState: [],
    actions: [{ site: ref('onClick'), route: { invoke: ref(save), target: 'acme.app/save' } }]
  }
}

type AuditFixture = { plugin: PluginInventory; inventory: Inventory; results: () => CheckResult[] }
function fixture(content = fullSource, coverage: CoverageFile | string | undefined = fullCoverage(), extras: Record<string, string> = {}): AuditFixture {
  const plugin: PluginInventory = {
    id: 'acme.app', directory: 'plugins/acme.app', hasUi: true, targets: ['view:acme.app/main'],
    sources: [{ file, content }, ...Object.entries(extras).map(([file, content]) => ({ file, content }))],
    contributions: { methods: ['acme.app/save', 'acme.app/load'], commands: ['command:acme.app/refresh'], cliCommands: [{ id: 'save', words: 'save', methods: ['acme.app/save'] }] },
    ...(coverage === undefined ? {} : { coverage: { file: 'plugins/acme.app/ui-scoreboard.json', content: typeof coverage === 'string' ? coverage : JSON.stringify(coverage) } })
  }
  const inventory: Inventory = { repoRoot: '/repo', commit: 'test', sourceDigest: 'test', dirty: false, plugins: [plugin], targets: [], sharedSources: [], exclusions: [], failures: [] }
  return { plugin, inventory, results: () => auditPlugin(inventory, plugin) }
}

function actionFixture(content: string, classification: Record<string, unknown>, site = 'onClick') {
  const coverage: CoverageFile = {
    schemaVersion: 1,
    surfaces: { 'view:acme.app/main': Object.fromEntries(['loading', 'empty', 'error'].map((state) => [state, { applicable: false, reason: 'No asynchronous state', evidence: [ref(content)] }])) as CoverageFile['surfaces'][string] },
    states: [], notState: [], actions: [{ site: ref(site), ...classification } as CoverageFile['actions'][number]]
  }
  return fixture(content, coverage)
}
function cell(data: AuditFixture, id: string) { return data.results().find((result) => result.id === id)! }
function codes(data: AuditFixture, id: string) { return cell(data, id).evidence.map((item) => item.code) }

describe('quote-bound source audit', () => {
  test('passes shared states and the action public route, including contained leaf candidates', () => {
    const data = fixture()
    expect(data.results().map(({ id, status, applicable }) => ({ id, status, applicable }))).toEqual(
      (['loading', 'empty', 'error', 'commands'] as const).map((id) => ({ id, status: 'pass', applicable: true }))
    )
    expect(cell(data, 'commands').evidence).toContainEqual(expect.objectContaining({ code: 'action-routed', basis: 'source-audit', api: 'acme.app/save', cli: 'quirky acme.app save' }))
    expect(cell(data, 'loading').evidence).toContainEqual(expect.objectContaining({ code: 'state-covered', component: 'EmptyState' }))
  })

  test('unrelated edits shift display locations without invalidating quotes or adding daemon candidates', () => {
    const original = cell(fixture(), 'loading').evidence.find((item) => item.code === 'state-covered')!
    const data = fixture(fullSource.replace('  if (status', '  const unused = 1\n  if (status') + '\nfunction helper() { return 1 }', fullCoverage(), { 'plugins/acme.app/src/main.ts': 'setTimeout(() => {}, 30_000); const options = { onTimeout() {} }' })
    expect(data.results().every((result) => result.status === 'pass')).toBe(true)
    expect(cell(data, 'loading').evidence.find((item) => item.code === 'state-covered')!.source!.line).toBe(original.source!.line + 1)
  })

  test('changed state and invocation witnesses fail only the relevant cells', () => {
    const changed = fixture(fullSource.replace('Loading items', 'Loading entries'))
    expect(codes(changed, 'loading')).toContain('evidence-missing')
    expect(['empty', 'error', 'commands'].map((id) => cell(changed, id).status)).toEqual(['pass', 'pass', 'pass'])
    expect(codes(fixture(fullSource.replace(save, "context.call('acme.app/load', {})")), 'commands')).toContain('evidence-missing')
  })

  test('duplicate witnesses report ambiguity and leave the new branch uncovered', () => {
    const data = fixture(fullSource.replace(`  if (status === 'busy') return ${busy}`, `  if (status === 'busy') return ${busy}\n  if (status === 'busy') return ${busy}`))
    expect(codes(data, 'loading').filter((code) => code === 'evidence-ambiguous').length).toBeGreaterThanOrEqual(2)
    expect(codes(data, 'loading')).toContain('coverage-missing')
  })

  test.each(['if (!rows) return null', 'if (rows.length === 0) return <p>Nothing here</p>'])('finds unclassified branch %s without state variable names', (branch) => {
    const data = fixture(fullSource.replace('  if (status', `  ${branch}\n  if (status`))
    for (const id of ['loading', 'empty', 'error']) {
      expect(cell(data, id).status).toBe('fail')
      expect(cell(data, id).evidence).toContainEqual(expect.objectContaining({ code: 'coverage-missing', source: expect.objectContaining({ file, line: 3 }) }))
    }
    expect(cell(data, 'commands').status).toBe('pass')
  })

  test('rejects raw elements and unaccepted component/state pairs', () => {
    const coverage = fullCoverage()
    coverage.states[0]!.render = { component: 'EmptyState', element: ref('<p className="muted">Loading…</p>'), import: ref(sharedImport) }
    expect(codes(fixture(fullSource.replace(busy, '<p className="muted">Loading…</p>'), coverage), 'loading')).toContain('render-element-invalid')
    const invalid = fullCoverage()
    invalid.states[1]!.render.component = 'NoticeLine'
    expect(codes(fixture(fullSource, invalid), 'empty')).toContain('render-not-accepted')
  })

  test.each(['function EmptyState() { return null }', 'const EmptyState = () => null', 'function Other(EmptyState: unknown) { return null }'])('rejects local shared-component shadow %s', (binding) => {
    expect(codes(fixture(`${fullSource}\n${binding}`), 'loading')).toContain('render-binding-shadowed')
  })

  test.each(["import type { EmptyState, InlineError } from '@quirky/ui'", "import { EmptyState, InlineError } from './design'"])('rejects invalid shared import %s', (importLine) => {
    const coverage = fullCoverage()
    coverage.states[0]!.render = { component: 'EmptyState', element: ref(busy), import: ref(importLine) }
    expect(codes(fixture(fullSource.replace(sharedImport, importLine), coverage, { 'plugins/acme.app/src/design.ts': 'export const EmptyState = 1; export const InlineError = 1' }), 'loading')).toContain('render-binding-invalid')
  })

  test('accepts a value import alias but not an import witness from another file', () => {
    const importLine = "import { EmptyState as Empty, InlineError } from '@quirky/ui'"
    const coverage = fullCoverage()
    for (const entry of coverage.states) if (entry.render.component !== 'toast') {
      entry.render.import = ref(importLine)
      entry.render.element = ref(entry.render.element.quote.replace('EmptyState', 'Empty'))
    }
    expect(fixture(fullSource.replace(sharedImport, importLine).replaceAll('<EmptyState', '<Empty'), coverage).results().every((result) => result.status === 'pass')).toBe(true)
    coverage.states[0]!.render = { component: 'EmptyState', element: ref('<Empty message="Loading items" />'), import: ref(importLine, 'plugins/acme.app/src/other.tsx') }
    const data = fixture(`${fullSource.replace(sharedImport, importLine).replaceAll('<EmptyState', '<Empty')}\nimport './other'`, coverage, { 'plugins/acme.app/src/other.tsx': importLine })
    expect(codes(data, 'loading')).toContain('render-binding-invalid')
  })

  test('requires the state render to be in its classified branch', () => {
    const coverage = fullCoverage()
    coverage.states[0]!.render = { component: 'EmptyState', element: ref(empty), import: ref(sharedImport) }
    expect(codes(fixture(fullSource, coverage), 'loading')).toContain('render-not-linked')
  })

  test('links a complete helper by name and rejects a truncated or stale via witness', () => {
    const helperFile = 'plugins/acme.app/src/busy.tsx'
    const helperImport = "import { EmptyState } from '@quirky/ui'"
    const helper = `export function Busy() { return ${busy} }`
    const content = fullSource.replace(sharedImport, `${sharedImport}\nimport { Busy } from './busy'`).replace(`return ${busy}`, 'return <Busy />')
    const coverage = fullCoverage()
    coverage.states[0]!.render = { component: 'EmptyState', element: ref(busy, helperFile), import: ref(helperImport, helperFile), via: [ref(helper, helperFile)] }
    expect(cell(fixture(content, coverage, { [helperFile]: `${helperImport}\n${helper}` }), 'loading').status).toBe('pass')
    coverage.states[0]!.render.via = [ref('export function Busy() {', helperFile)]
    expect(codes(fixture(content, coverage, { [helperFile]: `${helperImport}\n${helper}` }), 'loading')).toContain('via-invalid')
    coverage.states[0]!.render.via = [ref(helper, helperFile)]
    const stale = fixture(content, coverage, { [helperFile]: `${helperImport}\n${helper.replace('Loading items', 'Loading entries')}` })
    expect(codes(stale, 'loading')).toContain('evidence-missing')
    expect(['empty', 'error', 'commands'].map((id) => cell(stale, id).status)).toEqual(['pass', 'pass', 'pass'])
  })

  test('accepts error toast evidence and rejects a toast with no arguments', () => {
    const toast = "context.toast('Load failed', 'Try again')"
    const coverage = fullCoverage()
    coverage.states[2]!.site = ref(toast)
    coverage.states[2]!.anchor = 'context.toast('
    coverage.states[2]!.render = { component: 'toast', call: ref(toast) }
    const content = fullSource.replace(`if (status === 'bad') return ${error}`, `try { await context.call('acme.app/load', {}) } catch { ${toast} }`)
    expect(cell(fixture(content, coverage), 'error').status).toBe('pass')
    coverage.states[2]!.site = ref('context.toast()')
    coverage.states[2]!.render = { component: 'toast', call: ref('context.toast()') }
    expect(codes(fixture(content.replace(toast, 'context.toast()'), coverage), 'error')).toContain('render-element-invalid')
  })

  test('accepts NoticeLine for loading and FormRow only with an error attribute', () => {
    const importLine = "import { EmptyState, NoticeLine, FormRow } from '@quirky/ui'"
    const notice = '<NoticeLine message="Loading items" />'
    const form = '<FormRow error="Could not load" />'
    const coverage = fullCoverage()
    coverage.states[0]!.render = { component: 'NoticeLine', element: ref(notice), import: ref(importLine) }
    coverage.states[1]!.render = { component: 'EmptyState', element: ref(empty), import: ref(importLine) }
    coverage.states[2]!.render = { component: 'FormRow', element: ref(form), import: ref(importLine) }
    const content = fullSource.replace(sharedImport, importLine).replace(busy, notice).replace(error, form)
    expect(fixture(content, coverage).results().every((result) => result.status === 'pass')).toBe(true)
    coverage.states[2]!.render = { component: 'FormRow', element: ref('<FormRow />'), import: ref(importLine) }
    expect(codes(fixture(content.replace(form, '<FormRow />'), coverage), 'error')).toContain('render-element-invalid')
  })

  test('requires decisions for every surface and rejects unknown surfaces and conflicts', () => {
    const data = fixture()
    data.plugin.targets.push('panel:acme.app/side')
    for (const id of ['loading', 'empty', 'error']) expect(codes(data, id)).toContain('surface-decision-missing')
    const coverage = fullCoverage()
    coverage.surfaces['view:acme.app/gone'] = coverage.surfaces['view:acme.app/main']!
    expect(codes(fixture(fullSource, coverage), 'loading')).toContain('surface-unknown')
    coverage.surfaces = { 'view:acme.app/main': { loading: { applicable: true }, empty: { applicable: true }, error: { applicable: false, reason: 'No failures', evidence: [ref(error)] } } }
    expect(codes(fixture(fullSource, coverage), 'error')).toContain('applicability-conflict')
    coverage.states = coverage.states.filter((entry) => entry.state !== 'empty')
    expect(codes(fixture(fullSource, coverage), 'empty')).toContain('state-missing')
  })

  test('uses ui for a plugin without declared surfaces', () => {
    const coverage = fullCoverage()
    coverage.surfaces.ui = coverage.surfaces['view:acme.app/main']!
    delete coverage.surfaces['view:acme.app/main']
    for (const entry of coverage.states) entry.surface = 'ui'
    const data = fixture(fullSource, coverage)
    data.plugin.targets = []
    expect(data.results().every((result) => result.status === 'pass')).toBe(true)
  })

  test('an unrelated action cannot borrow another handler route', () => {
    const content = fullSource.replace('return <button', "return <><button onClick={() => setShowAll(true)}>All</button><button").replace('Save</button>', 'Save</button></>')
    const coverage = fullCoverage()
    coverage.actions[0]!.site = ref(`onClick={() => ${save}}`)
    expect(codes(fixture(content, coverage), 'commands')).toContain('coverage-missing')
    coverage.actions.push({ site: ref('onClick={() => setShowAll(true)}'), route: { invoke: ref(save), target: 'acme.app/save' } })
    expect(codes(fixture(content, coverage), 'commands')).toContain('route-not-linked')
  })

  test('links action helpers only through complete via witnesses', () => {
    const helper = `function saveItem() { return ${save} }`
    const content = `${helper}\n<button onClick={saveItem}>Save</button>`
    const data = actionFixture(content, { route: { invoke: ref(save), target: 'acme.app/save', via: [ref(helper)] } })
    expect(cell(data, 'commands').status).toBe('pass')
    const noVia = actionFixture(content, { route: { invoke: ref(save), target: 'acme.app/save' } })
    expect(codes(noVia, 'commands')).toContain('route-not-linked')
  })

  test('a handler attribute without an expression cannot borrow an unrelated route', () => {
    const data = actionFixture(`<button onClick>Save</button>; ${save}`, { route: { invoke: ref(save), target: 'acme.app/save' } })
    expect(codes(data, 'commands')).toContain('route-not-linked')
  })

  test('an enclosing API call cannot certify a nested decisive callback', () => {
    const invoke = "context.call('acme.app/save', { onConfirm: () => setShowAll(true) })"
    const data = actionFixture(invoke, { route: { invoke: ref(invoke), target: 'acme.app/save' } }, 'onConfirm')
    expect(codes(data, 'commands')).toContain('route-not-linked')
  })

  test.each([
    ["context.executeCommand('command:acme.app/refresh')", 'command:acme.app/refresh', 'ui.command.run', 'quirky ui run command:acme.app/refresh'],
    ["context.openView('view:acme.app/main')", 'view:acme.app/main', 'ui.view.open', 'quirky ui open-view view:acme.app/main'],
    ["context.togglePanel('panel:acme.app/side')", 'panel:acme.app/side', 'ui.panel.open', 'quirky ui open-panel panel:acme.app/side'],
    ['context.closeView()', 'ui.view.close', 'ui.view.close', 'quirky ui close-view'],
    ["context.call('setting.set', {})", 'setting.set', 'setting.set', 'quirky setting set']
  ])('resolves public route %s', (invoke, target, api, cli) => {
    const data = actionFixture(`<button onClick={() => ${invoke}}>Run</button>`, { route: { invoke: ref(invoke), target } })
    data.plugin.targets.push('panel:acme.app/side')
    const coverage = JSON.parse(data.plugin.coverage!.content) as CoverageFile
    coverage.surfaces['panel:acme.app/side'] = coverage.surfaces['view:acme.app/main']!
    data.plugin.coverage!.content = JSON.stringify(coverage)
    expect(cell(data, 'commands')).toMatchObject({ status: 'pass', evidence: [expect.objectContaining({ code: 'action-routed', api, cli })] })
  })

  test('uses generated method CLI words and rejects undeclared, changed, unresolved, and non-CLI targets', () => {
    const generated = actionFixture(`<button onClick={() => ${save}}>Save</button>`, { route: { invoke: ref(save), target: 'acme.app/save' } })
    generated.plugin.contributions!.cliCommands = []
    expect(cell(generated, 'commands').evidence).toContainEqual(expect.objectContaining({ cli: 'quirky acme.app save' }))
    generated.plugin.contributions!.methods = []
    expect(codes(generated, 'commands')).toContain('route-undeclared')
    for (const [invoke, target, code] of [
      ["context.call('acme.app/missing')", 'acme.app/missing', 'route-undeclared'],
      [save, 'acme.app/load', 'route-target-changed'],
      ['context.call(methodName)', 'acme.app/save', 'route-target-unresolved'],
      ["context.call('ui.window.view.open')", 'ui.window.view.open', 'route-no-cli'],
      ['context.setPalette(true)', 'palette', 'route-no-cli']
    ]) expect(codes(actionFixture(`<button onClick={() => ${invoke}}>Run</button>`, { route: { invoke: ref(invoke!), target } }), 'commands')).toContain(code!)
  })

  test('rejects generated plugin methods shadowed by kernel CLI commands', () => {
    const invoke = "context.call('quirky.setting/set')"
    const data = actionFixture(`<button onClick={() => ${invoke}}>Run</button>`, { route: { invoke: ref(invoke), target: 'quirky.setting/set' } })
    data.inventory.plugins.push({ id: 'quirky.setting', directory: 'plugins/quirky.setting', hasUi: false, targets: [], sources: [], contributions: { methods: ['quirky.setting/set'], commands: [], cliCommands: [] } })
    expect(codes(data, 'commands')).toContain('route-cli-shadowed')
  })

  test('rejects a generated CLI route shadowed by a different declared method command', () => {
    const data = actionFixture(`<button onClick={() => ${save}}>Save</button>`, { route: { invoke: ref(save), target: 'acme.app/save' } })
    data.plugin.contributions!.cliCommands = [{ id: 'load-as-save', words: 'save', methods: ['acme.app/load'] }]
    expect(codes(data, 'commands')).toContain('route-cli-shadowed')
  })

  test.each(['command', "'command'", '["command"]'])('routes %s entries through declared commands', (name) => {
    const property = `${name}: 'command:acme.app/refresh'`
    expect(cell(actionFixture(`const menu = { ${property} }`, { route: { invoke: ref(property), target: 'command:acme.app/refresh' } }, property), 'commands').status).toBe('pass')
  })

  test.each([
    ['<div onMouseEnter={() => showTip()} />', 'onMouseEnter', { transient: 'hover', reason: 'Hover only' }],
    ['<input onChange={() => setDraft(value)} />', 'onChange', { transient: 'draft', reason: 'Unsaved draft' }],
    ['<div onScroll={() => rememberOffset()} />', 'onScroll', { transient: 'caret', reason: 'Scroll position' }],
    ['<img onLoad={() => resize()} />', 'onLoad', { notAction: 'lifecycle', reason: 'Image loaded' }],
    ["el.addEventListener('message', receive)", "el.addEventListener('message'", { notAction: 'subscription', reason: 'Incoming message' }],
    ['<button onClick={props.onPick} />', 'onClick', { notAction: 'forwarded', reason: 'Parent routes' }],
    ['<button onClick={() => onPick?.(row)} />', 'onClick', { notAction: 'forwarded', reason: 'Parent routes' }],
    ['<button {...rest} />', '...rest', { notAction: 'forwarded', reason: 'Parent props' }]
  ])('accepts named non-route classification %s', (content, site, classification) => {
    expect(cell(actionFixture(content, classification, site), 'commands').status).toBe('pass')
  })

  test.each(['onClick', 'onDoubleClick', 'onAuxClick', 'onSubmit', 'onDrop', 'onAction', 'onSelect', 'onChoose', 'onConfirm', 'onRetry', 'onSave'])('requires decisive event %s to route or forward', (name) => {
    expect(codes(actionFixture(`const props = { ${name}: () => change() }`, { transient: 'draft', reason: 'Unsaved' }, name), 'commands')).toContain('transient-not-allowed')
  })

  test('computed literal decisive handler names still require a public route', () => {
    const data = actionFixture('const props = { [\"onClick\"]: () => change() }', { transient: 'draft', reason: 'Unsaved' }, '[\"onClick\"]')
    expect(codes(data, 'commands')).toContain('transient-not-allowed')
  })

  test('restricts lifecycle/subscription and validates forwarding shape', () => {
    expect(codes(actionFixture('<div onChange={() => change()} />', { notAction: 'lifecycle', reason: 'Changed' }, 'onChange'), 'commands')).toContain('transient-not-allowed')
    expect(codes(actionFixture('<div onMessage={() => change()} />', { notAction: 'subscription', reason: 'Message' }, 'onMessage'), 'commands')).toContain('transient-not-allowed')
    expect(codes(actionFixture('<button onClick={() => { onPick(row); setOpen(false) }} />', { notAction: 'forwarded', reason: 'Parent' }), 'commands')).toContain('forwarded-invalid')
  })

  test.each([
    ['<button {...props} />', '...props'],
    ["createElement('button', { ...handlers })", '...handlers'],
    ["createElement('div', { [eventName]: fn })", '[eventName]'],
    ['el.addEventListener(eventName, fn)', 'el.addEventListener(eventName']
  ])('keeps unresolved action %s and requires route or forwarding', (content, site) => {
    expect(codes(actionFixture(content, { transient: 'hover', reason: 'Temporary' }, site), 'commands')).toContain('transient-not-allowed')
    const data = actionFixture(content, { notAction: 'forwarded', reason: 'Delegated' }, site)
    data.plugin.coverage!.content = JSON.stringify({ ...JSON.parse(data.plugin.coverage!.content), actions: [] })
    expect(codes(data, 'commands')).toContain('coverage-missing')
  })

  test('a native form submit always fails even when mapped', () => {
    const data = actionFixture('<form><input /></form>', { notAction: 'forwarded', reason: 'Native' }, '<form')
    expect(codes(data, 'commands')).toContain('native-form-submit')
  })

  test('missing or malformed coverage fails cells but still lists discoveries', () => {
    const missing = fixture()
    delete missing.plugin.coverage
    for (const id of ['loading', 'empty', 'error', 'commands']) {
      expect(codes(missing, id)).toContain('coverage-file-missing')
      expect(codes(missing, id)).toContain('coverage-missing')
    }
    const malformed = fixture(fullSource, '{ nope')
    expect(malformed.results().every((result) => result.evidence.some((item) => item.code === 'coverage-file-invalid'))).toBe(true)
  })

  test('rejects stale entries and duplicate explicit or automatic coverage', () => {
    const coverage = fullCoverage()
    coverage.notState.push({ site: ref(busy), reason: 'Decorative', anchor: '<EmptyState' })
    expect(codes(fixture(fullSource, coverage), 'loading')).toContain('coverage-duplicate')
    coverage.notState = [{ site: ref('export function Main'), reason: 'Not state' }]
    expect(codes(fixture(fullSource, coverage), 'loading')).toContain('site-not-candidate')
  })
})
