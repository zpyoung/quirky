import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'

const EDITOR_OPEN = 'quirky.editor/open'
const EDITOR_DRAFT = 'quirky.editor/draft'
const EDITOR_SAVE = 'quirky.editor/save'
const MARKDOWN = 'quirky.editor/markdown'
const NOTES = 'quirky.editor/notes'

type Api = (method: string, params?: Record<string, unknown>) => Promise<any>
type Fixture = { h: Harness; client: QuirkyClient; call: Api; root: string; worktree: string }

let fixture: Fixture | null = null
let activeHarness: Harness | null = null

beforeEach(async () => {
  const home = makeHomeWithoutAutoHooks('m2-markdown-')
  const h = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  activeHarness = h
  const client = await h.connect('cli')
  const root = join(home, 'workspace')
  mkdirSync(root, { recursive: true })
  await client.callAny('quirky.repo/add', { path: root, folder: true })
  const worktree = (await client.callAny('quirky.worktree/resolve', { selector: `path:${root}` })) as { id: string }
  fixture = {
    h,
    client,
    root,
    worktree: `id:${worktree.id}`,
    call: (method, params = {}) => client.callAny(method, params)
  }
})

afterEach(async () => {
  await activeHarness?.cleanup()
  activeHarness = null
  fixture = null
})

function current(): Fixture {
  if (!fixture) throw new Error('Markdown daemon fixture was not started')
  return fixture
}

function put(path: string, content: string | Uint8Array): void {
  const f = current()
  const absolute = join(f.root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
}

async function open(path: string, mode: 'source' | 'rich' | 'preview' = 'rich'): Promise<any> {
  const f = current()
  return f.call(EDITOR_OPEN, { worktree: f.worktree, path, mode, focus: false })
}

async function md(action: string, fields: Record<string, unknown> = {}): Promise<any> {
  return current().call(MARKDOWN, { action, ...fields })
}

async function notes(action: string, fields: Record<string, unknown> = {}): Promise<any> {
  return current().call(NOTES, { action, ...fields })
}

describe('Markdown through the daemon API', () => {
  test('SC-12: rich edits preserve untouched CRLF/front matter bytes; source, rich, preview and save share one draft', async () => {
    const f = current()
    const source = [
      '---',
      'title: Kept exactly',
      '---',
      '',
      'First paragraph has   unusual spacing.',
      '',
      '*  an oddly spaced list item',
      '',
      'A literal \\*escaped phrase\\* remains source-safe.',
      '',
      'Paragraph two is old.',
      ''
    ].join('\r\n')
    put('roundtrip.md', source)

    const edit = await open('roundtrip.md')
    const caps = await md('capabilities', { bufferId: edit.id, includeCanonical: true })
    expect(caps.richEligible).toBe(true)
    expect(caps.canonicalText).toContain('Paragraph two is old.')

    await f.call(EDITOR_SAVE, { bufferId: edit.id })
    expect(readFileSync(join(f.root, 'roundtrip.md'), 'utf8')).toBe(source)

    const body = String(caps.canonicalText)
    const changed = body.replace('Paragraph two is old.', 'Paragraph two is new.')
    const applied = await md('apply', {
      bufferId: edit.id,
      expectedRevision: edit.contentRevision,
      text: changed
    })
    expect(applied.changed).toBe(true)
    expect(applied.sourcePreserved).toBe(true)
    expect(applied.buffer.draft).toContain('Paragraph two is new.')

    const sourceView = await open('roundtrip.md', 'source')
    const preview = await open('roundtrip.md', 'preview')
    expect(sourceView.id).toBe(edit.id)
    expect(preview.id).toBe(edit.id)
    expect(preview.draft).toBe(applied.buffer.draft)
    expect(preview.mode).toBe('preview')

    await f.call(EDITOR_SAVE, { bufferId: edit.id })
    const saved = readFileSync(join(f.root, 'roundtrip.md'), 'utf8')
    expect(saved).toBe(`${source.slice(0, source.indexOf('Paragraph two is old.'))}Paragraph two is new.\r\n`)
    expect(saved.startsWith('---\r\ntitle: Kept exactly\r\n---\r\n')).toBe(true)
    expect(saved).toContain('*  an oddly spaced list item\r\n')
    expect(saved).toContain('A literal \\*escaped phrase\\* remains source-safe.\r\n')
  })

  test('SC-12: unsupported round trips fail closed, rendered HTML and links are inert, and all size gates are enforced', async () => {
    const unsupported = [
      ['html.md', '<script>alert(1)</script>\n\nplain text'],
      ['jsx.mdx', '<Widget prop={value} />\n\nbody'],
      ['reference.md', '[read this][target]\n\n[target]: https://example.test'],
      ['footnote.md', 'Text[^1].\n\n[^1]: note']
    ] as const
    for (const [path, text] of unsupported) {
      put(path, text)
      const buffer = await open(path)
      const result = await md('capabilities', { bufferId: buffer.id, includePreview: true })
      expect(result.richEligible).toBe(false)
      expect(result.richReason).toBeTruthy()
      if (path === 'html.md') {
        expect(result.previewHtml).not.toMatch(/<script|onerror\s*=|javascript:/i)
        expect(result.previewHtml).not.toContain('alert(1)')
        expect(result.previewHtml).toContain('plain text')
      }
      await expect(md('apply', {
        bufferId: buffer.id,
        expectedRevision: buffer.contentRevision,
        text: 'replacement that must not be committed'
      })).rejects.toThrow()
      const unchanged = await open(path, 'source')
      expect(unchanged.draft).toBeNull()
      expect(readFileSync(join(current().root, path), 'utf8')).toBe(text)
    }

    const smallLarge = 'Title\n\n' + 'word '.repeat(Math.ceil((600 * 1024 + 1) / 5))
    put('large-rich.md', smallLarge)
    const largeRich = await open('large-rich.md')
    const ordinary = await md('capabilities', { bufferId: largeRich.id })
    expect(ordinary.richEligible).toBe(false)
    const override = await md('capabilities', { bufferId: largeRich.id, openAnyway: true })
    expect(override.richEligible).toBe(true)

    const tooLarge = 'word '.repeat(Math.ceil((1024 * 1024 + 1) / 5))
    put('too-large-rich.md', tooLarge)
    const tooLargeBuffer = await open('too-large-rich.md')
    const tooLargeCaps = await md('capabilities', { bufferId: tooLargeBuffer.id, openAnyway: true })
    expect(tooLargeCaps.richEligible).toBe(false)
    expect(tooLargeCaps.openAnywayAvailable).toBe(false)

    put('too-large-preview.md', 'word '.repeat(Math.ceil((8 * 1024 * 1024 + 1) / 5)))
    const previewBuffer = await open('too-large-preview.md', 'preview')
    const previewCaps = await md('capabilities', { bufferId: previewBuffer.id, includePreview: true })
    expect(previewCaps.previewAvailable).toBe(false)
    expect(previewCaps.previewHtml).toBeUndefined()

    const unsafeLink = await md('links', { bufferId: tooLargeBuffer.id, target: 'javascript:alert(1)' })
    expect(unsafeLink.safe).toBe(false)
    expect((await md('links', { bufferId: tooLargeBuffer.id, target: 'file:///private/etc/passwd' })).safe).toBe(false)
    const encodedLink = await md('links', { bufferId: tooLargeBuffer.id, target: 'https://example.test/a_(b)' })
    expect(encodedLink.safe).toBe(true)
    expect(encodedLink.href).toBe('https://example.test/a_(b)')
  })
  test('SC-12: details and KaTeX remain safe in preview with source fallback, sanitized raw HTML and relative links', async () => {
    const source = [
      '# Repeated heading',
      '',
      '<details open>',
      '<summary>Background</summary>',
      '',
      'Background context.',
      '',
      '</details>',
      '',
      'Equation $x^2$ and display math:',
      '',
      '$$',
      '\\frac{1}{2}',
      '$$',
      '',
      '[Target](docs/Target.md#target-heading)',
      ''
    ].join('\n')
    put('details.md', source)
    put('docs/Target.md', '# Target heading\n')
    put('asset.txt', 'authorized worktree file\n')
    const buffer = await open('details.md')
    const capabilities = await md('capabilities', { bufferId: buffer.id, includeCanonical: true, includePreview: true })

    expect(capabilities.richEligible).toBe(false)
    expect(capabilities.canonicalText).toBeUndefined()
    expect(capabilities.previewHtml).toMatch(/<details(?:\s+open(?:="")?)?>/)
    expect(capabilities.previewHtml).toContain('<summary>Background</summary>')
    expect(capabilities.previewHtml).toContain('class="katex"')
    expect(capabilities.previewHtml).toContain('<math')
    expect(capabilities.previewHtml).toContain('href="docs/Target.md#target-heading"')
    await expect(md('apply', {
      bufferId: buffer.id,
      expectedRevision: buffer.contentRevision,
      text: source.replace('Equation $x^2$ and display math:', 'Changed $x^2$ and display math:')
    })).rejects.toThrow()
    expect((await open('details.md', 'source')).draft).toBeNull()
    expect(readFileSync(join(current().root, 'details.md'), 'utf8')).toBe(source)
    put('empty-details.md', '<details><summary>Empty</summary></details>\n')
    const emptyDetails = await open('empty-details.md')
    const emptyCapabilities = await md('capabilities', { bufferId: emptyDetails.id, includeCanonical: true })
    expect(emptyCapabilities.richEligible).toBe(true)
    expect(emptyCapabilities.canonicalText).toContain('<details><summary>Empty</summary>')
    const fencedSource = '<details>\n<summary>Literal closing tag</summary>\n\n```html\n</details>\n```\n\nBody\n\n</details>\n'
    put('code-details.md', fencedSource)
    const codeDetails = await open('code-details.md')
    const codeCapabilities = await md('capabilities', { bufferId: codeDetails.id, includeCanonical: true })
    expect(codeCapabilities.richEligible).toBe(true)
    expect(codeCapabilities.canonicalText).toContain('```html\n</details>\n```')
    put('unroundtrippable-details.md', '<details><summary>Copyright &copy;</summary></details>\n')
    const unroundtrippableDetails = await open('unroundtrippable-details.md')
    const unroundtrippableCapabilities = await md('capabilities', { bufferId: unroundtrippableDetails.id, includeCanonical: true })
    expect(unroundtrippableCapabilities.richEligible).toBe(false)


    const markdownLink = await md('links', { bufferId: buffer.id, target: 'docs/Target.md#target-heading' })
    expect(markdownLink).toMatchObject({ safe: true, kind: 'document', resolved: 'docs/Target.md', anchor: 'target-heading' })
    expect(await md('links', { bufferId: buffer.id, target: '#repeated-heading' })).toMatchObject({ safe: true, kind: 'anchor', anchor: 'repeated-heading' })
    expect(await md('links', { bufferId: buffer.id, target: 'asset.txt' })).toMatchObject({ safe: true, kind: 'file', resolved: 'asset.txt' })
    expect((await md('links', { bufferId: buffer.id, target: '../../outside.txt' })).safe).toBe(false)

    const malicious = [
      '<details onclick="alert(1)"><summary>Attack</summary>',
      '<span class="katex-attacker" style="background-image:url(javascript:alert(1))">spoofed math</span>',
      '<a href="javascript:alert(1)" onmouseover="alert(2)">unsafe link</a>',
      '<img src="data:image/svg+xml,<svg onload=alert(3)>" onerror="alert(4)">',
      '</details>',
      '<iframe srcdoc="<script>alert(5)</script>"></iframe>',
      '<script>alert(6)</script>',
      '<object data="file:///private/etc/passwd"></object>',
      '<embed src="file:///private/etc/passwd">',
      '<svg onload="alert(7)"><script>alert(8)</script></svg>',
    ].join('\n')
    put('unsafe-details.md', malicious)
    const unsafeBuffer = await open('unsafe-details.md')
    const unsafeCapabilities = await md('capabilities', { bufferId: unsafeBuffer.id, includePreview: true })
    const previewHtml = String(unsafeCapabilities.previewHtml)
    expect(unsafeCapabilities.richEligible).toBe(false)
    expect(previewHtml).toContain('<details>')
    expect(previewHtml).toContain('<summary>Attack</summary>')
    expect(previewHtml).not.toContain('katex-attacker')
    expect(previewHtml).not.toMatch(/<(?:script|iframe|object|embed|svg)\b|\bon[a-z]+\s*=|javascript:|file:|url\s*\(/i)
    await expect(md('apply', {
      bufferId: unsafeBuffer.id,
      expectedRevision: unsafeBuffer.contentRevision,
      text: 'must not replace the unsupported source'
    })).rejects.toThrow()
    expect((await open('unsafe-details.md', 'source')).draft).toBeNull()
    expect(readFileSync(join(current().root, 'unsafe-details.md'), 'utf8')).toBe(malicious)
  })

  

  test('SC-13: formatting, slash-equivalent inserts, links, doc-link ambiguity and bounded image import are scriptable', async () => {
    const f = current()
    put('guide.md', 'Opening words here.\n\nEnd.\n')
    put('docs/Target.md', '# Target\n')
    put('a/Duplicate.md', 'one')
    put('b/Duplicate.md', 'two')
    put('images/pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pVsAAAAASUVORK5CYII=', 'base64'))
    put('pixel.png', 'user file remains untouched')
    const oversizedPng = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPng)
    oversizedPng.writeUInt32BE(100_000, 16)
    oversizedPng.writeUInt32BE(100_000, 20)
    put('images/oversized.png', oversizedPng)
    const buffer = await open('guide.md')

    const formatted = await md('format', {
      bufferId: buffer.id,
      expectedRevision: buffer.contentRevision,
      format: 'bold',
      selection: { from: 0, to: 'Opening'.length }
    })
    expect(formatted.buffer.draft).toContain('**Opening**')
    const heading = await md('format', {
      bufferId: buffer.id,
      expectedRevision: formatted.buffer.contentRevision,
      format: 'heading2',
      selection: { from: 0, to: 1 }
    })
    expect(heading.buffer.draft).toContain('## **Opening**')

    const inserted = await md('insert', {
      bufferId: buffer.id,
      expectedRevision: heading.buffer.contentRevision,
      format: 'table'
    })
    expect(inserted.buffer.draft).toMatch(/\|.*\|\n\|\s*[-:]+/)
    const mermaid = await md('insert', {
      bufferId: buffer.id,
      expectedRevision: inserted.buffer.contentRevision,
      format: 'mermaid'
    })
    expect(mermaid.buffer.draft).toContain('```mermaid')
    const math = await md('insert', {
      bufferId: buffer.id,
      expectedRevision: mermaid.buffer.contentRevision,
      format: 'blockMath'
    })
    expect(math.buffer.draft).toContain('$$')
    const emoji = await md('insert', {
      bufferId: buffer.id,
      expectedRevision: math.buffer.contentRevision,
      format: 'emoji',
      text: '🙂'
    })
    expect(emoji.buffer.draft).toContain('🙂')
    let latest = emoji.buffer
    const formatAt = async (format: string, from: number) => {
      const result = await md('format', {
        bufferId: buffer.id,
        expectedRevision: latest.contentRevision,
        format,
        selection: { from, to: from }
      })
      latest = result.buffer
      return latest
    }
    const firstTableData = (text: string) => {
      const start = text.indexOf('| Column 1')
      const firstNewline = text.indexOf('\n', start)
      const secondNewline = text.indexOf('\n', firstNewline + 1)
      return secondNewline + 1
    }
    let tableText = String(latest.draft)
    let dataRow = firstTableData(tableText)
    await formatAt('tableRowBelow', dataRow + 2)
    tableText = String(latest.draft)
    dataRow = firstTableData(tableText)
    await formatAt('tableRowAbove', dataRow + 2)
    tableText = String(latest.draft)
    let tableStart = tableText.indexOf('| Column 1')
    await formatAt('tableColumnLeft', tableStart + 2)
    tableText = String(latest.draft)
    tableStart = tableText.indexOf('|')
    await formatAt('tableColumnRight', tableStart + 2)
    tableText = String(latest.draft)
    tableStart = tableText.indexOf('|')
    await formatAt('tableColumnDelete', tableStart + 2)
    tableText = String(latest.draft)
    dataRow = firstTableData(tableText)
    await formatAt('tableRowDelete', dataRow + 2)
    tableText = String(latest.draft)
    tableStart = tableText.indexOf('| Column 1')
    await formatAt('tableDelete', tableStart + 2)
    expect(latest.draft).not.toContain('| Column 1')

    const insert = async (format: string, fields: Record<string, unknown> = {}) => {
      const result = await md('insert', {
        bufferId: buffer.id,
        expectedRevision: latest.contentRevision,
        format,
        ...fields
      })
      latest = result.buffer
      return String(latest.draft ?? latest.content)
    }
    expect(await insert('body')).toContain('Text')
    expect(await insert('heading1')).toContain('# Heading 1')
    expect(await insert('heading2')).toContain('## Heading 2')
    expect(await insert('heading3')).toContain('### Heading 3')
    expect(await insert('heading4')).toContain('#### Heading 4')
    expect(await insert('heading5')).toContain('##### Heading 5')
    expect(await insert('italic')).toContain('*text*')
    expect(await insert('strike')).toContain('~~text~~')
    expect(await insert('inlineCode')).toContain('`code`')
    expect(await insert('bulletList', { text: 'bullet' })).toContain('- bullet')
    expect(await insert('orderedList', { text: 'numbered' })).toContain('1. numbered')
    expect(await insert('taskList', { text: 'task' })).toContain('- [ ] task')
    expect(await insert('quote', { text: 'quoted' })).toContain('> quoted')
    expect(await insert('link', { target: 'https://example.test/a_(b)', text: 'safe link' })).toContain('safe link')
    expect(await insert('image', { target: 'images/pixel.png', text: 'pixel' })).toContain('![pixel]')
    expect(await insert('documentLink', { target: 'docs/Target', text: 'target' })).toContain('[[docs/Target|target]]')
    const code = await insert('codeBlock', { language: 'typescript', text: 'const answer = 42' })
    expect(code).toContain('```typescript')
    let codeStart = String(latest.draft).indexOf('const answer = 42')
    const language = await md('format', {
      bufferId: buffer.id,
      expectedRevision: latest.contentRevision,
      format: 'codeLanguage',
      language: 'python',
      selection: { from: codeStart, to: codeStart + 1 }
    })
    latest = language.buffer
    expect(latest.draft).toContain('```python')
    codeStart = String(latest.draft).indexOf('const answer = 42')
    const indented = await md('format', {
      bufferId: buffer.id,
      expectedRevision: latest.contentRevision,
      format: 'indentCode',
      selection: { from: codeStart, to: codeStart + 'const answer = 42'.length }
    })
    latest = indented.buffer
    expect(latest.draft).toContain('  const answer = 42')
    codeStart = String(latest.draft).indexOf('const answer = 42')
    const outdented = await md('format', {
      bufferId: buffer.id,
      expectedRevision: latest.contentRevision,
      format: 'outdentCode',
      selection: { from: codeStart - 2, to: codeStart + 'const answer = 42'.length }
    })
    latest = outdented.buffer
    codeStart = String(latest.draft).indexOf('const answer = 42')
    const copiedCode = await md('format', {
      bufferId: buffer.id,
      expectedRevision: latest.contentRevision,
      format: 'copyCode',
      selection: { from: codeStart, to: codeStart + 4 }
    })
    expect(copiedCode.text).toContain('const answer = 42')
    expect(await insert('divider')).toContain('---')
    expect(await insert('details', { text: 'Summary' })).toContain('<details>')
    expect(await insert('collapsibleHeading', { text: 'Fold me' })).toContain('<summary>Fold me</summary>')


    const docs = await md('documents', { bufferId: buffer.id, query: 'tar' })
    expect(docs.documents.map((item: { relativePath: string }) => item.relativePath)).toContain('docs/Target.md')
    expect(docs.documents.length).toBeLessThanOrEqual(20)
    const unique = await md('links', { bufferId: buffer.id, target: 'docs/Target' })
    expect(unique).toMatchObject({ safe: true, resolved: 'docs/Target.md', ambiguous: false })
    const ambiguous = await md('links', { bufferId: buffer.id, target: 'Duplicate' })
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.resolved).toBeNull()

    const image = await md('importImage', { bufferId: buffer.id, expectedRevision: latest.contentRevision, path: 'images/pixel.png' })
    expect(image.relativePath).toContain('pixel')
    expect(image.relativePath).not.toBe('pixel.png')
    expect(existsSync(join(f.root, image.relativePath))).toBe(true)
    expect(readFileSync(join(f.root, 'pixel.png'), 'utf8')).toBe('user file remains untouched')
    expect(image.buffer.draft).toContain('![](')
    await expect(md('importImage', { bufferId: buffer.id, expectedRevision: image.buffer.contentRevision, path: 'images/oversized.png' })).rejects.toThrow()
    expect((await open('guide.md')).draft).toBe(image.buffer.draft)
    expect(await md('capabilities', { bufferId: buffer.id })).toMatchObject({ richEligible: true })
  })

  test('SC-14: TOC, front matter, find/replace, templates, named-file safety and real PDF export work without changing disk Markdown', async () => {
    const f = current()
    const source = [
      '---',
      'title: {{title}}',
      '---',
      '',
      '# Repeated heading',
      '',
      'Needle at first location.',
      '',
      '## Repeated heading',
      '',
      'Needle at second location.',
      '',
      'Inline math: $x^2$.'
    ].join('\n')
    put('toc.md', source)
    const buffer = await open('toc.md')

    const toc = await md('toc', { bufferId: buffer.id })
    expect(toc.headings.map((heading: { id: string }) => heading.id)).toEqual(['repeated-heading', 'repeated-heading-1'])
    expect(toc.headings.map((heading: { line: number }) => heading.line)).toEqual([5, 9])
    const frontMatter = await md('frontmatter', { bufferId: buffer.id, visible: true })
    expect(frontMatter).toMatchObject({ visible: true, startLine: 1, endLine: 3, text: '---\ntitle: {{title}}\n---\n' })
    put('preview.md', 'Signal at first location.\n\nSignal at second location.\n')
    const previewView = await open('preview.md', 'preview')
    const previewFound = await md('search', { bufferId: previewView.id, query: 'Signal', matchCase: true, wholeWord: true })
    expect(previewFound.total).toBe(2)
    const previewReplace = await md('replace', {
      bufferId: previewView.id,
      expectedRevision: previewView.contentRevision,
      query: 'Signal',
      text: 'Phrase',
      matchCase: true,
      wholeWord: true,
      all: true
    })
    expect(previewReplace.replacements).toBe(2)
    expect(previewReplace.buffer.draft).toContain('Phrase at second location.')

    put('frontmatter-edit.md', '---\ntitle: Old\n---\n\nbody\n')
    const sourceBuffer = await open('frontmatter-edit.md', 'source')
    const sourceContent = sourceBuffer.draft ?? sourceBuffer.content
    const sourceDraft = await f.call(EDITOR_DRAFT, {
      bufferId: sourceBuffer.id,
      content: sourceContent.replace('title: Old', 'title: New'),
      expectedRevision: sourceBuffer.contentRevision
    })
    expect(sourceDraft.draft).toContain('title: New')
    await f.call(EDITOR_SAVE, { bufferId: sourceBuffer.id })
    expect(readFileSync(join(f.root, 'frontmatter-edit.md'), 'utf8')).toContain('title: New')


    const found = await md('search', { bufferId: buffer.id, query: 'needle', matchCase: false, wholeWord: true })
    expect(found.total).toBe(2)
    expect(found.matches.map((match: { line: number }) => match.line)).toEqual([7, 11])
    const replaced = await md('replace', {
      bufferId: buffer.id,
      expectedRevision: buffer.contentRevision,
      query: 'Needle',
      text: 'Signal',
      matchCase: false,
      wholeWord: true,
      all: true
    })
    expect(replaced.replacements).toBe(2)
    expect(replaced.buffer.draft).toContain('Signal at first location.')
    expect(replaced.buffer.draft).toContain('Signal at second location.')
    expect(replaced.buffer.draft).toContain('title: {{title}}')

    put('.orca/templates/review.md', '# {{title}}\n\nFile: {{filename}}\nDate: {{date}}\nTime: {{time}}\nUnknown: {{not-known}}\n')
    const templates = await md('templates', { worktree: f.worktree })
    expect(templates.templates.map((template: { relativePath: string }) => template.relativePath)).toContain('.orca/templates/review.md')
    await expect(md('new', { worktree: f.worktree, template: '../../outside.md', title: 'Blocked' })).rejects.toThrow()
    await expect(md('new', { worktree: f.worktree, template: '.orca/templates/missing.md', title: 'Blocked' })).rejects.toThrow()
    expect(existsSync(join(f.root, 'untitled.md'))).toBe(false)


    put('untitled.md', 'occupied\n')
    const created = await md('new', { worktree: f.worktree, template: '.orca/templates/review.md', title: 'Release Plan' })
    const createdContent = created.buffer.draft ?? created.buffer.content
    expect(createdContent).toContain('# Release Plan')
    expect(createdContent).toContain(`File: ${created.buffer.name}`)
    expect(createdContent).toContain('Unknown: {{not-known}}')
    expect(createdContent).toMatch(/Date: \d{4}-\d{2}-\d{2}/)

    const createdPath = join(f.root, created.buffer.relativePath)
    await expect(md('retarget', { bufferId: created.buffer.id, path: 'docs/release-plan.md' })).rejects.toThrow()
    expect(readFileSync(createdPath, 'utf8')).toBe(createdContent)
    expect(existsSync(join(f.root, 'docs/release-plan.md'))).toBe(false)

    const blank = await md('new', { worktree: f.worktree })
    const blankPath = join(f.root, blank.buffer.relativePath)
    expect(blankPath).not.toBe(createdPath)
    expect(blankPath).not.toBe(join(f.root, 'untitled.md'))
    const blankContent = readFileSync(blankPath, 'utf8')
    await f.call('quirky.editor/close', { bufferId: blank.buffer.id, choice: 'discard' })
    expect(readFileSync(blankPath, 'utf8')).toBe(blankContent)
    expect(readFileSync(join(f.root, 'untitled.md'), 'utf8')).toBe('occupied\n')
    mkdirSync(join(f.root, 'exports'), { recursive: true })
    const diskBeforeExport = readFileSync(join(f.root, 'toc.md'), 'utf8')
    const pdf = await md('exportPdf', { bufferId: buffer.id, path: 'exports/toc.pdf' })
    const bytes = readFileSync(join(f.root, 'exports/toc.pdf'))
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1')).toMatch(/%%EOF\s*$/)
    expect(pdf.path).toBe(join(f.root, 'exports/toc.pdf'))
    expect(readFileSync(join(f.root, 'toc.md'), 'utf8')).toBe(diskBeforeExport)
  })

  test('SC-15: notes track front-matter-aware selections, escape and sort the prompt, and survive failed delivery', async () => {
    const source = '---\ntitle: Notes\n---\n\nalpha\nselected text\nomega\n'
    put('notes.md', source)
    const buffer = await open('notes.md')
    const bodyStart = source.indexOf('alpha')
    const selectedStart = source.indexOf('selected text') - bodyStart
    const first = await notes('add', {
      bufferId: buffer.id,
      selection: { from: selectedStart, to: selectedStart + 'selected text'.length, mode: 'rich' },
      text: 'quote "line"\\tail\nnext'
    })
    expect(first.note).toMatchObject({ selectedText: 'selected text', startLine: 6, lineNumber: 6, source: 'markdown' })

    const secondStart = source.indexOf('alpha') - bodyStart
    const second = await notes('add', {
      bufferId: buffer.id,
      selection: { from: secondStart, to: secondStart + 'alpha'.length, mode: 'rich' },
      text: 'earlier note'
    })
    const listed = await notes('list', { bufferId: buffer.id })
    expect(listed.count).toBe(2)
    expect(listed.notes.map((note: { startLine: number }) => note.startLine)).toEqual([5, 6])

    const copied = await notes('copy', { bufferId: buffer.id })
    expect(copied.text.indexOf('User comment: "earlier note"')).toBeLessThan(copied.text.indexOf('User comment: "quote \\"line\\"\\\\tail\\nnext"'))
    expect(copied.text).toContain('Excerpt:\n> selected text')

    const edited = await notes('edit', { bufferId: buffer.id, noteId: second.note.id, text: 'edited note' })
    expect(edited.note.body).toBe('edited note')
    await expect(notes('edit', { bufferId: buffer.id, noteId: 'missing-note', text: 'not found' })).rejects.toThrow()
    await expect(notes('add', {
      bufferId: buffer.id,
      selection: { from: selectedStart, to: selectedStart + 'selected text'.length, mode: 'rich' },
      text: 'x'.repeat(16 * 1024 + 1)
    })).rejects.toThrow()
    const failedExisting = await notes('send', {
      bufferId: buffer.id,
      target: 'existing',
      sessionId: 'missing-session',
      agent: 'claude'
    })
    expect(failedExisting.delivery).toBe('not-delivered')
    expect(failedExisting.deletedNoteIds).toEqual([])
    expect(failedExisting.retainedNoteIds).toContain(first.note.id)
    expect((await notes('list', { bufferId: buffer.id })).count).toBe(2)

    const failedLaunch = await notes('send', { bufferId: buffer.id, target: 'new', agent: 'missing-agent' })
    expect(failedLaunch.delivery).toBe('not-delivered')
    expect(failedLaunch.deletedNoteIds).toEqual([])
    expect((await notes('list', { bufferId: buffer.id })).count).toBe(2)

    await expect(notes('add', {
      bufferId: buffer.id,
      selection: { from: 0, to: source.length + 1, mode: 'source' },
      text: 'invalid selection'
    })).rejects.toThrow()
    put('too-large-preview.md', 'word '.repeat(Math.ceil((8 * 1024 * 1024 + 1) / 5)))
    const tooLarge = await open('too-large-preview.md', 'preview')
    await expect(notes('add', { bufferId: tooLarge.id, selection: { from: 0, to: 1, mode: 'source' }, text: 'blocked' })).rejects.toThrow()
    put('readonly.md', 'Read only')
    chmodSync(join(current().root, 'readonly.md'), 0o444)
    const readonly = await open('readonly.md')
    await expect(notes('add', { bufferId: readonly.id, selection: { from: 0, to: 4, mode: 'source' }, text: 'blocked' })).rejects.toThrow()

    await notes('delete', { bufferId: buffer.id, noteId: first.note.id })
    expect((await notes('list', { bufferId: buffer.id })).count).toBe(1)
    expect(second.note.id).not.toBe(first.note.id)
  })
})
