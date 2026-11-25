import { describe, expect, it } from 'vitest'
import { catalogGuide, COMPONENTS, nearestTypes } from './view-spec-catalog'
import { formatViewErrors, validateViewSpec } from './view-spec-validation'
import {
  MAX_CHART_POINTS,
  MAX_DEPTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_TABLE_ROWS,
  VIEW_NODE_TYPES,
  type ViewNode
} from './view-spec-types'

const spec = (root: unknown, title: unknown = 'A view') => ({ title, root })
const markdown = (text: string) => spec({ type: 'markdown', props: { text } })
const kind = (type: string, props: Record<string, unknown>) => spec({ type, props })

function errorsOf(raw: unknown): string[] {
  const result = validateViewSpec(raw)
  if (result.ok) {
    throw new Error('expected the spec to be refused')
  }
  return result.errors
}

function nest(depth: number): ViewNode {
  let node: ViewNode = { type: 'markdown', props: { text: 'leaf' } }
  for (let level = 1; level < depth; level++) {
    node = { type: 'stack', children: [node] }
  }
  return node
}

describe('valid specs', () => {
  it.each(VIEW_NODE_TYPES.map((type) => [type]))(
    'accepts the catalog example of %s unchanged',
    (type) => {
      const input = spec(COMPONENTS[type].example)
      expect(validateViewSpec(input)).toEqual({ ok: true, spec: input })
    }
  )

  it('accepts one spec that holds every visual kind', () => {
    const root = {
      type: 'stack',
      children: [
        'diagram',
        'image',
        'html',
        'live-preview',
        'timeline',
        'board',
        'matrix',
        'annotated-code',
        'file-map',
        'plot',
        'sketch'
      ].map((type) => COMPONENTS[type as keyof typeof COMPONENTS].example)
    }
    expect(validateViewSpec(spec(root))).toEqual({ ok: true, spec: spec(root) })
  })

  it('drops empty props and children from the canonical spec', () => {
    expect(validateViewSpec(spec({ type: 'stack', props: {}, children: [] }))).toEqual({
      ok: true,
      spec: spec({ type: 'stack' })
    })
  })

  it('has a catalog entry for every node type', () => {
    expect(Object.keys(COMPONENTS).sort()).toEqual([...VIEW_NODE_TYPES].sort())
  })
})

describe('limits', () => {
  it('accepts 500 nodes and refuses one more', () => {
    const children = (count: number) =>
      Array.from({ length: count }, () => ({ type: 'markdown', props: { text: 'x' } }))
    expect(validateViewSpec(spec({ type: 'stack', children: children(MAX_NODES - 1) })).ok).toBe(
      true
    )
    expect(errorsOf(spec({ type: 'stack', children: children(MAX_NODES) }))).toEqual([
      `root.children[${MAX_NODES - 1}]: at most ${MAX_NODES} nodes allowed`
    ])
  })

  it('accepts the maximum depth and refuses one more', () => {
    expect(validateViewSpec(spec(nest(MAX_DEPTH))).ok).toBe(true)
    const errors = errorsOf(spec(nest(MAX_DEPTH + 1)))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(`${MAX_DEPTH} levels`)
  })

  it('refuses a very deep spec without throwing', () => {
    expect(validateViewSpec(spec(nest(5000))).ok).toBe(false)
  })

  it('refuses an encoded size over 256 KiB before reading anything else', () => {
    expect(errorsOf(spec({ type: 'code', props: { text: 'x'.repeat(MAX_SPEC_BYTES) } }))).toEqual([
      expect.stringContaining(`at most ${MAX_SPEC_BYTES} bytes`)
    ])
  })

  it('accepts 500 table rows and refuses one more', () => {
    const table = (rows: number) =>
      kind('table', { columns: ['a'], rows: Array.from({ length: rows }, () => ['x']) })
    expect(validateViewSpec(table(MAX_TABLE_ROWS)).ok).toBe(true)
    expect(errorsOf(table(MAX_TABLE_ROWS + 1))).toEqual([
      `root.props.rows: at most ${MAX_TABLE_ROWS} rows allowed`
    ])
  })

  it('requires one table cell per column', () => {
    expect(errorsOf(kind('table', { columns: ['a', 'b'], rows: [['1', '2'], ['3']] }))).toEqual([
      'root.props.rows[1]: row has 1 cells; the table has 2 columns'
    ])
  })

  it.each([
    [
      'bar-chart',
      'series',
      (n: number) => Array.from({ length: n }, (_, i) => ({ label: `l${i}`, value: i }))
    ],
    ['line-chart', 'points', (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: i }))]
  ] as const)('%s accepts 500 points and refuses one more', (type, key, make) => {
    expect(validateViewSpec(kind(type, { [key]: make(MAX_CHART_POINTS) })).ok).toBe(true)
    expect(errorsOf(kind(type, { [key]: make(MAX_CHART_POINTS + 1) }))).toEqual([
      expect.stringContaining(`root.props.${key}: at most ${MAX_CHART_POINTS}`)
    ])
  })

  it('allows at most four columns', () => {
    const column = { type: 'markdown', props: { text: 'x' } }
    expect(
      validateViewSpec(spec({ type: 'columns', children: [column, column, column, column] })).ok
    ).toBe(true)
    expect(
      errorsOf(spec({ type: 'columns', children: [column, column, column, column, column] }))[0]
    ).toContain('at most 4')
  })
})

describe('envelope, types and props', () => {
  it('names the nearest catalog types for an unknown type', () => {
    expect(errorsOf(spec({ type: 'tabel' }))).toEqual([
      "root.type: unknown type 'tabel'; did you mean table?"
    ])
    expect(nearestTypes('chart')).toEqual(expect.arrayContaining(['bar-chart', 'line-chart']))
  })

  it('lists the catalog when nothing is close', () => {
    expect(errorsOf(spec({ type: 'carousel' }))[0]).toMatch(
      /^root\.type: unknown type 'carousel'; the catalog has stack, columns/
    )
  })

  it('refuses props outside the catalog, so no style, class, event or URL props exist', () => {
    const errors = errorsOf(
      spec({
        type: 'button',
        props: {
          label: 'Go',
          action: 'go',
          onClick: 'alert(1)',
          href: 'https://x.test',
          style: 'x'
        }
      })
    )
    expect(errors.map((error) => error.split(':')[0])).toEqual([
      'root.props.onClick',
      'root.props.href',
      'root.props.style'
    ])
    expect(errors[0]).toContain('allowed: label, action, variant')
  })

  it('checks prop types and enum values', () => {
    expect(
      errorsOf(spec({ type: 'stat', props: { label: 3, value: 'x', tone: 'loud' } })).map(
        (error) => error.split(':')[0]
      )
    ).toEqual(['root.props.label', 'root.props.tone'])
    expect(errorsOf(kind('bar-chart', { series: [{ label: 'a', value: Infinity }] }))[0]).toMatch(
      /^root\.props\.series\[0\]\.value:/
    )
    expect(errorsOf(kind('table', { columns: ['a'], rows: [[1]] }))[0]).toMatch(
      /^root\.props\.rows\[0\]\[0\]:/
    )
  })

  it('reports required props', () => {
    expect(errorsOf(spec({ type: 'callout' }))).toEqual([
      'root.props.tone: is required',
      'root.props.text: is required'
    ])
  })

  it('refuses children on a leaf component', () => {
    expect(
      errorsOf(
        spec({
          type: 'stat',
          props: { label: 'a', value: 'b' },
          children: [{ type: 'markdown', props: { text: 'x' } }]
        })
      )
    ).toEqual(['root.children: stat cannot have children'])
  })

  it('refuses functions and unknown top-level fields', () => {
    expect(errorsOf(kind('markdown', { text: () => 'x' }))[0]).toMatch(/^root\.props\.text:/)
    expect(validateViewSpec({ title: 'x', root: { type: 'stack' }, extra: 1 }).ok).toBe(false)
  })

  it('requires a title of at most 120 characters', () => {
    expect(errorsOf(spec({ type: 'stack' }, ''))[0]).toMatch(/^title:/)
    expect(errorsOf(spec({ type: 'stack' }, 'x'.repeat(121)))[0]).toMatch(/^title:/)
  })

  it('refuses non-object and cyclic input without throwing', () => {
    expect(errorsOf(null)).toEqual(['view spec must be an object'])
    expect(errorsOf([])).toEqual(['view spec must be an object'])
    const cyclic: Record<string, unknown> = { title: 't' }
    cyclic.root = cyclic
    expect(errorsOf(cyclic)).toEqual(['view spec must be plain JSON'])
  })

  it('formats errors as path: message joined with semicolons', () => {
    expect(
      formatViewErrors([
        { path: 'root.type', message: 'bad' },
        { path: '', message: 'worse' }
      ])
    ).toBe('root.type: bad; worse')
  })

  it('reports every problem at once', () => {
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
    expect(errors.map((error) => error.split(':')[0])).toEqual([
      'root.children[0].props.source',
      'root.children[1].props.path',
      'root.children[2].props.url'
    ])
  })
})

describe('markdown', () => {
  it.each([
    ['[a](https://example.com/x)'],
    ['[a](HTTP://example.com)'],
    ['<https://example.com>'],
    ['[a]: https://example.com'],
    ['a `[b](javascript:alert(1))` inline code'],
    ['```\n[b](javascript:alert(1))\n```'],
    ['plain javascript:alert(1) text']
  ])('accepts %j', (text) => {
    expect(validateViewSpec(markdown(text)).ok).toBe(true)
  })

  it.each([
    ['[a](javascript:alert(1))'],
    ['[a](data:text/html;base64,AAAA)'],
    ['[a](file:///etc/passwd)'],
    ['[a](mailto:me@example.com)'],
    ['[a](/relative/path)'],
    ['[a](#anchor)'],
    ['<javascript:alert(1)>'],
    ['[a]: javascript:alert(1)'],
    ['text\n\n[a](ftp://example.com)']
  ])('refuses the non-http(s) link in %j', (text) => {
    const [error] = errorsOf(markdown(text))
    expect(error).toMatch(/^root\.props\.text:/)
    expect(error).toContain('absolute http(s) URL')
  })

  it('refuses images even over http', () => {
    expect(errorsOf(markdown('![x](https://example.com/a.png)'))[0]).toContain(
      'images are not allowed'
    )
  })

  it('scans only markdown text for links', () => {
    expect(
      validateViewSpec(
        spec({ type: 'callout', props: { tone: 'info', text: '[a](javascript:alert(1))' } })
      ).ok
    ).toBe(true)
  })

  it.each([
    ['unclosed brackets', '['.repeat(250_000)],
    ['bang brackets', '!['.repeat(125_000)],
    ['a backtick run', '`'.repeat(250_000)],
    ['reference-like lines', '[a\n'.repeat(41_000)]
  ])('validates an adversarial spec quickly: %s', (_name, text) => {
    const started = performance.now()
    const result = validateViewSpec(markdown(text))
    expect(performance.now() - started).toBeLessThan(2000)
    expect(result.ok).toBe(true)
  })
})

describe('button', () => {
  const button = (action: unknown) => kind('button', { label: 'Go', action })

  it.each([['go'], ['a'], ['0-9'], ['a'.repeat(40)]])('accepts action %s', (action) => {
    expect(validateViewSpec(button(action)).ok).toBe(true)
  })

  it.each([[''], ['Go'], ['-go'], ['go_now'], ['a'.repeat(41)], [3]])(
    'refuses action %j',
    (action) => {
      expect(errorsOf(button(action))[0]).toMatch(/^root\.props\.action:/)
    }
  )
})

describe('node ids', () => {
  it('keeps a valid id and refuses a malformed one', () => {
    const ok = spec({ type: 'stack', id: 'top-1' })
    expect(validateViewSpec(ok)).toEqual({ ok: true, spec: ok })
    for (const id of ['Top', '-x', 'a_b', '', 'a'.repeat(41), 3]) {
      expect(errorsOf(spec({ type: 'stack', id }))[0]).toMatch(/^root\.id:/)
    }
  })

  it('refuses a duplicate node id at the second node', () => {
    const twice = spec({
      type: 'stack',
      children: [
        { type: 'stack', id: 'same' },
        { type: 'stack', children: [{ type: 'stack', id: 'same' }] }
      ]
    })
    expect(errorsOf(twice)).toEqual(["root.children[1].children[0].id: duplicate id 'same'"])
  })

  it('shares one id space across board cards, sketch shapes and timeline items', () => {
    expect(
      errorsOf(
        kind('board', {
          columns: [
            { title: 'A', cards: [{ id: 'x', title: 'one' }] },
            { title: 'B', cards: [{ id: 'x', title: 'two' }] }
          ]
        })
      )
    ).toEqual(["root.props.columns[1].cards[0].id: duplicate id 'x'"])
    expect(
      errorsOf(
        kind('sketch', {
          width: 100,
          height: 100,
          shapes: [
            { id: 'a', kind: 'box', x: 0, y: 0 },
            { id: 'a', kind: 'box', x: 1, y: 1 }
          ]
        })
      )
    ).toEqual(["root.props.shapes[1].id: duplicate id 'a'"])
    expect(
      errorsOf(
        kind('timeline', {
          items: [
            { id: 'a', label: 'A', start: '1' },
            { id: 'a', label: 'B', start: '2' }
          ]
        })
      )
    ).toEqual(["root.props.items[1].id: duplicate id 'a'"])
  })
})

describe('guide', () => {
  it('lists every component with props and an example, and the limits', () => {
    const guide = catalogGuide()
    for (const type of VIEW_NODE_TYPES) {
      expect(guide).toContain(`  ${type}: `)
      expect(guide).toContain(`example: ${JSON.stringify(COMPONENTS[type].example)}`)
    }
    expect(guide).toContain(
      'props: label: string, value: string, delta?: string, tone?: neutral|good|warn|bad'
    )
    expect(guide).toContain(
      'at most 500 nodes, 12 levels deep, 256 KiB encoded, 500 table rows, 500 chart points'
    )
  })
})
