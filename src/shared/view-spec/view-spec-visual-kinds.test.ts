import { describe, expect, it } from 'vitest'
import { validateViewSpec } from './view-spec-validation'
import { loadsImages } from './view-spec-mermaid-guard'

const spec = (root: unknown) => ({ title: 'A view', root })
const kind = (type: string, props: Record<string, unknown>) => spec({ type, props })
const diagram = (source: string) => kind('diagram', { source })
const image = (path: string) => kind('image', { path, alt: 'a picture' })
const html = (body: string) => kind('html', { html: body, interactive: false })
const preview = (url: string) => kind('live-preview', { url })

function errorsOf(raw: unknown): string[] {
  const result = validateViewSpec(raw)
  if (result.ok) {
    throw new Error('expected the spec to be refused')
  }
  return result.errors
}

describe('mermaid guard', () => {
  it('accepts a plain flowchart and refuses sources that make mermaid fetch', () => {
    expect(loadsImages('flowchart LR\n  a[Client] --> b[Daemon]')).toBe(false)
    expect(loadsImages('flowchart LR\n  a@{ img: "https://example.com/x.png" }')).toBe(true)
    expect(loadsImages('flowchart LR\n  a["<img src=x>"]')).toBe(true)
    expect(loadsImages('%%{init: {"themeCSS": "x"}}%%\nflowchart LR\n  a --> b')).toBe(true)
  })
})

describe('diagram', () => {
  it('accepts plain mermaid', () => {
    expect(validateViewSpec(diagram('graph TD\n  A-->B')).ok).toBe(true)
  })

  it.each([
    ['an img: node shape', 'flowchart LR\n  A@{ img: "https://x.test/a.png", label: "a" }'],
    ['image markup in a label', 'graph TD\n  A["<img src=x>"]'],
    ['a css url', 'graph TD\n  A\n  style A fill:url(https://x.test/a)']
  ])('refuses source that loads images: %s', (_name, source) => {
    expect(errorsOf(diagram(source))).toEqual([
      expect.stringMatching(/^root\.props\.source: diagram source must not load images/)
    ])
  })

  it('bounds the source to 20 KiB, counted in UTF-8 bytes', () => {
    expect(errorsOf(diagram('A'.repeat(20 * 1024 + 1)))[0]).toMatch(/^root\.props\.source:/)
    expect(errorsOf(diagram('€'.repeat(6827)))).toEqual([
      'root.props.source: must be at most 20480 bytes'
    ])
    expect(validateViewSpec(diagram('€'.repeat(6826))).ok).toBe(true)
  })
})

describe('image', () => {
  it.each([
    ['a.png'],
    ['docs/shots/login.PNG'],
    ['x/y.jpg'],
    ['x.jpeg'],
    ['x.gif'],
    ['x.webp'],
    ['x.svg']
  ])('accepts %s', (path) => {
    expect(validateViewSpec(image(path)).ok).toBe(true)
  })

  it.each([
    ['/etc/passwd.png', 'image path must be relative to the worktree'],
    ['//host/x.png', 'image path must be relative to the worktree'],
    ['https://x.test/a.png', 'image path must be relative to the worktree'],
    ['C:\\x.png', 'image path must be relative to the worktree'],
    ['../x.png', "image path must not contain '..' segments"],
    ['a/../../x.png', "image path must not contain '..' segments"],
    ['a\\..\\x.png', "image path must not contain '..' segments"],
    ['a/b.txt', 'image path must end in png, jpg, jpeg, gif, webp or svg'],
    ['png', 'image path must end in png, jpg, jpeg, gif, webp or svg']
  ])('refuses %s', (path, message) => {
    expect(errorsOf(image(path))).toEqual([`root.props.path: ${message}`])
  })

  it('requires alt', () => {
    expect(errorsOf(kind('image', { path: 'a.png' }))).toEqual(['root.props.alt: is required'])
  })
})

describe('html', () => {
  const REMOTE = 'root.props.html: remote content is not allowed in html; inline it as data:'

  it('accepts inline markup, scripts and data: urls', () => {
    const body =
      '<style>a{background:url(data:image/png;base64,AAAA)}</style><img src="data:image/png;base64,AAAA"><script>document.title = "x"</script><a href="#top">top</a>'
    expect(validateViewSpec(html(body)).ok).toBe(true)
  })

  it.each([
    ['img src', '<img src="https://x.test/a.png">'],
    ['single quoted src', "<img src='http://x.test/a.png'>"],
    ['unquoted src', '<img src=https://x.test/a.png>'],
    ['protocol relative src', '<script src="//cdn.test/x.js"></script>'],
    ['href', '<a href="https://x.test">x</a>'],
    ['form action', '<form action="https://x.test/post"></form>'],
    ['srcset', '<img srcset="data:image/png;base64,AAAA 1x, https://x.test/a.png 2x">'],
    ['poster', '<video poster="https://x.test/a.png"></video>'],
    ['style url', '<div style="background:url(https://x.test/a.png)"></div>'],
    ['uppercase attribute', '<IMG SRC="HTTPS://x.test/a.png">'],
    ['entity encoded scheme', '<img src="&#104;ttps://x.test/a.png">'],
    ['css import', '<style>@import "https://x.test/a.css";</style>'],
    ['hex-escaped scheme', '<style>div{background:url(\\68 ttps://example.com/x.png)}</style>'],
    ['escaped url keyword', '<style>div{background:\\75 rl(https://example.com/x.png)}</style>'],
    ['escaped import', '<style>@\\69 mport "https://x.test/a.css";</style>'],
    ['import after a comment', '<style>@import/**/"https://x.test/a.css";</style>']
  ])('refuses remote content: %s', (_name, body) => {
    expect(errorsOf(html(body))).toEqual([REMOTE])
  })

  it('accepts data: urls spelled with escapes', () => {
    expect(
      validateViewSpec(html('<style>div{background:url(\\64 ata:image/png;base64,AAAA)}</style>'))
        .ok
    ).toBe(true)
  })

  it('requires interactive and bounds height to 120-1200', () => {
    expect(errorsOf(kind('html', { html: '<p>x</p>' }))).toEqual([
      'root.props.interactive: is required'
    ])
    for (const height of [119, 1201]) {
      expect(errorsOf(kind('html', { html: 'x', interactive: true, height }))[0]).toMatch(
        /^root\.props\.height:/
      )
    }
    for (const height of [120, 1200]) {
      expect(validateViewSpec(kind('html', { html: 'x', interactive: true, height })).ok).toBe(true)
    }
  })

  it('bounds html to 128 KiB, counted in UTF-8 bytes', () => {
    expect(errorsOf(html('x'.repeat(128 * 1024 + 1)))).toEqual([
      'root.props.html: must be at most 131072 bytes'
    ])
    expect(errorsOf(html('€'.repeat(43_691)))).toEqual([
      'root.props.html: must be at most 131072 bytes'
    ])
    expect(validateViewSpec(html('€'.repeat(43_690))).ok).toBe(true)
  })

  it('scans a long attribute-free page quickly', () => {
    const started = performance.now()
    expect(validateViewSpec(html('<p src href action poster '.repeat(4000))).ok).toBe(true)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('live-preview', () => {
  it.each([
    ['http://localhost:3000/'],
    ['http://127.0.0.1:5173'],
    ['http://app.quirky.localhost/x?y=1'],
    ['http://localhost']
  ])('accepts %s', (url) => {
    expect(validateViewSpec(preview(url)).ok).toBe(true)
  })

  it.each([
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
  ])('refuses %s', (url) => {
    expect(errorsOf(preview(url))).toEqual([
      'root.props.url: url must be http:// on localhost, 127.0.0.1 or *.quirky.localhost'
    ])
  })
})

describe('timeline, board, file-map, plot and sketch', () => {
  it('bounds item counts', () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ label: `l${i}`, start: `${i}` }))
    expect(validateViewSpec(kind('timeline', { items: items(100) })).ok).toBe(true)
    expect(errorsOf(kind('timeline', { items: items(101) }))[0]).toMatch(/^root\.props\.items:/)
    expect(errorsOf(kind('timeline', { items: [] }))[0]).toMatch(/^root\.props\.items:/)
    const column = (cards: number) => ({
      title: 'c',
      cards: Array.from({ length: cards }, (_, i) => ({ title: `t${i}` }))
    })
    expect(validateViewSpec(kind('board', { columns: [column(50)] })).ok).toBe(true)
    expect(errorsOf(kind('board', { columns: [column(51)] }))[0]).toMatch(
      /^root\.props\.columns\[0\]\.cards:/
    )
    expect(
      errorsOf(kind('board', { columns: Array.from({ length: 9 }, () => column(0)) }))[0]
    ).toMatch(/^root\.props\.columns:/)
  })

  it('checks tones and file-map statuses', () => {
    expect(
      errorsOf(kind('timeline', { items: [{ label: 'a', start: '1', tone: 'loud' }] }))[0]
    ).toMatch(/^root\.props\.items\[0\]\.tone:/)
    expect(errorsOf(kind('file-map', { entries: [{ path: 'a.ts', status: 'moved' }] }))[0]).toMatch(
      /^root\.props\.entries\[0\]\.status:/
    )
    expect(
      validateViewSpec(
        kind('file-map', {
          entries: [
            { path: 'a.ts', status: 'renamed' },
            { path: 'b.ts', status: 'touched' }
          ]
        })
      ).ok
    ).toBe(true)
  })

  it('needs two finite points per plot series and at most 500', () => {
    const series = (points: unknown[]) => kind('plot', { series: [{ label: 's', points }] })
    expect(errorsOf(series([{ x: 1, y: 1 }]))[0]).toMatch(/^root\.props\.series\[0\]\.points:/)
    expect(
      errorsOf(
        series([
          { x: 1, y: 1 },
          { x: 'a', y: 2 }
        ])
      )[0]
    ).toMatch(/^root\.props\.series\[0\]\.points\[1\]\.x:/)
    expect(
      validateViewSpec(series(Array.from({ length: 500 }, (_, i) => ({ x: i, y: i })))).ok
    ).toBe(true)
    expect(errorsOf(series(Array.from({ length: 501 }, (_, i) => ({ x: i, y: i }))))[0]).toMatch(
      /^root\.props\.series\[0\]\.points:/
    )
  })

  it('needs a known sketch shape kind and finite coordinates', () => {
    const sketch = (shapes: unknown[]) => kind('sketch', { width: 100, height: 100, shapes })
    expect(errorsOf(sketch([{ kind: 'star', x: 0, y: 0 }]))[0]).toMatch(
      /^root\.props\.shapes\[0\]\.kind:/
    )
    expect(errorsOf(sketch([{ kind: 'box', x: Infinity, y: 0 }]))[0]).toMatch(
      /^root\.props\.shapes\[0\]\.x:/
    )
    expect(errorsOf(sketch([]))[0]).toMatch(/^root\.props\.shapes:/)
  })
})

describe('matrix', () => {
  const matrix = (rows: unknown[], columns: string[] = ['a', 'b']) =>
    kind('matrix', { columns, rows })

  it('needs one cell per column', () => {
    expect(errorsOf(matrix([{ label: 'r', cells: ['1'] }]))).toEqual([
      'root.props.rows[0].cells: row has 1 cells; the matrix has 2 columns'
    ])
    expect(validateViewSpec(matrix([{ label: 'r', cells: ['1', '2'] }])).ok).toBe(true)
  })

  it('needs highlight entries to be column names', () => {
    expect(errorsOf(matrix([{ label: 'r', cells: ['1', '2'], highlight: ['a', 'z'] }]))).toEqual([
      "root.props.rows[0].highlight[1]: 'z' is not a column name"
    ])
  })

  it('bounds columns and rows', () => {
    expect(
      errorsOf(
        matrix(
          [{ label: 'r', cells: [] }],
          Array.from({ length: 13 }, (_, i) => `c${i}`)
        )
      )[0]
    ).toMatch(/^root\.props\.columns:/)
    expect(
      errorsOf(matrix(Array.from({ length: 51 }, () => ({ label: 'r', cells: ['1', '2'] }))))[0]
    ).toMatch(/^root\.props\.rows:/)
  })
})

describe('annotated-code', () => {
  const code = 'one\ntwo\nthree\n'
  const annotated = (lines: unknown, source = code) =>
    kind('annotated-code', { language: 'ts', code: source, notes: [{ lines, note: 'n' }] })

  it.each([['1'], ['3'], ['1-3'], ['2-2']])('accepts lines %s in a three line file', (lines) => {
    expect(validateViewSpec(annotated(lines)).ok).toBe(true)
  })

  it.each([['4'], ['0'], ['2-4'], ['3-1']])('refuses lines %s as out of range', (lines) => {
    expect(errorsOf(annotated(lines))).toEqual([
      "root.props.notes[0].lines: lines must fall within the code's 3 lines"
    ])
  })

  it.each([['a'], ['1-'], ['-3'], ['1,2']])('refuses lines %j as malformed', (lines) => {
    expect(errorsOf(annotated(lines))).toEqual([
      'root.props.notes[0].lines: lines must be a line number like "4" or a range like "3-7"'
    ])
  })

  it('counts the last line of code without a trailing newline', () => {
    expect(validateViewSpec(annotated('2', 'one\ntwo')).ok).toBe(true)
    expect(errorsOf(annotated('3', 'one\ntwo'))[0]).toContain("code's 2 lines")
  })

  it('bounds code to 64 KiB in bytes and notes to 50', () => {
    expect(
      errorsOf(kind('annotated-code', { language: 'ts', code: '€'.repeat(21_846), notes: [] }))[0]
    ).toMatch(/^root\.props\.code:/)
    expect(
      validateViewSpec(
        kind('annotated-code', { language: 'ts', code: '€'.repeat(21_845), notes: [] })
      ).ok
    ).toBe(true)
    const notes = Array.from({ length: 51 }, () => ({ lines: '1', note: 'n' }))
    expect(errorsOf(kind('annotated-code', { language: 'ts', code: 'x', notes }))[0]).toMatch(
      /^root\.props\.notes:/
    )
  })
})
