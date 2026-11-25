import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { remarkHtmlAllowlist } from './remark-html-allowlist'
import { remarkMark } from './remark-mark'
import {
  collectPathCandidates,
  isPathCandidate,
  PATH_CANDIDATE,
  remarkPathCandidates,
  splitPathCandidate
} from './remark-path-candidates'

type Node = {
  type: string
  value?: string
  data?: { hName?: string; hProperties?: Record<string, unknown> }
  children?: Node[]
}

function run(text: string, plugin: () => (tree: Root) => void): Node {
  const processor = unified().use(remarkParse)
  const tree = processor.parse(text)
  plugin()(tree)
  // SAFETY: mdast Root and the structural Node used for assertions describe the same tree
  return tree as unknown as Node
}

function find(tree: Node, predicate: (node: Node) => boolean): Node[] {
  const found: Node[] = []
  const walk = (node: Node): void => {
    if (predicate(node)) {
      found.push(node)
    }
    for (const child of node.children ?? []) {
      walk(child)
    }
  }
  walk(tree)
  return found
}

describe('PATH_CANDIDATE', () => {
  const found = (text: string): string[] =>
    Array.from(text.matchAll(PATH_CANDIDATE), (match) => match[0])

  it('matches relative paths with an extension and an optional line and column', () => {
    expect(
      found('see chat/turns.ts:119 and ./src/a.tsx and ../up/b.json:3:9 and a/b/c.d.ts')
    ).toEqual(['chat/turns.ts:119', './src/a.tsx', '../up/b.json:3:9', 'a/b/c.d.ts'])
  })

  it('skips urls, emails, bare file names and paths with no extension', () => {
    expect(found('https://x.io/a/b.html mail me@host.co/x.y plain.ts src/dir/ a/b')).toEqual([])
  })

  it('captures the path, line and column in groups', () => {
    const match = new RegExp(PATH_CANDIDATE.source).exec('x a/b.ts:12:3 y')
    expect([match?.[1], match?.[2], match?.[3]]).toEqual(['a/b.ts', '12', '3'])
  })
})

describe('path candidate helpers', () => {
  it('isPathCandidate accepts only a whole candidate', () => {
    expect(isPathCandidate('src/a.ts:4')).toBe(true)
    expect(isPathCandidate('see src/a.ts')).toBe(false)
    expect(isPathCandidate('a.ts')).toBe(false)
  })

  it('splitPathCandidate separates the path from the line', () => {
    expect(splitPathCandidate('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(splitPathCandidate('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitPathCandidate('src/a.ts:12:3')).toEqual({ path: 'src/a.ts', line: 12 })
  })

  it('collectPathCandidates reads prose and inline code but not fences, links or definitions', () => {
    const text = [
      'see src/a.ts:4 and `src/b.ts` and `not a path`',
      '',
      '[src/in-label.ts](src/in-target.ts) and [ref label src/ref.ts][r]',
      '',
      '[r]: src/definition.ts',
      '',
      '```',
      'src/fenced.ts',
      '```'
    ].join('\n')
    expect(collectPathCandidates(text)).toEqual(['src/a.ts:4', 'src/b.ts'])
  })

  it('collectPathCandidates lists each distinct candidate once, in order', () => {
    expect(collectPathCandidates('b/x.ts then a/y.ts then b/x.ts')).toEqual(['b/x.ts', 'a/y.ts'])
  })
})

describe('remarkPathCandidates', () => {
  it('splits prose paths into marked inline code', () => {
    const tree = run('open src/a.ts:4 now', remarkPathCandidates)
    const chips = find(tree, (node) => node.type === 'inlineCode')
    expect(chips.map((chip) => chip.value)).toEqual(['src/a.ts:4'])
    expect(chips[0]?.data?.hProperties).toEqual({ 'data-path-candidate': 'src/a.ts:4' })
    expect(find(tree, (node) => node.type === 'text').map((node) => node.value)).toEqual([
      'open ',
      ' now'
    ])
  })

  it('leaves links and code alone', () => {
    const tree = run(
      '[src/a.ts](https://x.io) and `src/b.ts`\n\n```\nsrc/c.ts\n```',
      remarkPathCandidates
    )
    const marked = find(
      tree,
      (node) => node.data?.hProperties?.['data-path-candidate'] !== undefined
    )
    expect(marked).toEqual([])
  })
})

describe('remarkMark', () => {
  it('turns ==text== into a mark', () => {
    const tree = run('a ==hit== b', remarkMark)
    const marks = find(tree, (node) => node.data?.hName === 'mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.children?.[0]?.value).toBe('hit')
    expect(find(tree, (node) => node.type === 'text').map((node) => node.value)).toEqual([
      'a ',
      'hit',
      ' b'
    ])
  })

  it.each(['a == b == c', 'a ==\nb== c', 'a ==== b'])('leaves %j as text', (text) => {
    expect(find(run(text, remarkMark), (node) => node.data?.hName === 'mark')).toEqual([])
  })

  it('marks several highlights in one text node', () => {
    const tree = run('==a== and ==b==', remarkMark)
    expect(find(tree, (node) => node.data?.hName === 'mark')).toHaveLength(2)
  })
})

describe('remarkHtmlAllowlist', () => {
  const htmlOf = (text: string): string[] =>
    find(run(text, remarkHtmlAllowlist), (node) => node.type === 'html').map(
      (node) => node.value ?? ''
    )
  const textOf = (text: string): string =>
    find(run(text, remarkHtmlAllowlist), (node) => node.type === 'text')
      .map((node) => node.value)
      .join('')

  it('keeps allowed tags without their attributes', () => {
    expect(
      htmlOf(
        '<details open onclick="steal()" class="x"><summary style="color:red">Why</summary>Because</details>'
      )
    ).toEqual(['<details><summary>Why</summary>Because</details>'])
    expect(htmlOf('x <kbd class="a" onclick="x()">K</kbd>')).toEqual(['<kbd>', '</kbd>'])
  })

  it('normalizes br to a bare tag', () => {
    expect(htmlOf('a<br class="y">b')).toEqual(['<br>'])
  })

  it('turns every other html node into literal text', () => {
    expect(htmlOf('<script>window.__pwned = true</script>')).toEqual([])
    expect(textOf('<script>window.__pwned = true</script>')).toBe(
      '<script>window.__pwned = true</script>'
    )
    expect(textOf('<a href="https://evil.example" onclick="x()">raw link</a>')).toContain(
      '<a href="https://evil.example"'
    )
  })

  it('escapes a disallowed tag that sits next to an allowed one', () => {
    expect(htmlOf('<details><img src="https://x.io/p.gif"></details>')).toEqual([
      '<details>&lt;img src="https://x.io/p.gif"></details>'
    ])
  })
})
