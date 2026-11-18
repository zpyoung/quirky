import { describe, expect, test } from 'bun:test'
import bundleSize from './fixtures/bundle-size.json'
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
