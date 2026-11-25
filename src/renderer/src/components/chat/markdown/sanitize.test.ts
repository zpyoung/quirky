import type { Root } from 'hast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { remarkHtmlAllowlist } from './remark-html-allowlist'
import { rehypeUndoubleClobber, UNTRUSTED_SCHEMA } from './sanitize'

type Node = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/** The renderer's untrusted pipeline up to and including sanitize: markdown, the html allowlist, raw html, then the schema. */
async function hastOf(markdown: string): Promise<Node> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkHtmlAllowlist)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, UNTRUSTED_SCHEMA)
    .use(rehypeUndoubleClobber)
  const tree = await processor.run(processor.parse(markdown))
  const root: Root = tree
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hast Root and the structural Node used for assertions describe the same tree
  return root as unknown as Node
}

function elements(tree: Node, tagName?: string): Node[] {
  const found: Node[] = []
  const walk = (node: Node): void => {
    if (node.type === 'element' && (tagName === undefined || node.tagName === tagName)) {
      found.push(node)
    }
    for (const child of node.children ?? []) {
      walk(child)
    }
  }
  walk(tree)
  return found
}

function textOf(node: Node): string {
  if (node.type === 'text') {
    return node.value ?? ''
  }
  return (node.children ?? []).map(textOf).join('')
}

const attributes = (node: Node | undefined): string[] => Object.keys(node?.properties ?? {})

describe('untrusted sanitize schema', () => {
  it('shows a raw img as text and fetches nothing', async () => {
    const tree = await hastOf('Look: <img src="https://x.io/p.gif">')
    expect(elements(tree, 'img')).toHaveLength(0)
    expect(textOf(tree)).toContain('<img src="https://x.io/p.gif">')
  })

  it('keeps details and summary without their authored attributes', async () => {
    const tree = await hastOf(
      '<details open onclick="steal()" class="x"><summary style="color:red">Why</summary>Because <b>bold</b></details>'
    )
    const [details] = elements(tree, 'details')
    const [summary] = elements(tree, 'summary')
    expect(attributes(details)).toEqual([])
    expect(attributes(summary)).toEqual([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: elements() found the tag asserted just above
    expect(textOf(summary as Node)).toBe('Why')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: elements() found the tag asserted just above
    expect(textOf(details as Node)).toContain('Because <b>bold</b>')
  })

  it('drops script and renders a raw anchor as text', async () => {
    const tree = await hastOf(
      '<script>window.__pwned = true</script>\n\n<a href="https://evil.example" onclick="x()">raw link</a>'
    )
    expect(elements(tree, 'script')).toHaveLength(0)
    expect(elements(tree, 'a')).toHaveLength(0)
    expect(textOf(tree)).toContain('<a href="https://evil.example" onclick="x()">raw link</a>')
  })

  it.each(['kbd', 'sub', 'sup', 'mark'])('keeps %s without attributes', async (tag) => {
    const tree = await hastOf(`<${tag} class="a" onclick="x()" style="x" id="m">hit</${tag}>`)
    const [element] = elements(tree, tag)
    expect(element).toBeTruthy()
    expect(attributes(element)).toEqual([])
  })

  it('keeps a br without attributes', async () => {
    const tree = await hastOf('one<br class="y">two')
    const [br] = elements(tree, 'br')
    expect(br).toBeTruthy()
    expect(attributes(br)).toEqual([])
  })

  it('removes links and images whose protocol is not http or https', async () => {
    const tree = await hastOf(
      '[a](javascript:alert(1)) ![b](file:///etc/passwd) [c](https://ok.example)'
    )
    const hrefs = elements(tree, 'a').map((node) => node.properties?.href)
    expect(hrefs).toContain('https://ok.example')
    expect(hrefs.some((href) => typeof href === 'string' && href.startsWith('javascript:'))).toBe(
      false
    )
    const imgSources = elements(tree, 'img').map((node) => node.properties?.src)
    expect(imgSources.some((src) => typeof src === 'string' && src.startsWith('file:'))).toBe(false)
  })

  it('keeps the language class of a fenced block and no other class', async () => {
    const tree = await hastOf('```ts\nconst a = 1\n```')
    const [code] = elements(tree, 'code')
    expect(code?.properties?.className).toEqual(['language-ts'])
  })

  it('keeps a footnote id and its link under one prefix', async () => {
    const tree = await hastOf('claim[^1]\n\n[^1]: the note')
    const ids = elements(tree)
      .map((node) => node.properties?.id)
      .filter((id): id is string => typeof id === 'string')
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(id.startsWith('user-content-user-content-')).toBe(false)
    }
    const hrefs = elements(tree, 'a')
      .map((node) => node.properties?.href)
      .filter((href): href is string => typeof href === 'string' && href.startsWith('#'))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      expect(href.startsWith('#user-content-user-content-')).toBe(false)
      expect(ids).toContain(href.slice(1))
    }
  })
})
