import { describe, expect, test } from 'bun:test'
import bundleSize from './fixtures/bundle-size.json'
import authFlowV1 from './fixtures/auth-flow-v1.json'
import authFlowV2 from './fixtures/auth-flow-v2.json'
import visualKinds from './fixtures/visual-kinds.json'
import {
  CATALOG_TYPES,
  COMPONENTS,
  MAX_CHART_POINTS,
  MAX_DEPTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_TABLE_ROWS,
  catalogGuide,
  formatViewErrors,
  nearestTypes,
  validateViewSpec,
  type ViewNode,
  type ViewSpec
} from '../src/core/catalog'

const spec = (root: unknown, title: unknown = 'A view') => ({ title, root }) as ViewSpec
const markdown = (text: string) => spec({ type: 'markdown', props: { text } })

function errorsOf(raw: unknown): { path: string; message: string }[] {
  const result = validateViewSpec(raw)
  if (result.ok) throw new Error('expected the spec to be refused')
  return result.errors
}

function nest(depth: number): ViewNode {
  let node: ViewNode = { type: 'markdown', props: { text: 'leaf' } }
  for (let level = 1; level < depth; level++) node = { type: 'stack', children: [node] }
  return node
}

describe('valid examples', () => {
  test.each(CATALOG_TYPES.map((type) => [type]))('%s: its catalog example is a valid view', (type) => {
    const result = validateViewSpec(spec(COMPONENTS[type].example))
    expect(result).toEqual({ ok: true, spec: spec(COMPONENTS[type].example) })
  })

  test('the bundle-size fixture is valid and comes back unchanged', () => {
    expect(validateViewSpec(bundleSize)).toEqual({ ok: true, spec: bundleSize as never })
  })

  test('the canonical spec drops empty props and children', () => {
    const result = validateViewSpec(spec({ type: 'stack', props: {}, children: [] }))
    expect(result).toEqual({ ok: true, spec: spec({ type: 'stack' }) })
  })

  test('every catalog type has an example and a summary', () => {
    expect(Object.keys(COMPONENTS).sort()).toEqual([...CATALOG_TYPES].sort())
  })
})

describe('limits', () => {
  test(`${MAX_NODES} nodes pass and one more is refused`, () => {
    const children = (count: number) => Array.from({ length: count }, () => ({ type: 'markdown', props: { text: 'x' } }))
    expect(validateViewSpec(spec({ type: 'stack', children: children(MAX_NODES - 1) })).ok).toBe(true)
    const errors = errorsOf(spec({ type: 'stack', children: children(MAX_NODES) }))
    expect(errors.map((error) => error.message)).toEqual([`at most ${MAX_NODES} nodes allowed`])
  })

  test(`depth ${MAX_DEPTH} passes and one more is refused`, () => {
    expect(validateViewSpec(spec(nest(MAX_DEPTH))).ok).toBe(true)
    const errors = errorsOf(spec(nest(MAX_DEPTH + 1)))
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain(`${MAX_DEPTH} levels`)
  })

  test('a very deep spec is refused without throwing', () => {
    expect(validateViewSpec(spec(nest(5000))).ok).toBe(false)
  })

  test('an encoded size over 256 KiB is refused before anything else is read', () => {
    const errors = errorsOf(spec({ type: 'code', props: { text: 'x'.repeat(MAX_SPEC_BYTES) } }))
    expect(errors).toEqual([{ path: '', message: expect.stringContaining(`at most ${MAX_SPEC_BYTES} bytes`) }])
  })

  test(`${MAX_TABLE_ROWS} table rows pass and one more is refused`, () => {
    const table = (rows: number) => spec({ type: 'table', props: { columns: ['a'], rows: Array.from({ length: rows }, () => ['x']) } })
    expect(validateViewSpec(table(MAX_TABLE_ROWS)).ok).toBe(true)
    expect(errorsOf(table(MAX_TABLE_ROWS + 1))).toEqual([{ path: 'root.props.rows', message: `at most ${MAX_TABLE_ROWS} rows allowed` }])
  })

  test('a table row must have one cell per column', () => {
    const errors = errorsOf(spec({ type: 'table', props: { columns: ['a', 'b'], rows: [['1', '2'], ['3']] } }))
    expect(errors).toEqual([{ path: 'root.props.rows[1]', message: 'row has 1 cells; the table has 2 columns' }])
  })

  test.each([
    ['bar-chart', 'series', (n: number) => Array.from({ length: n }, (_, i) => ({ label: `l${i}`, value: i }))],
    ['line-chart', 'points', (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: i }))]
  ] as const)(`%s: ${MAX_CHART_POINTS} points pass and one more is refused`, (type, key, make) => {
    expect(validateViewSpec(spec({ type, props: { [key]: make(MAX_CHART_POINTS) } })).ok).toBe(true)
    expect(errorsOf(spec({ type, props: { [key]: make(MAX_CHART_POINTS + 1) } }))).toEqual([
      { path: `root.props.${key}`, message: expect.stringContaining(`at most ${MAX_CHART_POINTS}`) }
    ])
  })

  test('columns allows at most four children', () => {
    const column = { type: 'markdown', props: { text: 'x' } }
    expect(validateViewSpec(spec({ type: 'columns', children: [column, column, column, column] })).ok).toBe(true)
    expect(errorsOf(spec({ type: 'columns', children: [column, column, column, column, column] }))[0].message).toContain('at most 4')
  })
})

describe('types and props', () => {
  test('an unknown type is named with the nearest catalog types', () => {
    const errors = errorsOf(spec({ type: 'tabel', props: {} }))
    expect(errors).toEqual([{ path: 'root.type', message: "unknown type 'tabel'; did you mean table?" }])
  })

  test('a type far from every catalog type lists the catalog', () => {
    const [error] = errorsOf(spec({ type: 'carousel' }))
    expect(error.message).toStartWith("unknown type 'carousel'; the catalog has stack, columns")
  })

  test('nearestTypes finds substring matches', () => {
    expect(nearestTypes('chart')).toEqual(expect.arrayContaining(['bar-chart', 'line-chart']))
  })

  test('props that are not in the catalog are refused, so no style, class, event or URL props exist', () => {
    const errors = errorsOf(spec({ type: 'button', props: { label: 'Go', action: 'go', onClick: 'alert(1)', href: 'https://x.test', style: 'x' } }))
    expect(errors.map((error) => error.path)).toEqual(['root.props.onClick', 'root.props.href', 'root.props.style'])
    expect(errors[0].message).toContain('allowed: label, action, variant')
  })

  test('props must be strings, finite numbers or enum values as the component says', () => {
    expect(errorsOf(spec({ type: 'stat', props: { label: 3, value: 'x', tone: 'loud' } })).map((error) => error.path)).toEqual([
      'root.props.label',
      'root.props.tone'
    ])
    expect(errorsOf(spec({ type: 'bar-chart', props: { series: [{ label: 'a', value: Infinity }] } }))[0].path).toBe('root.props.series[0].value')
    expect(errorsOf(spec({ type: 'table', props: { columns: ['a'], rows: [[1]] } }))[0].path).toBe('root.props.rows[0][0]')
  })

  test('required props are reported', () => {
    expect(errorsOf(spec({ type: 'callout' })).map((error) => error.path)).toEqual(['root.props.tone', 'root.props.text'])
  })

  test('a leaf component cannot have children', () => {
    expect(errorsOf(spec({ type: 'stat', props: { label: 'a', value: 'b' }, children: [{ type: 'markdown', props: { text: 'x' } }] }))).toEqual([
      { path: 'root.children', message: 'stat cannot have children' }
    ])
  })

  test('functions, symbols and HTML-shaped values never validate', () => {
    expect(errorsOf(spec({ type: 'markdown', props: { text: () => 'x' } }))[0].path).toBe('root.props.text')
    expect(validateViewSpec({ title: 'x', root: { type: 'markdown', props: { text: 'x' } }, extra: 1 }).ok).toBe(false)
  })

  test('the title is required and capped', () => {
    expect(errorsOf(spec({ type: 'stack' }, ''))[0].path).toBe('title')
    expect(errorsOf(spec({ type: 'stack' }, 'x'.repeat(121)))[0].path).toBe('title')
  })

  describe('the label', () => {
    const root = { type: 'stack' as const }
    const labelled = (label: unknown) => ({ title: 'A view', label, root }) as unknown as ViewSpec

    test('is optional and kept in the checked spec', () => {
      expect(validateViewSpec({ title: 'A view', root })).toEqual({ ok: true, spec: { title: 'A view', root } })
      expect(validateViewSpec(labelled('SDD run'))).toEqual({ ok: true, spec: { title: 'A view', label: 'SDD run', root } })
    })

    test('may be exactly 24 characters, and no more', () => {
      expect(validateViewSpec(labelled('x'.repeat(24))).ok).toBe(true)
      expect(errorsOf(labelled('x'.repeat(25)))).toEqual([{ path: 'label', message: 'label must be at most 24 characters' }])
    })

    test('must be a non-empty string', () => {
      for (const bad of ['', '   ', 3, null, ['a']]) {
        expect(errorsOf(labelled(bad))).toEqual([{ path: 'label', message: 'label must be a non-empty string' }])
      }
    })

    test('does not open the envelope to other keys', () => {
      expect(errorsOf({ title: 'A view', label: 'ok', root, extra: 1 })[0].message).toContain('allowed: title, label, root')
    })

    test('is documented in the guide', () => {
      expect(catalogGuide()).toContain('"label"')
    })
  })

  test('non-object input and cyclic input are refused, never thrown', () => {
    expect(errorsOf(null)).toEqual([{ path: '', message: 'view spec must be an object' }])
    expect(errorsOf([])).toEqual([{ path: '', message: 'view spec must be an object' }])
    const cyclic: Record<string, unknown> = { title: 't' }
    cyclic.root = cyclic
    expect(errorsOf(cyclic)).toEqual([{ path: '', message: 'view spec must be plain JSON' }])
  })

  test('formatViewErrors joins path and message with semicolons', () => {
    expect(formatViewErrors([{ path: 'root.type', message: 'bad' }, { path: '', message: 'worse' }])).toBe('root.type: bad; worse')
  })
})

describe('markdown links', () => {
  test.each([
    ['[a](https://example.com/x)'],
    ['[a](HTTP://example.com)'],
    ['<https://example.com>'],
    ['[a]: https://example.com'],
    ['a `[b](javascript:alert(1))` inline code'],
    ['```\n[b](javascript:alert(1))\n```'],
    ['plain javascript:alert(1) text']
  ])('%s is accepted', (text) => {
    expect(validateViewSpec(markdown(text)).ok).toBe(true)
  })

  test.each([
    ['[a](javascript:alert(1))'],
    ['[a](JavaScript:alert(1))'],
    ['[a](data:text/html;base64,AAAA)'],
    ['[a](file:///etc/passwd)'],
    ['[a](mailto:me@example.com)'],
    ['[a](/relative/path)'],
    ['[a](#anchor)'],
    ['[a]( <vbscript:x> )'],
    ['<javascript:alert(1)>'],
    ['[a]: javascript:alert(1)'],
    ['text\n\n[a](ftp://example.com)']
  ])('%s is refused', (text) => {
    const [error] = errorsOf(markdown(text))
    expect(error.path).toBe('root.props.text')
    expect(error.message).toContain('absolute http(s) URL')
  })

  test('images are refused even when the source is http', () => {
    expect(errorsOf(markdown('![x](https://example.com/a.png)'))[0].message).toContain('images are not allowed')
  })

  test('only markdown text is scanned for links; other text props are plain', () => {
    expect(validateViewSpec(spec({ type: 'callout', props: { tone: 'info', text: '[a](javascript:alert(1))' } })).ok).toBe(true)
  })
})

describe('field', () => {
  const field = (question: Record<string, unknown>) => spec({ type: 'field', props: { question } })
  const select = { id: 'pick', type: 'select', question: 'Which?', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }

  test.each([
    ['select', select],
    ['select with a default', { ...select, default: 'b' }],
    ['multiselect', { ...select, type: 'multiselect', default: ['a', 'b'] }],
    ['text', { id: 'why', type: 'text', question: 'Why?', multiline: true, format: 'email', default: 'a@b.co' }],
    ['number', { id: 'count', type: 'number', question: 'How many?', integer: true, min: 1, max: 10, default: 3 }],
    ['confirm', { id: 'go', type: 'confirm', question: 'Go?', default: true, header: 'Ship', required: true }]
  ])('%s is valid', (_name, question) => {
    expect(validateViewSpec(field(question))).toEqual({ ok: true, spec: field(question) as never })
  })

  test('date and unknown question types are refused', () => {
    expect(errorsOf(field({ id: 'when', type: 'date', question: 'When?' }))[0]).toEqual({
      path: 'root.props.question.type',
      message: 'type must be one of select | multiselect | text | number | confirm'
    })
  })

  test('the id must follow the action pattern and be unique across fields', () => {
    expect(errorsOf(field({ ...select, id: 'Not Valid' }))[0].path).toBe('root.props.question.id')
    const twice = spec({ type: 'stack', children: [{ type: 'field', props: { question: select } }, { type: 'field', props: { question: select } }] })
    expect(errorsOf(twice).map((error) => error.message)).toEqual(["duplicate field id 'pick'"])
  })

  test('select needs options, within the cap, with a default that is one of them', () => {
    expect(errorsOf(field({ ...select, options: [] }))[0].message).toBe('options must be a non-empty array')
    const many = Array.from({ length: 13 }, (_, i) => ({ value: `v${i}`, label: `V${i}` }))
    expect(errorsOf(field({ ...select, options: many }))[0].message).toBe('at most 12 options allowed')
    expect(errorsOf(field({ ...select, default: 'zzz' }))[0].message).toBe('default must match one option value')
    expect(errorsOf(field({ ...select, type: 'multiselect', default: ['a', 'zzz'] }))[0].message).toBe('default must be an array of option values')
    expect(errorsOf(field({ ...select, options: [{ value: 'a' }] }))[0].path).toBe('root.props.question.options[0].label')
  })

  test('number rules: min above max, default out of range, integer', () => {
    const number = { id: 'n', type: 'number', question: 'N?' }
    expect(errorsOf(field({ ...number, min: 5, max: 1 }))[0].message).toBe('min must not exceed max')
    expect(errorsOf(field({ ...number, min: 1, default: 0 }))[0].message).toBe('default is below min')
    expect(errorsOf(field({ ...number, max: 1, default: 2 }))[0].message).toBe('default is above max')
    expect(errorsOf(field({ ...number, integer: true, default: 1.5 }))[0].message).toBe('default must be an integer')
  })

  test('text format defaults are checked and a stray option set is refused', () => {
    const text = { id: 't', type: 'text', question: 'T?' }
    expect(errorsOf(field({ ...text, format: 'url', default: 'nope' }))[0].message).toBe('default is not a valid url')
    expect(errorsOf(field({ ...text, options: [] }))[0].message).toBe('options does not apply to text')
  })

  test('masked or credential-shaped questions are refused', () => {
    expect(errorsOf(field({ id: 'pw', type: 'text', question: 'Password?', masked: true })).map((error) => error.message)).toEqual(
      expect.arrayContaining(['masked/sensitive input is not permitted; collect credentials out of band', 'credential-shaped question text is not permitted'])
    )
    expect(errorsOf(field({ id: 'api-key', type: 'text', question: 'Value?' }))[0].message).toBe('credential-shaped id is not permitted')
    expect(errorsOf(field({ ...select, options: [{ value: 'token', label: 'T' }] }))[0].message).toBe('credential-shaped option value is not permitted')
  })

  test('a text field takes an ask pattern and keeps it', () => {
    const question = { id: 'ticket', type: 'text', question: 'Ticket ID?', pattern: '^[A-Z]+-[0-9]+$', default: 'ABC-12' }
    expect(validateViewSpec(field(question))).toEqual({ ok: true, spec: field(question) as never })
  })

  test.each([
    ['not a string', 5, 'pattern must be a string'],
    ['too long', 'a'.repeat(201), 'pattern must be at most 200 characters'],
    ['invalid', '(', 'pattern must be a valid regular expression'],
    ['nested repetition', '(a+)+', 'pattern must not nest repetition (e.g. (a+)+); it can hang the regex engine'],
    ['repeated alternation', '(a|ab)+', 'pattern must not repeat a group with alternatives (e.g. (a|ab)+); it can hang the regex engine'],
    ['too many quantifiers', 'a+b+c+d+', 'pattern must have at most 3 variable quantifiers; it can hang the regex engine']
  ])('an unsafe or malformed pattern is refused: %s', (_name, pattern, message) => {
    expect(errorsOf(field({ id: 't', type: 'text', question: 'T?', pattern }))).toEqual([{ path: 'root.props.question.pattern', message }])
  })

  test('a default must match the pattern', () => {
    expect(errorsOf(field({ id: 't', type: 'text', question: 'T?', pattern: '^[0-9]+$', default: 'abc' }))).toEqual([
      { path: 'root.props.question.default', message: 'default does not match pattern' }
    ])
  })

  test('pattern applies only to text fields and preview is not part of a view field', () => {
    expect(errorsOf(field({ ...select, pattern: 'a' }))[0]).toEqual({ path: 'root.props.question.pattern', message: 'pattern does not apply to select' })
    expect(errorsOf(field({ id: 't', type: 'text', question: 'T?', preview: 'x' }))[0].message).toContain("unknown field 'preview'")
  })
})

describe('markdown link scan cost', () => {
  const quarter = 250 * 1000
  test.each([
    ['unclosed brackets', '['.repeat(quarter)],
    ['bang brackets', '!['.repeat(quarter / 2)],
    ['backtick run', '`'.repeat(quarter)],
    ['reference-like lines', '[a\n'.repeat(quarter / 6)]
  ])('a ~250 KB adversarial spec validates quickly: %s', (_name, text) => {
    const raw = markdown(text)
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(MAX_SPEC_BYTES)
    const started = performance.now()
    const result = validateViewSpec(raw)
    expect(performance.now() - started).toBeLessThan(500)
    expect(result.ok).toBe(true)
  })

  test('link checks still flag unsafe destinations', () => {
    const messages = errorsOf(markdown('[a](javascript:x) ![i](http://x/y.png)\n\n[r]: ftp://z\n<mailto:a@b.c> `[c](javascript:y)`')).map((error) => error.message)
    expect(messages).toEqual([
      "markdown link 'javascript:x' must be an absolute http(s) URL",
      'markdown images are not allowed; a view never loads remote content',
      "markdown link 'ftp://z' must be an absolute http(s) URL",
      "markdown link 'mailto:a@b.c' must be an absolute http(s) URL"
    ])
  })
})

describe('button', () => {
  const button = (action: unknown) => spec({ type: 'button', props: { label: 'Go', action } })

  test.each([['go'], ['a'], ['0-9'], ['a'.repeat(40)]])('action %s is accepted', (action) => {
    expect(validateViewSpec(button(action)).ok).toBe(true)
  })

  test.each([[''], ['Go'], ['-go'], ['go_now'], ['a'.repeat(41)], [3]])('action %p is refused', (action) => {
    expect(errorsOf(button(action))[0].path).toBe('root.props.action')
  })

  test('action is required', () => {
    expect(errorsOf(spec({ type: 'button', props: { label: 'Go' } }))).toEqual([{ path: 'root.props.action', message: 'is required' }])
  })
})

describe('guide', () => {
  test('lists every component with its props and an example, and the limits', () => {
    const guide = catalogGuide()
    for (const type of CATALOG_TYPES) {
      expect(guide).toContain(`  ${type}: `)
      expect(guide).toContain(`example: ${JSON.stringify(COMPONENTS[type].example)}`)
    }
    expect(guide).toContain('props: label: string, value: string, delta?: string, tone?: neutral|good|warn|bad')
    expect(guide).toContain('at most 500 nodes, 12 levels deep, 256 KiB encoded, 500 table rows, 500 chart points')
  })
})

describe('visual kinds', () => {
  const NEW_KINDS = ['diagram', 'image', 'html', 'live-preview', 'timeline', 'board', 'matrix', 'annotated-code', 'file-map', 'plot', 'sketch'] as const
  const kind = (type: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => spec({ type, props, ...extra })
  const diagram = (source: string) => kind('diagram', { source })
  const image = (path: string) => kind('image', { path, alt: 'a picture' })
  const html = (body: string) => kind('html', { html: body, interactive: false })
  const preview = (url: string) => kind('live-preview', { url })

  test('the catalog lists every new kind', () => {
    for (const type of NEW_KINDS) expect(CATALOG_TYPES).toContain(type)
  })

  test('one spec with every new kind is valid and comes back unchanged', () => {
    expect(validateViewSpec(visualKinds)).toEqual({ ok: true, spec: visualKinds as never })
    const used = new Set<string>()
    const walk = (node: { type: string; children?: unknown[] }) => {
      used.add(node.type)
      for (const child of node.children ?? []) walk(child as never)
    }
    walk(visualKinds.root)
    for (const type of NEW_KINDS) expect(used.has(type)).toBe(true)
  })

  test('the guide documents every new kind with a summary, its props and the id format', () => {
    const guide = catalogGuide()
    for (const type of NEW_KINDS) {
      expect(guide).toContain(`  ${type}: ${COMPONENTS[type].summary}`)
      expect(COMPONENTS[type].summary.length).toBeGreaterThan(10)
    }
    expect(guide).toContain('lowercase letters, digits and dashes, 1 to 40 characters')
    expect(guide).toContain('unique')
  })

  test('the fixtures for the version tests are valid', () => {
    for (const fixture of [authFlowV1, authFlowV2]) expect(validateViewSpec(fixture)).toEqual({ ok: true, spec: fixture as never })
  })

  describe('node ids', () => {
    test('an id is kept on the node and must follow the action pattern', () => {
      const ok = spec({ type: 'stack', id: 'top-1' })
      expect(validateViewSpec(ok)).toEqual({ ok: true, spec: ok })
      for (const id of ['Top', '-x', 'a_b', '', 'a'.repeat(41), 3]) {
        expect(errorsOf(spec({ type: 'stack', id }))[0].path).toBe('root.id')
      }
      expect(errorsOf(spec({ type: 'stack', id: 'Top' }))[0].message).toContain('lowercase letters, digits and dashes, 1 to 40 characters')
    })

    test('a duplicate node id is refused at the second node', () => {
      const twice = spec({ type: 'stack', children: [{ type: 'stack', id: 'same' }, { type: 'stack', children: [{ type: 'stack', id: 'same' }] }] })
      expect(errorsOf(twice)).toEqual([{ path: 'root.children[1].children[0].id', message: "duplicate id 'same'" }])
    })

    test('board card ids, sketch shape ids and timeline item ids share the same rule', () => {
      const board = kind('board', { columns: [{ title: 'A', cards: [{ id: 'x', title: 'one' }] }, { title: 'B', cards: [{ id: 'x', title: 'two' }] }] })
      expect(errorsOf(board)).toEqual([{ path: 'root.props.columns[1].cards[0].id', message: "duplicate id 'x'" }])
      const sketch = kind('sketch', { width: 100, height: 100, shapes: [{ id: 'a', kind: 'box', x: 0, y: 0 }, { id: 'a', kind: 'box', x: 1, y: 1 }] })
      expect(errorsOf(sketch)).toEqual([{ path: 'root.props.shapes[1].id', message: "duplicate id 'a'" }])
      const timeline = kind('timeline', { items: [{ id: 'a', label: 'A', start: '1' }, { id: 'a', label: 'B', start: '2' }] })
      expect(errorsOf(timeline)).toEqual([{ path: 'root.props.items[1].id', message: "duplicate id 'a'" }])
      const across = spec({ type: 'stack', id: 'a', children: [{ type: 'board', props: { columns: [{ title: 'A', cards: [{ id: 'a', title: 't' }] }] } }] })
      expect(errorsOf(across)[0].message).toBe("duplicate id 'a'")
    })

    test('a card id that breaks the pattern is refused', () => {
      const board = kind('board', { columns: [{ title: 'A', cards: [{ id: 'Not Ok', title: 'one' }] }] })
      expect(errorsOf(board)[0].path).toBe('root.props.columns[0].cards[0].id')
    })
  })

  describe('diagram', () => {
    test('plain mermaid is accepted', () => {
      expect(validateViewSpec(diagram('graph TD\n  A-->B')).ok).toBe(true)
    })

    test.each([
      ['an img: node shape', 'flowchart LR\n  A@{ img: "https://x.test/a.png", label: "a" }'],
      ['image markup in a label', 'graph TD\n  A["<img src=x>"]'],
      ['a css url', 'graph TD\n  A\n  style A fill:url(https://x.test/a)']
    ])('source that loads images is refused: %s', (_name, source) => {
      expect(errorsOf(diagram(source))).toEqual([{ path: 'root.props.source', message: expect.stringContaining('must not load images') }])
    })

    test('source is bounded to 20 KiB', () => {
      expect(errorsOf(diagram('A'.repeat(20 * 1024 + 1)))[0].path).toBe('root.props.source')
    })

    test('the bound counts UTF-8 bytes, not characters', () => {
      // 6,827 three-byte characters are 20,481 bytes; 6,826 are 20,478
      expect(errorsOf(diagram('€'.repeat(6827)))).toEqual([{ path: 'root.props.source', message: 'must be at most 20480 bytes' }])
      expect(validateViewSpec(diagram('€'.repeat(6826))).ok).toBe(true)
    })
  })

  describe('image', () => {
    test.each([['a.png'], ['docs/shots/login.PNG'], ['x/y.jpg'], ['x.jpeg'], ['x.gif'], ['x.webp'], ['x.svg']])('%s is accepted', (path) => {
      expect(validateViewSpec(image(path)).ok).toBe(true)
    })

    test.each([
      ['/etc/passwd.png', 'image path must be relative to the worktree'],
      ['//host/x.png', 'image path must be relative to the worktree'],
      ['https://x.test/a.png', 'image path must be relative to the worktree'],
      ['C:\\x.png', 'image path must be relative to the worktree'],
      ['../x.png', "image path must not contain '..' segments"],
      ['a/../../x.png', "image path must not contain '..' segments"],
      ['a\\..\\x.png', "image path must not contain '..' segments"],
      ['a/b.txt', 'image path must end in png, jpg, jpeg, gif, webp or svg'],
      ['png', 'image path must end in png, jpg, jpeg, gif, webp or svg']
    ])('%s is refused', (path, message) => {
      expect(errorsOf(image(path))).toEqual([{ path: 'root.props.path', message }])
    })

    test('alt is required', () => {
      expect(errorsOf(kind('image', { path: 'a.png' }))).toEqual([{ path: 'root.props.alt', message: 'is required' }])
    })
  })

  describe('html', () => {
    const REMOTE = 'remote content is not allowed in html; inline it as data:'

    test('inline markup, scripts and data: urls are accepted', () => {
      const body = '<style>a{background:url(data:image/png;base64,AAAA)}</style><img src="data:image/png;base64,AAAA"><script>document.title = "x"</script><a href="#top">top</a>'
      expect(validateViewSpec(html(body)).ok).toBe(true)
    })

    test.each([
      ['img src', '<img src="https://x.test/a.png">'],
      ['img src single quoted', "<img src='http://x.test/a.png'>"],
      ['img src unquoted', '<img src=https://x.test/a.png>'],
      ['protocol relative src', '<script src="//cdn.test/x.js"></script>'],
      ['href', '<a href="https://x.test">x</a>'],
      ['link href', '<link rel="stylesheet" href="http://x.test/a.css">'],
      ['form action', '<form action="https://x.test/post"></form>'],
      ['srcset', '<img srcset="data:image/png;base64,AAAA 1x, https://x.test/a.png 2x">'],
      ['poster', '<video poster="https://x.test/a.png"></video>'],
      ['style url', '<div style="background:url(https://x.test/a.png)"></div>'],
      ['style block url with quotes', '<style>div{background:url( "//x.test/a.png" )}</style>'],
      ['uppercase attribute', '<IMG SRC="HTTPS://x.test/a.png">'],
      ['entity encoded scheme', '<img src="&#104;ttps://x.test/a.png">'],
      ['css import', '<style>@import "https://x.test/a.css";</style>'],
      ['hex-escaped scheme in url', '<style>div{background:url(\\68 ttps://example.com/x.png)}</style>'],
      ['hex-escaped scheme with a six digit escape', '<style>div{background:url(\\000068ttps://example.com/x.png)}</style>'],
      ['escaped url keyword', '<style>div{background:\\75 rl(https://example.com/x.png)}</style>'],
      ['escaped slashes', '<style>div{background:url(\\2f\\2f example.com/x.png)}</style>'],
      ['backslash-escaped letter', '<style>div{background:url(h\\ttps://example.com/x.png)}</style>'],
      ['uppercase import', '<style>@IMPORT "https://x.test/a.css";</style>'],
      ['escaped import', '<style>@\\69 mport "https://x.test/a.css";</style>'],
      ['escaped import url', '<style>@import url(\\68 ttps://x.test/a.css);</style>'],
      ['import after a comment', '<style>@import/**/"https://x.test/a.css";</style>']
    ])('remote content is refused: %s', (_name, body) => {
      expect(errorsOf(html(body))).toEqual([{ path: 'root.props.html', message: REMOTE }])
    })

    test('data: urls, also spelled with escapes, are still accepted', () => {
      expect(validateViewSpec(html('<style>div{background:url(data:image/png;base64,AAAA)}</style>')).ok).toBe(true)
      expect(validateViewSpec(html('<style>div{background:url(\\64 ata:image/png;base64,AAAA)}</style>')).ok).toBe(true)
      expect(validateViewSpec(html('<style>div{content:"\\201C"}</style>')).ok).toBe(true)
    })

    test('interactive is required and height is bounded', () => {
      expect(errorsOf(kind('html', { html: '<p>x</p>' }))).toEqual([{ path: 'root.props.interactive', message: 'is required' }])
      expect(errorsOf(kind('html', { html: 'x', interactive: 'yes' }))[0].message).toBe('must be a boolean')
      for (const height of [119, 1201]) expect(errorsOf(kind('html', { html: 'x', interactive: true, height }))[0].path).toBe('root.props.height')
      for (const height of [120, 1200]) expect(validateViewSpec(kind('html', { html: 'x', interactive: true, height })).ok).toBe(true)
    })

    test('html is bounded to 128 KiB', () => {
      const big = kind('html', { html: 'x'.repeat(128 * 1024 + 1), interactive: false })
      expect(errorsOf(big)[0]).toEqual({ path: 'root.props.html', message: 'must be at most 131072 bytes' })
    })

    test('the html bound counts UTF-8 bytes, not characters', () => {
      // 43,691 three-byte characters are 131,073 bytes; 43,690 are 131,070
      expect(errorsOf(kind('html', { html: '€'.repeat(43691), interactive: false }))[0]).toEqual({ path: 'root.props.html', message: 'must be at most 131072 bytes' })
      expect(validateViewSpec(kind('html', { html: '€'.repeat(43690), interactive: false })).ok).toBe(true)
    })

    test('scanning a long attribute-free page is fast', () => {
      const started = performance.now()
      expect(validateViewSpec(html('<p src href action poster '.repeat(4000))).ok).toBe(true)
      expect(performance.now() - started).toBeLessThan(500)
    })
  })

  describe('live-preview', () => {
    test.each([['http://localhost:3000/'], ['http://127.0.0.1:5173'], ['http://app.quirky.localhost/x?y=1'], ['http://localhost']])('%s is accepted', (url) => {
      expect(validateViewSpec(preview(url)).ok).toBe(true)
    })

    test.each([
      ['https://localhost:3000'],
      ['http://example.com'],
      ['http://localhost.evil.com'],
      ['http://127.0.0.1.evil.com'],
      ['http://evil.com/localhost'],
      ['http://localhost@evil.com'],
      ['http://user:pw@localhost'],
      ['http://quirky.localhost.evil.com'],
      ['http://[::1]:3000'],
      ['http://0.0.0.0'],
      ['ftp://localhost'],
      ['localhost:3000'],
      ['javascript:alert(1)']
    ])('%s is refused', (url) => {
      expect(errorsOf(preview(url))).toEqual([{ path: 'root.props.url', message: 'url must be http:// on localhost, 127.0.0.1 or *.quirky.localhost' }])
    })
  })

  describe('timeline, board, file-map, plot and sketch', () => {
    test('item counts are bounded', () => {
      const items = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `l${i}`, start: `${i}` }))
      expect(validateViewSpec(kind('timeline', { items: items(100) })).ok).toBe(true)
      expect(errorsOf(kind('timeline', { items: items(101) }))[0].path).toBe('root.props.items')
      expect(errorsOf(kind('timeline', { items: [] }))[0].path).toBe('root.props.items')
      const column = (cards: number) => ({ title: 'c', cards: Array.from({ length: cards }, (_, i) => ({ title: `t${i}` })) })
      expect(validateViewSpec(kind('board', { columns: [column(50)] })).ok).toBe(true)
      expect(errorsOf(kind('board', { columns: [column(51)] }))[0].path).toBe('root.props.columns[0].cards')
      expect(errorsOf(kind('board', { columns: Array.from({ length: 9 }, () => column(0)) }))[0].path).toBe('root.props.columns')
    })

    test('tones and file-map statuses are checked', () => {
      expect(errorsOf(kind('timeline', { items: [{ label: 'a', start: '1', tone: 'loud' }] }))[0].path).toBe('root.props.items[0].tone')
      expect(errorsOf(kind('file-map', { entries: [{ path: 'a.ts', status: 'moved' }] }))[0].path).toBe('root.props.entries[0].status')
      expect(validateViewSpec(kind('file-map', { entries: [{ path: 'a.ts', status: 'renamed' }, { path: 'b.ts', status: 'touched' }] })).ok).toBe(true)
    })

    test('plot needs two points a series and finite numbers', () => {
      const series = (points: unknown[]) => kind('plot', { series: [{ label: 's', points }] })
      expect(errorsOf(series([{ x: 1, y: 1 }]))[0].path).toBe('root.props.series[0].points')
      expect(errorsOf(series([{ x: 1, y: 1 }, { x: 'a', y: 2 }]))[0].path).toBe('root.props.series[0].points[1].x')
      expect(validateViewSpec(series(Array.from({ length: 500 }, (_, i) => ({ x: i, y: i })))).ok).toBe(true)
      expect(errorsOf(series(Array.from({ length: 501 }, (_, i) => ({ x: i, y: i }))))[0].path).toBe('root.props.series[0].points')
    })

    test('sketch shapes need a known kind and finite coordinates', () => {
      const sketch = (shapes: unknown[]) => kind('sketch', { width: 100, height: 100, shapes })
      expect(errorsOf(sketch([{ kind: 'star', x: 0, y: 0 }]))[0].path).toBe('root.props.shapes[0].kind')
      expect(errorsOf(sketch([{ kind: 'box', x: Infinity, y: 0 }]))[0].path).toBe('root.props.shapes[0].x')
      expect(errorsOf(sketch([]))[0].path).toBe('root.props.shapes')
    })
  })

  describe('matrix', () => {
    const matrix = (rows: unknown[], columns: string[] = ['a', 'b']) => kind('matrix', { columns, rows })

    test('a row needs one cell per column', () => {
      expect(errorsOf(matrix([{ label: 'r', cells: ['1'] }]))).toEqual([{ path: 'root.props.rows[0].cells', message: 'row has 1 cells; the matrix has 2 columns' }])
      expect(validateViewSpec(matrix([{ label: 'r', cells: ['1', '2'] }])).ok).toBe(true)
    })

    test('highlight entries must be column names', () => {
      expect(errorsOf(matrix([{ label: 'r', cells: ['1', '2'], highlight: ['a', 'z'] }]))).toEqual([
        { path: 'root.props.rows[0].highlight[1]', message: "'z' is not a column name" }
      ])
      expect(validateViewSpec(matrix([{ label: 'r', cells: ['1', '2'], highlight: ['b'] }])).ok).toBe(true)
    })

    test('columns and rows are bounded', () => {
      expect(errorsOf(matrix([{ label: 'r', cells: [] }], Array.from({ length: 13 }, (_, i) => `c${i}`)))[0].path).toBe('root.props.columns')
      expect(errorsOf(matrix(Array.from({ length: 51 }, () => ({ label: 'r', cells: ['1', '2'] }))))[0].path).toBe('root.props.rows')
    })
  })

  describe('annotated-code', () => {
    const code = 'one\ntwo\nthree\n'
    const annotated = (lines: unknown, source = code) => kind('annotated-code', { language: 'ts', code: source, notes: [{ lines, note: 'n' }] })

    test.each([['1'], ['3'], ['1-3'], ['2-2']])('lines %s fall inside a three line file', (lines) => {
      expect(validateViewSpec(annotated(lines)).ok).toBe(true)
    })

    test.each([['4'], ['0'], ['2-4'], ['3-1']])('lines %s are refused as out of range', (lines) => {
      expect(errorsOf(annotated(lines))).toEqual([{ path: 'root.props.notes[0].lines', message: "lines must fall within the code's 3 lines" }])
    })

    test.each([['a'], ['1-'], ['-3'], ['1,2']])('lines %p are refused as malformed', (lines) => {
      expect(errorsOf(annotated(lines))[0]).toEqual({ path: 'root.props.notes[0].lines', message: 'lines must be a line number like "4" or a range like "3-7"' })
    })

    test('a code block with no trailing newline counts its last line', () => {
      expect(validateViewSpec(annotated('2', 'one\ntwo')).ok).toBe(true)
      expect(errorsOf(annotated('3', 'one\ntwo'))[0].message).toBe("lines must fall within the code's 2 lines")
    })

    test('code is bounded to 64 KiB and notes to 50', () => {
      expect(errorsOf(kind('annotated-code', { language: 'ts', code: 'x'.repeat(64 * 1024 + 1), notes: [] }))[0].path).toBe('root.props.code')
      // 21,846 three-byte characters are 65,538 bytes; 21,845 are 65,535
      expect(errorsOf(kind('annotated-code', { language: 'ts', code: '€'.repeat(21846), notes: [] }))[0].path).toBe('root.props.code')
      expect(validateViewSpec(kind('annotated-code', { language: 'ts', code: '€'.repeat(21845), notes: [] })).ok).toBe(true)
      const notes = Array.from({ length: 51 }, () => ({ lines: '1', note: 'n' }))
      expect(errorsOf(kind('annotated-code', { language: 'ts', code: 'x', notes }))[0].path).toBe('root.props.notes')
    })
  })

  test('a refused spec reports every problem at once, still pure', () => {
    const errors = errorsOf(
      spec({
        type: 'stack',
        children: [
          { type: 'diagram', props: { source: 'graph TD\n A["<img src=x>"]' } },
          { type: 'image', props: { path: '../x.png', alt: 'x' } },
          { type: 'live-preview', props: { url: 'http://example.com' } }
        ]
      })
    )
    expect(errors.map((error) => error.path)).toEqual(['root.children[0].props.source', 'root.children[1].props.path', 'root.children[2].props.url'])
  })
})
