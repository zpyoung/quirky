import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { QuirkyMarkdownProps } from '../src/markdown'
import { maskLooseDollars } from '../src/markdown/math-dollars'

type Node = { type: string; value?: string; position?: { start: { offset: number }; end: { offset: number } }; children?: Node[] }
type Profile = 'untrusted' | 'file'

let act: typeof import('react').act
let createElement: typeof import('react').createElement
let createRoot: typeof import('react-dom/client').createRoot
let QuirkyMarkdown: typeof import('../src/markdown').QuirkyMarkdown
let rehypeSanitize: typeof import('rehype-sanitize').default
const mounted: Root[] = []

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const [react, client, markdown, sanitize] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../src/markdown'),
    import('rehype-sanitize')
  ])
  act = react.act
  createElement = react.createElement
  createRoot = client.createRoot
  QuirkyMarkdown = markdown.QuirkyMarkdown
  rehypeSanitize = sanitize.default
})

afterEach(async () => {
  for (const root of mounted) await act(async () => root.unmount())
  mounted.length = 0
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** Renders `text` and returns the mdast tree a caller plugin sees, which is after the dollar fixer and the renderer's own plugins. */
async function parse(text: string, profile: Profile): Promise<{ tree: Node; container: HTMLElement }> {
  let tree: Node | undefined
  const capture = () => (root: Node) => {
    tree = root
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push(root)
  const props = {
    profile,
    text,
    onOpenLink: () => {},
    remarkPlugins: [capture],
    ...(profile === 'file' ? { rehypePlugins: [rehypeSanitize] } : {})
  } as unknown as QuirkyMarkdownProps
  await act(async () => {
    root.render(createElement(QuirkyMarkdown, props))
  })
  if (!tree) throw new Error('the capture plugin did not run')
  return { tree, container }
}

function nodes(tree: Node, type: string): Node[] {
  const found: Node[] = []
  const walk = (node: Node) => {
    if (node.type === type) found.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return found
}

const mathNodes = (tree: Node) => [...nodes(tree, 'inlineMath'), ...nodes(tree, 'math')]
const proseOf = (tree: Node) => nodes(tree, 'text').map((node) => node.value).join('')

describe.each<Profile>(['untrusted', 'file'])('loose dollars in the %s profile', (profile) => {
  test('prices stay text', async () => {
    const { tree } = await parse('costs $5 and $10', profile)
    expect(mathNodes(tree)).toHaveLength(0)
    expect(proseOf(tree)).toBe('costs $5 and $10')
  })

  test('a lone dollar stays text', async () => {
    const { tree } = await parse('pay $5', profile)
    expect(mathNodes(tree)).toHaveLength(0)
    expect(proseOf(tree)).toBe('pay $5')
  })

  test('inline code keeps its dollars', async () => {
    const { tree } = await parse('run `echo $HOME` then `$PATH and $HOME`', profile)
    expect(nodes(tree, 'inlineCode').map((node) => node.value)).toEqual(['echo $HOME', '$PATH and $HOME'])
    expect(mathNodes(tree)).toHaveLength(0)
  })

  test('a tight pair is inline math', async () => {
    const { tree } = await parse('complexity $O(n)$ here', profile)
    expect(nodes(tree, 'inlineMath').map((node) => node.value)).toEqual(['O(n)'])
    expect(proseOf(tree)).toBe('complexity  here')
  })

  test('double dollars are display math', async () => {
    const { tree } = await parse('$$T = \\sum c_i$$', profile)
    expect(mathNodes(tree).map((node) => node.value)).toEqual(['T = \\sum c_i'])
    const block = await parse('before\n\n$$\nT = \\sum c_i\n$$\n\nafter $5', profile)
    expect(nodes(block.tree, 'math').map((node) => node.value)).toEqual(['T = \\sum c_i'])
    expect(proseOf(block.tree)).toBe('beforeafter $5')
  })

  test('paren and bracket delimiters are math', async () => {
    const paren = await parse('so \\(x^2\\) holds', profile)
    expect(nodes(paren.tree, 'inlineMath').map((node) => node.value)).toEqual(['x^2'])
    const bracket = await parse('\\[\nx^2\n\\]', profile)
    expect(mathNodes(bracket.tree).map((node) => node.value)).toEqual(['x^2'])
    const spaced = await parse('so \\( x \\) holds', profile)
    expect(nodes(spaced.tree, 'inlineMath').map((node) => node.value)).toEqual(['x'])
  })

  test.each([
    ['a space after the opening dollar', 'a $ x$ b'],
    ['a space before the closing dollar', 'a $x $ b'],
    ['a digit after the closing dollar', '$x$5'],
    ['a pair split by a blank line', 'a $x\n\ny$ b']
  ])('a pair with %s is not math', async (_label, text) => {
    const { tree } = await parse(text, profile)
    expect(mathNodes(tree)).toHaveLength(0)
  })

  test('a price before real math keeps the math', async () => {
    const { tree } = await parse('costs $5, and $x+1$ holds', profile)
    expect(nodes(tree, 'inlineMath').map((node) => node.value)).toEqual(['x+1'])
    expect(proseOf(tree)).toBe('costs $5, and  holds')
  })

  test('markup inside a rejected pair still renders', async () => {
    const { tree } = await parse('it is $5 for **one** and $10 for two', profile)
    expect(mathNodes(tree)).toHaveLength(0)
    expect(nodes(tree, 'strong')).toHaveLength(1)
  })

  test('an escaped dollar is kept', async () => {
    const { tree } = await parse('it is \\$5', profile)
    expect(proseOf(tree)).toBe('it is $5')
  })

  test.each([
    ['fenced code', 'before $5\n\n```sh\necho $HOME and $PATH\n```\n\nafter $7', 'echo $HOME and $PATH'],
    ['tilde fenced code', '~~~\n$a and $b\n~~~', '$a and $b'],
    ['an open fence', '```sh\necho $HOME and $PATH', 'echo $HOME and $PATH'],
    ['indented code', 'text\n\n    echo $HOME and $PATH\n\nmore $5', 'echo $HOME and $PATH'],
    ['indented code in a blockquote', '>     echo $HOME and $PATH', 'echo $HOME and $PATH'],
    ['indented code in a list item', '- item\n\n      echo $HOME and $PATH', 'echo $HOME and $PATH'],
    ['indented code in a nested blockquote', '> >     echo $HOME and $PATH', 'echo $HOME and $PATH'],
    ['fenced code in a blockquote', '> ```sh\n> echo $HOME and $PATH\n> ```\n\nafter $7', 'echo $HOME and $PATH'],
    ['fenced code in a list item', '- ```sh\n  echo $HOME and $PATH\n  ```\n- costs $5', 'echo $HOME and $PATH'],
    ['fenced code in a quoted list item', '> - ~~~sh\n>   echo $HOME and $PATH\n>   ~~~', 'echo $HOME and $PATH'],
    ['code that holds escaped-delimiter text', '    echo \\(x\\) $HOME', 'echo \\(x\\) $HOME']
  ])('%s is untouched', async (_label, text, code) => {
    const { tree, container } = await parse(text, profile)
    expect(nodes(tree, 'code').map((node) => node.value).join('\n')).toContain(code)
    expect(mathNodes(tree)).toHaveLength(0)
    expect(container.textContent).not.toMatch(/[\uE000-\uE003]/)
  })

  test('every mdast position still maps to the original source', async () => {
    const source = 'Costs $5. Find needle.'
    const { tree } = await parse(source, profile)
    const [text] = nodes(tree, 'text')
    expect(text.value).toBe(source)
    expect(text.value!.length).toBe(text.position!.end.offset - text.position!.start.offset)
    expect(source.slice(text.position!.start.offset, text.position!.end.offset)).toBe(source)
  })

  test('text around math and escaped delimiters keeps its offsets', async () => {
    const source = 'a $5 then \\(x\\) and $y$ then $7 end'
    const { tree } = await parse(source, profile)
    const texts = nodes(tree, 'text')
    expect(texts.length).toBeGreaterThan(1)
    for (const text of texts) {
      const { start, end } = text.position!
      expect(text.value!.length).toBe(end.offset - start.offset)
    }
    expect(texts[0].value).toStartWith('a $5 then')
    expect(texts.at(-1)!.value).toBe(' then $7 end')
    expect(source.slice(texts.at(-1)!.position!.start.offset)).toBe(' then $7 end')
  })
})

describe('typeset output', () => {
  test('prices, code and real math render as expected', async () => {
    const { container } = await parse('costs $5 and $10, run `echo $HOME`, $O(n)$, \\(x\\)\n\n$$T = \\sum c_i$$', 'untrusted')
    expect(container.textContent).toContain('costs $5 and $10')
    expect(container.querySelector('code[data-streamdown="inline-code"]')?.textContent).toBe('echo $HOME')
    expect(container.querySelectorAll('.katex').length).toBe(3)
  })
})

describe('maskLooseDollars', () => {
  const mask = '\uE000'

  test('never changes the length', () => {
    for (const source of ['costs $5 and $10', '$$ open', 'so \\(x\\) and \\[y\\]', 'a $x $ b', '`$a` $b']) {
      expect(maskLooseDollars(source, [], mask)).toHaveLength(source.length)
    }
  })

  test('masks loose dollars and keeps tight pairs', () => {
    expect(maskLooseDollars('costs $5, and $x+1$ holds', [], mask)).toBe(`costs ${mask}5, and $x+1$ holds`)
  })

  test('leaves given spans and inline code alone', () => {
    expect(maskLooseDollars('$5 `$6` $7', [[6, 7]], mask)).toBe(`${mask}5 \`$6\` ${mask}7`)
    expect(maskLooseDollars('$5 $6', [[0, 2]], mask)).toBe('$5 ' + mask + '6')
  })

  test('escaped parentheses in link and image destinations and in definitions are not math', () => {
    for (const source of ['![shot](docs/shot\\(1\\).png)', '[a](docs/a\\(1\\).md "t")', '![shot][s]\n\n[s]: docs/shot\\(1\\).png']) {
      expect(maskLooseDollars(source, [], mask)).toBe(source)
    }
    expect(maskLooseDollars('![a](b.png) then \\(x\\)', [], mask)).toBe('![a](b.png) then  $x$ ')
  })

  test('is a no-op on a second pass over its own output once unmasked', () => {
    const once = maskLooseDollars('costs $5 and $10, $O(n)$', [], mask).replaceAll(mask, '$')
    expect(maskLooseDollars(once, [], mask)).toBe(maskLooseDollars('costs $5 and $10, $O(n)$', [], mask))
  })
})

describe('escaped parentheses in destinations', () => {
  test('an image whose path has escaped parentheses stays an image with no math', async () => {
    const { tree } = await parse('![shot](docs/shot\\(1\\).png)', 'untrusted')
    expect(mathNodes(tree)).toEqual([])
    expect(nodes(tree, 'image').length).toBe(1)
  })
})
