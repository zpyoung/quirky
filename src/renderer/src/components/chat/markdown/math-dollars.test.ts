import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { maskLooseDollars } from './math-dollars'
import { remarkLooseDollars } from './remark-loose-dollars'

type Node = {
  type: string
  value?: string
  url?: string
  position?: { start: { offset: number }; end: { offset: number } }
  children?: Node[]
}

/** The mdast tree after the dollar fixer, GFM and single-dollar math, the order the renderer runs them in. */
function parse(text: string): Node {
  const processor = unified()
    .use(remarkParse)
    .use(remarkLooseDollars)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: true })
  const tree: Root = processor.parse(text)
  // SAFETY: mdast Root and the structural Node used for assertions describe the same tree
  return processor.runSync(tree, { value: text }) as unknown as Node
}

function nodes(tree: Node, type: string): Node[] {
  const found: Node[] = []
  const walk = (node: Node): void => {
    if (node.type === type) {
      found.push(node)
    }
    for (const child of node.children ?? []) {
      walk(child)
    }
  }
  walk(tree)
  return found
}

const mathNodes = (tree: Node): Node[] => [...nodes(tree, 'inlineMath'), ...nodes(tree, 'math')]
const proseOf = (tree: Node): string =>
  nodes(tree, 'text')
    .map((node) => node.value)
    .join('')
const values = (list: Node[]): (string | undefined)[] => list.map((node) => node.value)

describe('loose dollars through the remark pipeline', () => {
  it('keeps prices as text', () => {
    const tree = parse('costs $5 and $10')
    expect(mathNodes(tree)).toHaveLength(0)
    expect(proseOf(tree)).toBe('costs $5 and $10')
  })

  it('keeps a lone dollar as text', () => {
    const tree = parse('pay $5')
    expect(mathNodes(tree)).toHaveLength(0)
    expect(proseOf(tree)).toBe('pay $5')
  })

  it('leaves inline code dollars alone', () => {
    const tree = parse('run `echo $HOME` then `$PATH and $HOME`')
    expect(values(nodes(tree, 'inlineCode'))).toEqual(['echo $HOME', '$PATH and $HOME'])
    expect(mathNodes(tree)).toHaveLength(0)
  })

  it('treats a tight pair as inline math', () => {
    const tree = parse('complexity $O(n)$ here')
    expect(values(nodes(tree, 'inlineMath'))).toEqual(['O(n)'])
    expect(proseOf(tree)).toBe('complexity  here')
  })

  it('treats double dollars as display math', () => {
    expect(values(mathNodes(parse('$$T = \\sum c_i$$')))).toEqual(['T = \\sum c_i'])
    const block = parse('before\n\n$$\nT = \\sum c_i\n$$\n\nafter $5')
    expect(values(nodes(block, 'math'))).toEqual(['T = \\sum c_i'])
    expect(proseOf(block)).toBe('beforeafter $5')
  })

  it('treats paren and bracket delimiters as math', () => {
    expect(values(nodes(parse('so \\(x^2\\) holds'), 'inlineMath'))).toEqual(['x^2'])
    expect(values(mathNodes(parse('\\[\nx^2\n\\]')))).toEqual(['x^2'])
    expect(values(nodes(parse('so \\( x \\) holds'), 'inlineMath'))).toEqual(['x'])
  })

  it.each([
    ['a space after the opening dollar', 'a $ x$ b'],
    ['a space before the closing dollar', 'a $x $ b'],
    ['a digit after the closing dollar', '$x$5'],
    ['a pair split by a blank line', 'a $x\n\ny$ b']
  ])('does not make math from a pair with %s', (_label, text) => {
    expect(mathNodes(parse(text))).toHaveLength(0)
  })

  it('keeps real math after a price', () => {
    const tree = parse('costs $5, and $x+1$ holds')
    expect(values(nodes(tree, 'inlineMath'))).toEqual(['x+1'])
    expect(proseOf(tree)).toBe('costs $5, and  holds')
  })

  it('still renders markup inside a rejected pair', () => {
    const tree = parse('it is $5 for **one** and $10 for two')
    expect(mathNodes(tree)).toHaveLength(0)
    expect(nodes(tree, 'strong')).toHaveLength(1)
  })

  it('keeps an escaped dollar', () => {
    expect(proseOf(parse('it is \\$5'))).toBe('it is $5')
  })

  it('lets a pair span emphasis', () => {
    expect(values(nodes(parse('so $a*b*c$ holds'), 'inlineMath'))).toEqual(['a*b*c'])
  })

  it.each([
    [
      'fenced code',
      'before $5\n\n```sh\necho $HOME and $PATH\n```\n\nafter $7',
      'echo $HOME and $PATH'
    ],
    ['tilde fenced code', '~~~\n$a and $b\n~~~', '$a and $b'],
    ['an open fence', '```sh\necho $HOME and $PATH', 'echo $HOME and $PATH'],
    ['indented code', 'text\n\n    echo $HOME and $PATH\n\nmore $5', 'echo $HOME and $PATH'],
    ['indented code in a blockquote', '>     echo $HOME and $PATH', 'echo $HOME and $PATH'],
    [
      'indented code in a list item',
      '- item\n\n      echo $HOME and $PATH',
      'echo $HOME and $PATH'
    ],
    [
      'indented code in a nested blockquote',
      '> >     echo $HOME and $PATH',
      'echo $HOME and $PATH'
    ],
    [
      'fenced code in a blockquote',
      '> ```sh\n> echo $HOME and $PATH\n> ```\n\nafter $7',
      'echo $HOME and $PATH'
    ],
    [
      'fenced code in a list item',
      '- ```sh\n  echo $HOME and $PATH\n  ```\n- costs $5',
      'echo $HOME and $PATH'
    ],
    [
      'fenced code in a quoted list item',
      '> - ~~~sh\n>   echo $HOME and $PATH\n>   ~~~',
      'echo $HOME and $PATH'
    ],
    ['code that holds escaped-delimiter text', '    echo \\(x\\) $HOME', 'echo \\(x\\) $HOME']
  ])('leaves %s untouched', (_label, text, code) => {
    const tree = parse(text)
    expect(values(nodes(tree, 'code')).join('\n')).toContain(code)
    expect(mathNodes(tree)).toHaveLength(0)
    expect(JSON.stringify(tree)).not.toMatch(/[\uE000-\uE003]/)
  })

  it('keeps every text position mapped to the original source', () => {
    const source = 'Costs $5. Find needle.'
    const [text] = nodes(parse(source), 'text')
    expect(text?.value).toBe(source)
    expect(source.slice(text?.position?.start.offset, text?.position?.end.offset)).toBe(source)
  })

  it('keeps offsets for text around math and escaped delimiters', () => {
    const source = 'a $5 then \\(x\\) and $y$ then $7 end'
    const texts = nodes(parse(source), 'text')
    expect(texts.length).toBeGreaterThan(1)
    for (const text of texts) {
      const start = text.position?.start.offset ?? 0
      const end = text.position?.end.offset ?? 0
      expect(text.value?.length).toBe(end - start)
    }
    expect(texts[0]?.value?.startsWith('a $5 then')).toBe(true)
    expect(texts.at(-1)?.value).toBe(' then $7 end')
  })

  it('keeps an image whose path has escaped parentheses', () => {
    const tree = parse('![shot](docs/shot\\(1\\).png)')
    expect(mathNodes(tree)).toEqual([])
    expect(nodes(tree, 'image').map((node) => node.url)).toEqual(['docs/shot(1).png'])
  })

  it.each([
    ['an inline link', '[a](docs/a\\(1\\).md "t")', 'link', 'docs/a(1).md'],
    ['a definition', '![a][s]\n\n[s]: docs/shot\\(1\\).png', 'definition', 'docs/shot(1).png'],
    [
      'a definition with the destination on the next line',
      '![a][s]\n\n[s]:\n  docs/shot\\(1\\).png',
      'definition',
      'docs/shot(1).png'
    ],
    [
      'a definition in a blockquote',
      '![a][s]\n\n> [s]: docs/shot\\(1\\).png',
      'definition',
      'docs/shot(1).png'
    ],
    [
      'an angle link destination with parentheses',
      '[a](<docs/a(b\\(1\\).md>)',
      'link',
      'docs/a(b(1).md'
    ],
    [
      'an angle image destination with a closing parenthesis',
      '![a](<docs/a)\\(x\\).png>)',
      'image',
      'docs/a)(x).png'
    ]
  ])('keeps the destination of %s', (_label, text, type, url) => {
    const tree = parse(text)
    expect(mathNodes(tree)).toEqual([])
    expect(nodes(tree, type).map((node) => node.url)).toEqual([url])
  })

  it('still finds math in prose beside a destination', () => {
    const tree = parse('[a](docs/a\\(1\\).md) and \\(x\\)')
    expect(nodes(tree, 'link').map((node) => node.url)).toEqual(['docs/a(1).md'])
    expect(values(nodes(tree, 'inlineMath'))).toEqual(['x'])
  })
})

describe('maskLooseDollars', () => {
  const mask = '\uE000'

  it('never changes the length', () => {
    for (const source of [
      'costs $5 and $10',
      '$$ open',
      'so \\(x\\) and \\[y\\]',
      'a $x $ b',
      '`$a` $b'
    ]) {
      expect(maskLooseDollars(source, mask)).toHaveLength(source.length)
    }
  })

  it('masks loose dollars and keeps tight pairs', () => {
    expect(maskLooseDollars('costs $5, and $x+1$ holds', mask)).toBe(
      `costs ${mask}5, and $x+1$ holds`
    )
  })

  it('leaves code, inline code and html alone', () => {
    expect(maskLooseDollars('$5 `$6` $7', mask)).toBe(`${mask}5 \`$6\` ${mask}7`)
    expect(maskLooseDollars('$5\n\n```\n$6 and $7\n```', mask)).toBe(
      `${mask}5\n\n\`\`\`\n$6 and $7\n\`\`\``
    )
  })

  it('does not read escaped parentheses in destinations and definitions as math', () => {
    for (const source of [
      '![shot](docs/shot\\(1\\).png)',
      '[a](docs/a\\(1\\).md "t")',
      '![shot][s]\n\n[s]: docs/shot\\(1\\).png'
    ]) {
      expect(maskLooseDollars(source, mask)).toBe(source)
    }
    expect(maskLooseDollars('![a](b.png) then \\(x\\)', mask)).toBe('![a](b.png) then  $x$ ')
  })

  it('is a no-op on a second pass over its own unmasked output', () => {
    const once = maskLooseDollars('costs $5 and $10, $O(n)$', mask).replaceAll(mask, '$')
    expect(maskLooseDollars(once, mask)).toBe(maskLooseDollars('costs $5 and $10, $O(n)$', mask))
  })

  it('masks each paragraph on its own when many paragraphs hold an unmatched dollar', () => {
    const source = `${'$x\n\n'.repeat(2000)}$y$`
    const expected = `${`${mask}x\n\n`.repeat(2000)}$y$`
    expect(maskLooseDollars(source, mask)).toBe(expected)
  })
})
