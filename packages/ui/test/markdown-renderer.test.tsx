import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type * as MarkdownModule from '../src/markdown'
import type { MarkdownAssets, QuirkyMarkdownProps } from '../src/markdown'

const mermaidRender = mock(async (_id: string, source: string) => {
  if (source.includes('-->>')) throw new Error('Parse error on line 2:\n...A[loadTurns] -->> B[mergeProse]\n-----------------------^\nExpecting \'SEMI\', got \'LINK\'')
  if (source.includes('pwn')) return { svg: '<svg viewBox="0 0 10 10"><script>window.__pwned = true</script><text onclick="window.__pwned = true">pwned</text></svg>' }
  return { svg: '<svg viewBox="0 0 10 10"><text>drawn</text></svg>' }
})
const mermaidInitialize = mock((_config: Record<string, unknown>) => {})
mock.module('mermaid', () => ({ default: { initialize: mermaidInitialize, render: mermaidRender } }))

type Mounted = { root: Root; container: HTMLDivElement }
let act: typeof import('react').act
let createElement: typeof import('react').createElement
let createRoot: typeof import('react-dom/client').createRoot
let QuirkyMarkdown: typeof MarkdownModule.QuirkyMarkdown
let PATH_CANDIDATE: typeof MarkdownModule.PATH_CANDIDATE
let parseChartSpec: typeof MarkdownModule.parseChartSpec
let rehypeRaw: typeof import('rehype-raw').default
let rehypeSanitize: typeof import('rehype-sanitize').default
let defaultSchema: typeof import('rehype-sanitize').defaultSchema
let showcase: string
const mounted: Mounted[] = []
const writeText = mock(async (_text: string) => {})

type Props = Partial<QuirkyMarkdownProps>

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true })
  const [react, client, markdown, raw, sanitize] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../src/markdown'),
    import('rehype-raw'),
    import('rehype-sanitize')
  ])
  act = react.act
  createElement = react.createElement
  createRoot = client.createRoot
  QuirkyMarkdown = markdown.QuirkyMarkdown
  PATH_CANDIDATE = markdown.PATH_CANDIDATE
  parseChartSpec = markdown.parseChartSpec
  rehypeRaw = raw.default
  rehypeSanitize = sanitize.default
  defaultSchema = sanitize.defaultSchema
  showcase = await Bun.file(new URL('./fixtures/markdown-showcase.md', import.meta.url)).text()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  writeText.mockClear()
  mermaidRender.mockClear()
  mermaidInitialize.mockClear()
})

afterEach(async () => {
  for (const { root } of [...mounted].reverse()) await act(async () => root.unmount())
  mounted.length = 0
  document.body.innerHTML = ''
})

const noop = () => {}

async function mount(props: Props & { text: string }): Promise<{ container: HTMLDivElement; rerender(next: Props): Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  let current: Props & { text: string } = props
  const draw = async () => {
    await act(async () => {
      root.render(createElement(QuirkyMarkdown, { profile: 'untrusted', onOpenLink: noop, ...current } as QuirkyMarkdownProps))
    })
  }
  await draw()
  return {
    container,
    async rerender(next) {
      current = { ...current, ...next }
      await draw()
    }
  }
}

async function settle(until: () => boolean, label = 'condition') {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
  }
  throw new Error(`timed out waiting for ${label}`)
}

const all = (container: Element, selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector))
const one = (container: Element, selector: string) => {
  const found = container.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no ${selector}`)
  return found
}
const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function assetsFor(files: Record<string, { line?: number } | null>, images: Record<string, string | null> = {}) {
  const resolveFiles = mock(async (candidates: string[]) => Object.fromEntries(candidates.map((candidate) => [candidate, files[candidate] ?? null])))
  const resolveImages = mock(async (srcs: string[]) => Object.fromEntries(srcs.map((src) => [src, images[src] ?? null])))
  const openFile = mock((_path: string, _line?: number) => {})
  const assets: MarkdownAssets = { resolveFiles, resolveImages, openFile }
  return { assets, resolveFiles, resolveImages, openFile }
}

describe('showcase fixture', () => {
  test('every block renders with its expected markup', async () => {
    const { assets } = assetsFor({ 'chat/turns.ts:119': { line: 119 } }, { '.quirk/screenshots/reload-check.png': 'blob:reload-check' })
    const { container } = await mount({ text: showcase, assets })
    await settle(() => !!container.querySelector('[data-path-chip]'), 'path chip')
    await settle(() => !!container.querySelector('figure img'), 'local image')
    await settle(() => !!container.querySelector('[data-qmd-data="mermaid"] .qmd-figure-body')?.textContent, 'diagram')
    await settle(() => container.querySelectorAll('.qmd-code[data-highlighted="true"]').length >= 2, 'highlighting')

    expect(one(container, '.qmd').dataset.profile).toBe('untrusted')
    expect(all(container, 'h1, h2, h3, h4').map((heading) => heading.tagName)).toEqual(['H1', 'H2', 'H3', 'H2', 'H4', 'H2'])
    expect(one(container, '[data-path-chip]').dataset.path).toBe('chat/turns.ts')
    expect(one(container, 'code[data-streamdown="inline-code"]').textContent).toBe('mergeProse()')
    expect(one(container, 'a[data-streamdown="link"]').textContent).toBe('original chat PR')
    expect(all(container, '[data-alert]').map((alert) => alert.dataset.alert)).toEqual(['warning', 'tip'])
    expect(all(container, 'kbd').map((key) => key.textContent)).toEqual(['⌘', 'R'])
    expect(all(container, 'input[type="checkbox"]').map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, false])
    expect(all(container, 'input[type="checkbox"]').every((box) => (box as HTMLInputElement).disabled)).toBe(true)
    expect(one(container, '[data-language="ts"] .qmd-code-title').textContent).toBe('turns.ts')
    expect(all(container, '[data-diff]').map((line) => line.dataset.diff)).toEqual(['ctx', 'del', 'add'])
    expect(one(container, '.qmd-code-toggle').textContent).toBe('Show all 23 lines')
    expect(all(container, '[data-streamdown="table"] thead th').length).toBeGreaterThan(0)
    expect(all(container, '[data-streamdown="table-header-cell"]').map((cell) => cell.textContent)).toContain('Result')
    expect(one(container, '[data-qmd-data="mermaid"] .qmd-figure-body').textContent).toBe('drawn')
    expect(container.querySelectorAll('.katex').length).toBe(2)
    expect(container.querySelector('.katex-display')).toBeTruthy()
    expect(container.textContent).toContain('a $5 or $10 price')
    expect(one(container, 'details > summary').textContent).toBe('Why not keep partial items out of the saved file?')
    expect(one(container, 'mark').textContent).toBe('The merge keeps both.')
    expect(all(container, '[data-qmd-data="table"] tbody tr').length).toBe(3)
    expect(one(container, '[data-qmd-data="json"] summary').textContent).toBe('{ 3 keys }')
    expect(one(container, '[data-qmd-data="chart"] svg.qmd-chart')).toBeTruthy()
    expect(one(container, 'figure figcaption').textContent).toBe('.quirk/screenshots/reload-check.png')
    expect(one(container, '[data-remote-image]').textContent).toContain('status.example.com/badge.png')
    expect(container.querySelectorAll('img[src^="http"]').length).toBe(0)
    expect(one(container, 'sub').textContent).toBe('2')
    expect(one(container, 'sup:not([data-footnote-ref])').textContent).toBeTruthy()
    expect(container.textContent).toContain('🚀')
    expect(one(container, 'section[data-footnotes] li').id).toBe('user-content-fn-1')
  })

  test('the same text renders again with no changes to its markup', async () => {
    const first = await mount({ text: '# Heading\n\nA paragraph with `code` and **bold**.' })
    const second = await mount({ text: '# Heading\n\nA paragraph with `code` and **bold**.' })
    expect(first.container.innerHTML.replace(/sd-[\w:-]+/g, '')).toBe(second.container.innerHTML.replace(/sd-[\w:-]+/g, ''))
  })
})

describe('streaming (SC-1, SC-2)', () => {
  test('unfinished bold already reads as bold with no stray asterisks', async () => {
    const { container } = await mount({ text: 'The reload path is **the root cau', streaming: true })
    expect(one(container, '[data-streamdown="strong"]').textContent).toBe('the root cau')
    expect(container.textContent).not.toContain('*')
  })

  test('a half-written link shows as plain text', async () => {
    const { container } = await mount({ text: 'See the [original chat PR](https://gith', streaming: true })
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('original chat PR')
    expect(container.textContent).not.toContain('](')
    expect(container.textContent).not.toContain('https://gith')
  })

  test('an open fence is already a code block with its header and the caret inside', async () => {
    const { container } = await mount({ text: 'Here it is:\n\n```ts\nconst a = 1\nconst b = 2\nconst c =', streaming: true })
    const block = one(container, '.qmd-code[data-language="ts"]')
    expect(one(block, '.qmd-code-title').textContent).toBe('ts')
    expect(one(block, '[data-streamdown="code-block-copy-button"]')).toBeTruthy()
    expect(all(block, '.qmd-line').length).toBe(3)
    expect(block.dataset.incomplete).toBe('true')
    expect(block.querySelector('.qmd-caret')).toBeTruthy()
    expect(container.querySelectorAll('.qmd-caret').length).toBe(1)
    expect(container.textContent).not.toContain('```')
    expect(block.querySelector('.qmd-line span[style]')).toBeNull()
  })

  test('the caret follows the last block when no fence is open', async () => {
    const { container } = await mount({ text: 'Now running the reload test suite', streaming: true })
    const carets = all(container, '.qmd-caret')
    expect(carets.length).toBe(1)
    expect(carets[0].getAttribute('aria-hidden')).toBe('true')
    expect(carets[0].textContent).toBe('▍')
    expect(carets[0].previousElementSibling?.getAttribute('data-qmd-body')).toBe('')
  })

  test('there is no caret once streaming ends', async () => {
    const { container, rerender } = await mount({ text: 'Done', streaming: true })
    expect(container.querySelector('.qmd-caret')).not.toBeNull()
    await rerender({ streaming: false })
    expect(container.querySelector('.qmd-caret')).toBeNull()
  })

  test('colour arrives when the fence closes, in the same lines, and a long open block is never collapsed', async () => {
    const body = Array.from({ length: 25 }, (_, index) => `const v${index} = ${index}`).join('\n')
    const open = `\`\`\`ts\n${body}`
    const { container, rerender } = await mount({ text: open, streaming: true })
    let block = one(container, '.qmd-code')
    expect(block.dataset.collapsed).toBeUndefined()
    expect(block.dataset.numbered).toBe('true')
    expect(block.querySelector('.qmd-code-toggle')).toBeNull()
    expect(block.querySelector('[style]')).toBeNull()
    const lineCount = all(block, '.qmd-line').length

    await rerender({ text: `${open}\n\`\`\``, streaming: false })
    await settle(() => !!container.querySelector('.qmd-code[data-highlighted="true"]'), 'highlighting')
    block = one(container, '.qmd-code')
    expect(all(block, '.qmd-line').length).toBe(lineCount)
    expect(all(block, '.qmd-line span[style]').length).toBeGreaterThan(0)
    expect(block.dataset.collapsed).toBe('true')
    expect(one(block, '.qmd-code-toggle').textContent).toBe('Show all 25 lines')
  })

  test('a finished block keeps its DOM node while the text grows', async () => {
    const { container, rerender } = await mount({ text: '# Title\n\nFirst paragraph.\n\nSecond', streaming: true })
    const heading = one(container, 'h1')
    const first = all(container, 'p')[0]
    await rerender({ text: '# Title\n\nFirst paragraph.\n\nSecond paragraph grows', streaming: true })
    expect(one(container, 'h1')).toBe(heading)
    expect(all(container, 'p')[0]).toBe(first)
    expect(all(container, 'p')[1].textContent).toBe('Second paragraph grows')
  })
})

describe('links and images (SC-5, SC-7, SC-8)', () => {
  test('an http link click goes to the caller and never navigates', async () => {
    const onOpenLink = mock((_href: string) => {})
    const { container } = await mount({ text: 'Read [the PR](https://github.com/zpyoung/quirky/pull/637) now', onOpenLink })
    const link = one(container, 'a')
    expect(link.getAttribute('target')).toBeNull()
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => {
      link.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(onOpenLink).toHaveBeenCalledWith('https://github.com/zpyoung/quirky/pull/637')
    expect(container.querySelector('[data-streamdown="link-safety-modal"]')).toBeNull()
  })

  test('other schemes render the link text as plain text', async () => {
    const { container } = await mount({ text: '[bad](javascript:alert(1)) and [mail](mailto:a@b.co) and [data](data:text/html,x) and [ok](https://x.io)' })
    expect(all(container, 'a').map((anchor) => anchor.getAttribute('href'))).toEqual(['https://x.io'])
    expect(container.textContent).toContain('bad and mail and data and ok')
  })

  test('a remote image is a chip, never an img, and the chip goes to the link prompt', async () => {
    const onOpenLink = mock((_href: string) => {})
    const { container } = await mount({ text: '![badge](https://status.example.com/badge.png) ![x](//cdn.example.com/a.gif)', onOpenLink })
    expect(container.querySelectorAll('img').length).toBe(0)
    const chips = all(container, '[data-remote-image]')
    expect(chips.length).toBe(2)
    await click(chips[0])
    expect(onOpenLink).toHaveBeenCalledWith('https://status.example.com/badge.png')
    await click(chips[1])
    expect(onOpenLink).toHaveBeenLastCalledWith('https://cdn.example.com/a.gif')
  })

  test('a worktree image shows with its path as a caption, and its alt text before it resolves', async () => {
    const { assets } = assetsFor({}, { 'shots/a.png': 'blob:a', 'shots/missing.png': null })
    const { container } = await mount({ text: '![the alt](shots/a.png)\n\n![gone](shots/missing.png)', assets })
    await settle(() => !!container.querySelector('figure'), 'figure')
    expect(one(container, 'figure img').getAttribute('src')).toBe('blob:a')
    expect(one(container, 'figure img').getAttribute('alt')).toBe('the alt')
    expect(one(container, 'figcaption').textContent).toBe('shots/a.png')
    expect(container.textContent).toContain('gone')
    expect(all(container, 'img').length).toBe(1)
  })

  test('a local image with no assets renders its alt text', async () => {
    const { container } = await mount({ text: '![the alt](shots/a.png)' })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('the alt')
  })

  test('raw img shows as text and fetches nothing; details keeps working without its attributes', async () => {
    const text = [
      'Look: <img src="https://x.io/p.gif">',
      '',
      '<details open onclick="steal()" class="x"><summary style="color:red">Why</summary>Because <b>bold</b></details>',
      '',
      '<script>window.__pwned = true</script>',
      '',
      '<a href="https://evil.example" onclick="x()">raw link</a>'
    ].join('\n')
    const { container } = await mount({ text })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src="https://x.io/p.gif">')
    const details = one(container, 'details')
    expect(details.getAttributeNames()).toEqual([])
    const summary = one(details, 'summary')
    expect(summary.getAttributeNames()).toEqual([])
    expect(summary.textContent).toBe('Why')
    expect(details.textContent).toContain('Because <b>bold</b>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('<a href="https://evil.example" onclick="x()">raw link</a>')
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  test('kbd, sub, sup, mark and br keep no attributes', async () => {
    const { container } = await mount({ text: '<kbd class="a" onclick="x()">K</kbd> H<sub style="x">2</sub>O<br class="y">next <mark id="m">hit</mark>' })
    for (const selector of ['kbd', 'sub', 'br', 'mark']) {
      const element = one(container, selector)
      for (const authored of ['onclick', 'style', 'id']) expect(element.hasAttribute(authored)).toBe(false)
      expect(element.getAttribute('class') ?? '').not.toMatch(/^(?:a|y)$/)
    }
  })
})

describe('path chips (SC-6)', () => {
  const text = [
    'The reload path in chat/turns.ts:119 and `src/window/chat/Turn.tsx` and `missing/gone.ts:3` matter.',
    '',
    '```ts',
    'import x from "inside/fence.ts:4"',
    '```',
    '',
    'A link [chat/linked.ts](https://example.com) and https://example.com/a/b.html stay put.'
  ].join('\n')

  test('every candidate goes to one resolveFiles call, and only existing files become chips', async () => {
    const { assets, resolveFiles, openFile } = assetsFor({ 'chat/turns.ts:119': { line: 119 }, 'src/window/chat/Turn.tsx': {} })
    const { container } = await mount({ text, assets })
    await settle(() => container.querySelectorAll('[data-path-chip]').length === 2, 'chips')
    expect(resolveFiles).toHaveBeenCalledTimes(1)
    const asked = resolveFiles.mock.calls[0][0]
    expect(asked).toContain('chat/turns.ts:119')
    expect(asked).toContain('src/window/chat/Turn.tsx')
    expect(asked).toContain('missing/gone.ts:3')
    expect(asked).not.toContain('inside/fence.ts:4')
    expect(all(container, '[data-path-chip]').map((chip) => chip.textContent)).toEqual(['chat/turns.ts:119', 'src/window/chat/Turn.tsx'])
    expect(all(container, 'code[data-streamdown="inline-code"]').map((code) => code.textContent)).toEqual(['missing/gone.ts:3'])
    expect(container.textContent).toContain('inside/fence.ts:4')
    await click(all(container, '[data-path-chip]')[0])
    expect(openFile).toHaveBeenCalledWith('chat/turns.ts', 119)
  })

  test('without assets there are no chips and prose paths stay prose', async () => {
    const { container } = await mount({ text })
    expect(container.querySelector('[data-path-chip]')).toBeNull()
    expect(all(container, 'code').length).toBe(3)
  })

  test('resolution waits for the end of streaming and is cached per assets instance', async () => {
    const { assets, resolveFiles } = assetsFor({ 'a/b.ts': {} })
    const first = await mount({ text: 'see a/b.ts', assets, streaming: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(resolveFiles).not.toHaveBeenCalled()
    await first.rerender({ streaming: false })
    await settle(() => !!first.container.querySelector('[data-path-chip]'), 'chip')
    await mount({ text: 'again a/b.ts', assets })
    await settle(() => document.querySelectorAll('[data-path-chip]').length === 2, 'second chip')
    expect(resolveFiles).toHaveBeenCalledTimes(1)
  })
})

describe('alerts', () => {
  test('all five markers draw an alert, case-insensitively, with the marker hidden', async () => {
    const text = ['NOTE', 'tip', 'Important', 'WARNING', 'caution']
      .map((marker) => `> [!${marker}]\n> Body of ${marker}`)
      .join('\n\n')
    const { container } = await mount({ text })
    const alerts = all(container, '[data-alert]')
    expect(alerts.map((alert) => alert.dataset.alert)).toEqual(['note', 'tip', 'important', 'warning', 'caution'])
    expect(alerts.every((alert) => alert.getAttribute('role') === 'note')).toBe(true)
    expect(alerts.map((alert) => one(alert, '.qmd-alert-label').textContent)).toEqual(
      ['note', 'tip', 'important', 'warning', 'caution'].map((type) => `${type === 'note' ? 'ⓘ' : type === 'tip' ? '✦' : type === 'important' ? '◆' : type === 'warning' ? '⚠︎' : '✕'}${type[0].toUpperCase()}${type.slice(1)}`)
    )
    expect(container.textContent).not.toContain('[!')
    expect(one(alerts[0], '.qmd-alert-body').textContent?.trim()).toBe('Body of NOTE')
  })

  test('a plain quote, and a marker that is not first, stay quotes', async () => {
    const { container } = await mount({ text: '> just a quote\n\n> some words\n> [!NOTE] later' })
    expect(container.querySelector('[data-alert]')).toBeNull()
    expect(all(container, 'blockquote').length).toBe(2)
  })

  test('a nested marker is not an alert', async () => {
    const { container } = await mount({ text: '> [!TIP]\n> outer\n>\n> > [!NOTE]\n> > inner' })
    expect(all(container, '[data-alert]').map((alert) => alert.dataset.alert)).toEqual(['tip'])
    expect(container.querySelectorAll('blockquote').length).toBe(1)
    expect(container.textContent).toContain('[!NOTE]')
  })

  test('alerts work without any alert attribute in the sanitize schema', async () => {
    const { container } = await mount({ text: '> [!IMPORTANT]\n> read this' })
    expect(one(container, '[data-alert="important"]')).toBeTruthy()
  })
})

describe('code blocks (SC-2, SC-11, SC-12)', () => {
  test('the header shows the language, or the title= value', async () => {
    const { container } = await mount({ text: '```ts title=Prose.tsx\nconst a = 1\n```\n\n```python\nprint(1)\n```' })
    expect(all(container, '.qmd-code-title').map((title) => title.textContent)).toEqual(['Prose.tsx', 'python'])
  })

  test('line numbers appear only past 8 lines', async () => {
    const eight = Array.from({ length: 8 }, (_, index) => `l${index}`).join('\n')
    const { container } = await mount({ text: `\`\`\`\n${eight}\n\`\`\`\n\n\`\`\`\n${eight}\nninth\n\`\`\`` })
    expect(all(container, '.qmd-code').map((block) => block.dataset.numbered)).toEqual([undefined, 'true'])
  })

  test('Copy writes the raw code without numbers and reads Copied for a moment', async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)
    const { container } = await mount({ text: `\`\`\`txt\n${lines.join('\n')}\n\`\`\`` })
    const button = one(container, '[data-streamdown="code-block-copy-button"]')
    expect(one(container, '.qmd-code').dataset.numbered).toBe('true')
    await click(button)
    expect(writeText).toHaveBeenCalledWith(lines.join('\n'))
    expect(button.textContent).toBe('Copied')
    await settle(() => button.textContent === 'Copy', 'copy label to reset')
  })

  test('a 23 line block collapses behind a Show all bar and expands', async () => {
    const lines = Array.from({ length: 23 }, (_, index) => `line ${index + 1}`).join('\n')
    const { container } = await mount({ text: `\`\`\`txt\n${lines}\n\`\`\`` })
    const block = one(container, '.qmd-code')
    expect(block.dataset.collapsed).toBe('true')
    expect(block.querySelector('.qmd-code-fade')).toBeTruthy()
    const toggle = one(block, '.qmd-code-toggle')
    expect(toggle.textContent).toBe('Show all 23 lines')
    await click(toggle)
    expect(block.dataset.collapsed).toBeUndefined()
    expect(toggle.textContent).toBe('Show less')
    await click(toggle)
    expect(toggle.textContent).toBe('Show all 23 lines')
  })

  test('a 20 line block is not collapsed', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const { container } = await mount({ text: `\`\`\`txt\n${lines}\n\`\`\`` })
    expect(container.querySelector('.qmd-code-toggle')).toBeNull()
  })

  test('an unknown language keeps the header and Copy with no colour', async () => {
    const { container } = await mount({ text: '```zig-ish\npub fn merge(prev: []Item) !void {}\n```' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const block = one(container, '.qmd-code')
    expect(one(block, '.qmd-code-title').textContent).toBe('zig-ish')
    expect(one(block, '[data-streamdown="code-block-copy-button"]').textContent).toBe('Copy')
    expect(block.querySelector('[style]')).toBeNull()
    expect(block.dataset.highlighted).toBeUndefined()
  })

  test('diff lines carry add, del and ctx from their first character', async () => {
    const { container } = await mount({ text: '```diff\n unchanged\n-gone\n+added\n--- a/file\n+++ b/file\n```' })
    expect(all(container, '[data-diff]').map((line) => line.dataset.diff)).toEqual(['ctx', 'del', 'add', 'ctx', 'ctx'])
  })
})

describe('data fences (SC-13)', () => {
  test('csv with quoting becomes the zebra table markup, first row as the header', async () => {
    const { container } = await mount({ text: '```csv\nname,note\nA,"has, comma"\nB,"say ""hi"""\n```' })
    expect(all(container, 'th').map((cell) => cell.textContent)).toEqual(['name', 'note'])
    expect(all(container, 'td').map((cell) => cell.textContent)).toEqual(['A', 'has, comma', 'B', 'say "hi"'])
    expect(one(container, '[data-streamdown="table-wrapper"] [data-streamdown="table"]')).toBeTruthy()
  })

  test('tsv splits on tabs', async () => {
    const { container } = await mount({ text: '```tsv\na\tb\n1\t2\n```' })
    expect(all(container, 'th').map((cell) => cell.textContent)).toEqual(['a', 'b'])
  })

  test('an unterminated quote is a parse failure shown above an ordinary code block', async () => {
    const { container } = await mount({ text: '```csv\na,b\n"1,2\n```' })
    expect(one(container, '[data-qmd-error] .qmd-error-message').textContent).toMatch(/^Couldn't read this csv block: /)
    expect(one(container, '.qmd-code[data-language="csv"]')).toBeTruthy()
  })

  test('json opens the top level and folds nested containers with counts', async () => {
    const { container } = await mount({ text: '```json\n{"a":1,"b":{"c":[1,2,3],"d":{}},"e":[]}\n```' })
    const nodes = all(container, 'details.qmd-json-node')
    expect(nodes.map((node) => node.hasAttribute('open'))).toEqual([true, false, false])
    expect(nodes.map((node) => one(node, 'summary').textContent)).toEqual(['{ 3 keys }', '"b": { 2 keys }', '"c": [ 3 items ]'])
  })

  test('invalid json shows the note above a code block', async () => {
    const { container } = await mount({ text: '```json\n{"a":\n```' })
    expect(one(container, '[data-qmd-error] .qmd-error-message').textContent).toMatch(/^Couldn't read this json block: /)
    expect(one(container, '.qmd-code[data-language="json"] .qmd-line')).toBeTruthy()
  })

  test('chart draws bars from inline data and toggles to its source', async () => {
    const spec = '{"type":"bar","title":"sizes","unit":"ms","data":[{"label":"a","value":2},{"label":"b","value":4}]}'
    const { container } = await mount({ text: `\`\`\`chart\n${spec}\n\`\`\`` })
    expect(all(container, 'rect.qmd-chart-bar').length).toBe(2)
    expect(one(container, '.qmd-code-title').textContent).toBe('chart · sizes')
    const toggle = all(container, '.qmd-code-button')[0]
    await click(toggle)
    expect(one(container, 'pre.qmd-source').textContent).toBe(spec)
    expect(container.querySelector('svg')).toBeNull()
    expect(toggle.textContent).toBe('Chart')
  })

  test('chart draws a line from a csv fence named in from', async () => {
    const text = '```csv title=pts\nday,ms\nmon,3\ntue,5\nwed,4\n```\n\n```chart\n{"type":"line","from":"pts","x":"day","y":"ms"}\n```'
    const { container } = await mount({ text })
    expect(one(container, 'polyline.qmd-chart-line').getAttribute('points')?.split(' ').length).toBe(3)
    expect(all(container, 'circle').length).toBe(3)
  })

  test('chart errors name the problem', async () => {
    const noBlock = await mount({ text: '```chart\n{"type":"bar","from":"nope","x":"a","y":"b"}\n```' })
    expect(one(noBlock.container, '[data-qmd-error]').textContent).toContain("Couldn't read this chart block: no csv block named nope")
    const both = await mount({ text: '```chart\n{"type":"bar","from":"x","x":"a","y":"b","data":[{"label":"a","value":1}]}\n```' })
    expect(one(both.container, '[data-qmd-error]').textContent).toContain('exactly one of')
    const badColumn = await mount({ text: '```csv title=t\na,b\n1,2\n```\n\n```chart\n{"type":"bar","from":"t","x":"a","y":"zzz"}\n```' })
    expect(one(badColumn.container, '[data-qmd-error]').textContent).toContain('no column zzz')
  })

  test('data fences are plain code while still open', async () => {
    const { container } = await mount({ text: '```json\n{"a":', streaming: true })
    expect(container.querySelector('.qmd-json')).toBeNull()
    expect(container.querySelector('[data-qmd-error]')).toBeNull()
    expect(one(container, '.qmd-code[data-incomplete="true"]')).toBeTruthy()
  })
})

describe('mermaid and math (SC-4, SC-10)', () => {
  test('a diagram renders through strict mermaid and sanitised svg, with a Source toggle', async () => {
    const { container } = await mount({ text: '```mermaid\nflowchart TD\n  S --> T\n```' })
    await settle(() => !!container.querySelector('[data-qmd-data="mermaid"] .qmd-figure-body')?.textContent, 'diagram')
    expect(mermaidInitialize.mock.calls[0][0]).toMatchObject({ startOnLoad: false, securityLevel: 'strict', theme: 'base' })
    expect(container.textContent).toContain('drawn')
    const toggle = one(container, '.qmd-code-button')
    expect(toggle.textContent).toBe('Source')
    await click(toggle)
    expect(one(container, 'pre.qmd-source').textContent).toBe('flowchart TD\n  S --> T')
    expect(toggle.textContent).toBe('Diagram')
  })

  test('diagram svg is sanitised before it reaches the page', async () => {
    const { container } = await mount({ text: '```mermaid\nflowchart LR\n  pwn --> B\n```' })
    await settle(() => !!container.querySelector('[data-qmd-data="mermaid"]'), 'diagram frame')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onclick]')).toBeNull()
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  test('while a mermaid fence is open it is plain source and mermaid is not called', async () => {
    const { container } = await mount({ text: '```mermaid\nflowchart LR\n  A --', streaming: true })
    expect(mermaidRender).not.toHaveBeenCalled()
    expect(one(container, '.qmd-code[data-incomplete="true"]')).toBeTruthy()
  })

  test('a bad diagram shows the note and the source, and the rest of the message renders', async () => {
    const { container } = await mount({ text: 'Before\n\n```mermaid\nflowchart LR\n  A[loadTurns] -->> B[mergeProse]\n```\n\nAfter **bold**' })
    await settle(() => !!container.querySelector('[data-qmd-error]'), 'error note')
    expect(one(container, '[data-qmd-error] .qmd-error-message').textContent).toMatch(/^Couldn't draw this diagram: .*\. Showing the source\.$/)
    expect(container.textContent).toContain('A[loadTurns] -->> B[mergeProse]')
    expect(container.textContent).toContain('Before')
    expect(one(container, '[data-streamdown="strong"]').textContent).toBe('bold')
  })

  test('math with an error shows the note and its source', async () => {
    const { container } = await mount({ text: 'Cost:\n\n$$\nT = \\sume_{i=1}^n c_i\n$$\n\nand $x^2$ is fine' })
    const note = one(container, '[data-qmd-error]')
    expect(one(note, '.qmd-error-message').textContent).toMatch(/^Couldn't typeset: .*sume/)
    expect(note.textContent).toContain('\\sume_{i=1}^n c_i')
    expect(container.querySelectorAll('.katex').length).toBeGreaterThan(0)
  })

  test('prices, code and real math follow the strict dollar rule', async () => {
    const { container } = await mount({ text: 'costs $5 and $10, run `echo $HOME`, complexity $O(n)$.\n\n```sh\necho $HOME and $PATH\n```' })
    const text = container.textContent ?? ''
    expect(text).toContain('costs $5 and $10')
    expect(one(container, 'code[data-streamdown="inline-code"]').textContent).toBe('echo $HOME')
    expect(text).toContain('echo $HOME and $PATH')
    expect(container.querySelectorAll('.katex').length).toBe(1)
    expect(one(container, '.katex annotation').textContent).toBe('O(n)')
  })

  test('paren and bracket delimiters are math', async () => {
    const { container } = await mount({ text: 'so \\(x^2\\) and\n\n\\[y^2\\]' })
    expect(container.querySelectorAll('.katex').length).toBe(2)
  })
})

describe('text extras', () => {
  test('hard breaks survive, highlight, emoji and footnotes work', async () => {
    const { container } = await mount({ text: 'line one\nline two ==marked== :rocket: note[^a]\n\n[^a]: the note' })
    expect(container.querySelector('br')).toBeTruthy()
    expect(one(container, 'mark').textContent).toBe('marked')
    expect(container.textContent).toContain('🚀')
    expect(one(container, 'a[href="#user-content-fn-a"]').id).toBe('user-content-fnref-a')
    expect(one(container, 'li[id="user-content-fn-a"]')).toBeTruthy()
  })

  test('a caller className lands on the root wrapper', async () => {
    const { container } = await mount({ text: 'x', className: 'chat-prose' })
    expect(one(container, '.qmd').classList.contains('chat-prose')).toBe(true)
  })

  test('caller components win over the built-ins', async () => {
    const { container } = await mount({
      text: '# hello',
      components: { h1: ({ children }: { children?: unknown }) => createElement('h1', { 'data-mine': '' }, children as never) } as never
    })
    expect(one(container, 'h1[data-mine]')).toBeTruthy()
  })

  test('caller fence renderers win over the built-ins', async () => {
    const { container } = await mount({
      text: '```json\n{"a":1}\n```',
      renderers: [{ language: 'json', component: ({ code }: { code: string }) => createElement('i', { 'data-custom': '' }, code) }]
    })
    expect(one(container, 'i[data-custom]').textContent).toBe('{"a":1}')
  })
})

describe('profiles', () => {
  test('the untrusted profile refuses rehypePlugins', async () => {
    const spy = mock(() => {})
    const original = console.error
    console.error = spy
    try {
      await expect(mount({ text: 'x', rehypePlugins: [rehypeRaw] })).rejects.toThrow('untrusted profile takes no rehypePlugins')
    } finally {
      console.error = original
    }
  })

  test('the file profile requires rehypePlugins', async () => {
    const original = console.error
    console.error = () => {}
    try {
      await expect(mount({ text: 'x', profile: 'file' })).rejects.toThrow('file profile requires rehypePlugins')
    } finally {
      console.error = original
    }
  })

  test('the file profile keeps cleaned raw html, still renders math once, and ignores assets', async () => {
    const schema = { ...defaultSchema, attributes: { ...defaultSchema.attributes, p: ['align'] } }
    const { assets, resolveFiles } = assetsFor({ 'a/b.ts': {} })
    const text = '<p align="center" onclick="x()">centred</p>\n\nsee a/b.ts and $x^2$ and $5\n\n```mermaid\nflowchart LR\n  A --> B\n```'
    const { container } = await mount({ text, profile: 'file', rehypePlugins: [rehypeRaw, [rehypeSanitize, schema]], assets })
    const paragraph = one(container, 'p[align="center"]')
    expect(paragraph.getAttribute('onclick')).toBeNull()
    expect(paragraph.textContent).toBe('centred')
    expect(one(container, '.qmd').dataset.profile).toBe('file')
    expect(container.querySelector('[data-path-chip]')).toBeNull()
    expect(resolveFiles).not.toHaveBeenCalled()
    await settle(() => !!container.querySelector('[data-qmd-data="mermaid"]'), 'diagram')
  })

  test('file profile remark plugins from the caller run', async () => {
    const seen: string[] = []
    const probe = () => (tree: { children: unknown[] }) => {
      seen.push(`${tree.children.length}`)
    }
    const { container } = await mount({ text: 'hello', profile: 'file', rehypePlugins: [rehypeRaw, [rehypeSanitize, defaultSchema]], remarkPlugins: [probe] })
    expect(seen.length).toBeGreaterThan(0)
    expect(container.textContent).toBe('hello')
  })
})

describe('PATH_CANDIDATE', () => {
  const found = (text: string) => Array.from(text.matchAll(PATH_CANDIDATE), (match) => match[0])

  test('matches relative paths with an extension and an optional line and column', () => {
    expect(found('see chat/turns.ts:119 and ./src/a.tsx and ../up/b.json:3:9 and a/b/c.d.ts')).toEqual([
      'chat/turns.ts:119', './src/a.tsx', '../up/b.json:3:9', 'a/b/c.d.ts'
    ])
  })

  test('skips urls, emails, bare file names and paths with no extension', () => {
    expect(found('https://x.io/a/b.html mail me@host.co/x.y plain.ts src/dir/ a/b')).toEqual([])
  })

  test('captures the path, line and column in groups', () => {
    const match = new RegExp(PATH_CANDIDATE.source).exec('x a/b.ts:12:3 y')
    expect([match?.[1], match?.[2], match?.[3]]).toEqual(['a/b.ts', '12', '3'])
  })
})

describe('parseChartSpec', () => {
  test('accepts bar and line specs with inline data', () => {
    expect(parseChartSpec('{"type":"bar","data":[{"label":"a","value":1}]}')).toEqual({ type: 'bar', data: [{ label: 'a', value: 1 }] })
    expect(parseChartSpec('{"type":"line","title":"t","unit":"ms","data":[{"x":1,"y":2},{"x":"b","y":3}]}')).toEqual({
      type: 'line', title: 't', unit: 'ms', data: [{ x: 1, y: 2 }, { x: 'b', y: 3 }]
    })
  })

  test('accepts a from spec with column names', () => {
    expect(parseChartSpec('{"type":"bar","from":"sizes","x":"session","y":"ms"}')).toEqual({ type: 'bar', from: 'sizes', x: 'session', y: 'ms' })
  })

  test('rejects what the schema forbids', () => {
    const errorOf = (source: string) => (parseChartSpec(source) as { error: string }).error
    expect(errorOf('nope')).toMatch(/^invalid JSON/)
    expect(errorOf('[]')).toBe('expected a JSON object')
    expect(errorOf('{"type":"pie","data":[]}')).toBe('"type" must be "bar" or "line"')
    expect(errorOf('{"type":"bar"}')).toBe('exactly one of "data" and "from" is required')
    expect(errorOf('{"type":"bar","from":"a","x":"b","y":"c","data":[]}')).toBe('exactly one of "data" and "from" is required')
    expect(errorOf('{"type":"bar","from":"a"}')).toBe('"from" needs "x" and "y" column names')
    expect(errorOf('{"type":"bar","data":[]}')).toBe('"data" must be a non-empty array')
    expect(errorOf('{"type":"bar","data":[{"label":"a","value":"1"}]}')).toContain('data[0]')
    expect(errorOf('{"type":"line","data":[{"x":1,"y":"2"}]}')).toContain('data[0]')
    expect(errorOf('{"type":"bar","title":3,"data":[{"label":"a","value":1}]}')).toBe('"title" must be a string')
  })
})
