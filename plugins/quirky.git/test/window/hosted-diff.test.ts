import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { boot, shutdown, DIFF_VIEW, type World } from './world'
import { modifiedEditor, q, rowOf, text } from './dom'

const { scratch } = isolateGitConfig()
const SLOW = 90_000

afterEach(shutdown)

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as RecordValue
}

async function terminalWorkspace(world: World): Promise<RecordValue> {
  const result = record(await world.agent.callAny('quirky.terminal/workspace', { workspace: world.feat.id }))
  return record(result.workspace)
}

function groups(value: unknown): RecordValue[] {
  const node = record(value)
  if (node.kind === 'group') return [node]
  if (node.kind !== 'split') return []
  return [...groups(node.first), ...groups(node.second)]
}

function diffTabs(workspace: RecordValue): Array<{ tab: RecordValue; group: RecordValue }> {
  return groups(workspace.root).flatMap((group) =>
    (Array.isArray(group.tabs) ? group.tabs : [])
      .filter((value): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value))
      .filter((tab) => tab.viewId === DIFF_VIEW)
      .map((tab) => ({ tab, group }))
  )
}


function clickRow(path: string, detail = 1, init: MouseEventInit = {}): void {
  const target = rowOf(path)
  if (!target) throw new Error(`missing Source Control row ${path}`)
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail, ...init }))
}

function imageSource(html: string): string {
  const match = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(html)
  if (!match) throw new Error('Markdown preview did not contain an image resource.')
  return match[1]!
}

function imageUrl(world: World, source: string): string {
  return new URL(source, `http://127.0.0.1:${world.harness.runtime.port}`).toString()
}

async function expectImageResource(world: World, source: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(imageUrl(world, source))
  expect(response.status).toBe(200)
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes])
}

async function expectImageResourceUnavailable(world: World, source: string): Promise<void> {
  const response = await fetch(imageUrl(world, source))
  expect([404, 410]).toContain(response.status)
}

test('Source Control file diffs are distinguishable from an open editor tab', async () => {
  const world = await boot(scratch, { published: false })
  world.write('README.md', 'changed readme\n')
  await world.agent.callAny('quirky.editor/open', {
    worktree: `id:${world.feat.id}`,
    path: 'README.md',
    mode: 'source'
  })
  await world.win.waitFor(() => rowOf('README.md') && [...document.querySelectorAll('.qt-tab-title')].some((element) => element.textContent === 'README.md'))

  clickRow('README.md')
  const opened = await world.win.waitFor(async () => diffTabs(await terminalWorkspace(world)).find(({ tab }) =>
    record(tab.input).path === 'README.md' && record(tab.input).tabId === tab.id
  ))
  await world.win.waitFor(() => q(`[data-tab="${String(opened.tab.id)}"] .qt-tab-title`))
  const titles = [...document.querySelectorAll('.qt-tab-title')].map((element) => element.textContent)
  expect(titles.filter((title) => title === 'README.md')).toHaveLength(1)
  expect(titles.some((title) => title?.includes('README.md') && /\bdiff\b/i.test(title))).toBe(true)
}, SLOW)

test('Source Control preview replaces only a clean hosted tab, promotes on double click or pin, and splits with Option-click', async () => {
  const world = await boot(scratch, { published: false })
  world.write('math.ts', 'changed math\n')
  world.write('README.md', 'changed readme\n')
  world.write('a.ts', 'changed a\n')
  await world.win.waitFor(() => rowOf('math.ts') && rowOf('README.md') && rowOf('a.ts'))

  clickRow('math.ts')
  const first = await world.win.waitFor(async () => {
    const tabs = diffTabs(await terminalWorkspace(world))
    return tabs.find(({ tab }) => record(tab.input).path === 'math.ts' && record(tab.input).tabId === tab.id) ?? null
  })
  expect(first.tab.preview).toBe(true)
  const previewId = first.tab.id

  clickRow('README.md')
  const replaced = await world.win.waitFor(async () => {
    const tabs = diffTabs(await terminalWorkspace(world))
    return tabs.find(({ tab }) => tab.id === previewId && record(tab.input).path === 'README.md' && record(tab.input).tabId === tab.id) ?? null
  })
  expect(replaced.tab.preview).toBe(true)
  expect(diffTabs(await terminalWorkspace(world))).toHaveLength(1)

  clickRow('README.md', 2)
  const promoted = await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === previewId)
    return current?.tab.preview === false && record(current.tab.input).tabId === current.tab.id && record(current.tab.input).preview === false ? current : null
  })
  expect(promoted.tab.id).toBe(previewId)

  clickRow('a.ts', 1, { altKey: true })
  const split = await world.win.waitFor(async () => {
    const workspace = await terminalWorkspace(world)
    const tabs = diffTabs(workspace)
    return groups(workspace.root).length === 2
      ? tabs.find(({ tab, group }) => record(tab.input).path === 'a.ts' && record(tab.input).split === true && record(tab.input).groupId === group.id) ?? null
      : null
  })
  const splitWorkspace = await terminalWorkspace(world)
  expect(groups(splitWorkspace.root)).toHaveLength(2)
  expect(record(split.tab.input)).toMatchObject({ worktree: world.feat.id, path: 'a.ts', split: true, groupId: split.group.id })
  expect(split.tab.preview).toBe(false)


  await world.agent.callAny('quirky.terminal/pinTab', { tab: previewId, pinned: true })
  await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === previewId)
    return current?.tab.pinned === true && current.tab.preview === false
  })
}, SLOW)

test('dirty hosted diffs refuse close and are never replaced by another preview', async () => {
  const world = await boot(scratch, { published: false })
  world.write('math.ts', 'changed math\n')
  world.write('README.md', 'changed readme\n')
  await world.win.waitFor(() => rowOf('math.ts') && rowOf('README.md'))
  clickRow('math.ts')
  const opened = await world.win.waitFor(async () => {
    const tabs = diffTabs(await terminalWorkspace(world))
    return tabs.find(({ tab }) => record(tab.input).path === 'math.ts' && record(tab.input).tabId === tab.id) ?? null
  })
  await world.win.waitFor(() => q('[data-git-view-root] [contenteditable]'))
  const editor = modifiedEditor(EditorView, q('[data-diff-editor]')!)
  editor.dispatch({ changes: { from: 0, insert: 'unsaved draft ' } })
  await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === opened.tab.id)
    return current !== undefined && typeof current.tab.closeParams === 'object' &&
      current.tab.closeParams !== null && record(current.tab.closeParams).dirty === true
  })

  const closeFailure = await world.agent.callAny('quirky.terminal/closeTab', { tab: opened.tab.id, yes: true }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  expect(closeFailure).toContain('refused to close')
  clickRow('README.md')
  await world.win.waitFor(async () => diffTabs(await terminalWorkspace(world)).some(({ tab }) => record(tab.input).path === 'README.md'))
  const remaining = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === opened.tab.id)
  expect(record(remaining?.tab.input).path).toBe('math.ts')
  expect(record(remaining?.tab.closeParams).dirty).toBe(true)
}, SLOW)

test('Markdown diff previews the modified side with an authorized image and releases only its hosted lease', async () => {
  const world = await boot(scratch, { published: false })
  const imageBytes = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cS6sAAAAASUVORK5CYII=',
    'base64'
  ))
  const markdownPath = 'docs/Guide.md'
  const imagePath = 'docs/images/chart.png'
  const committedText = '# Committed heading\n\nHEAD body.\n\n![Chart](images/chart.png)\n'
  const modifiedText = '# Draft heading\n\nModified body.\n\n![Chart](images/chart.png)\n'
  world.write(markdownPath, committedText)
  mkdirSync(join(world.dir, 'docs', 'images'), { recursive: true })
  writeFileSync(join(world.dir, imagePath), imageBytes)
  world.git('add', 'docs')
  world.git('commit', '-q', '-m', 'Add Markdown guide and chart')
  world.write(markdownPath, modifiedText)

  const editorStateBefore = record(await world.agent.callAny('quirky.editor/state', { worktree: world.feat.id }))
  const buffersBefore = editorStateBefore.buffers
  if (!Array.isArray(buffersBefore)) throw new Error('Editor state did not include its buffers.')
  const bufferCountBefore = buffersBefore.length
  const tabsBefore = groups((await terminalWorkspace(world)).root).reduce(
    (count, group) => count + (Array.isArray(group.tabs) ? group.tabs.length : 0), 0
  )
  await world.run('open-diff', { path: markdownPath, source: 'unstaged', display: 'preview', preview: true })
  await world.win.waitFor(() => q('[data-git-view-root] [data-markdown-preview] img'))
  const preview = q('[data-git-view-root] [data-markdown-preview]')!
  expect(text(preview)).toContain('Draft heading')
  expect(text(preview)).toContain('Modified body.')
  expect(text(preview)).not.toContain('Committed heading')
  expect(text(preview)).not.toContain('HEAD body.')
  expect(q('[data-git-view-root] [data-markdown-preview-notice]')).not.toBeNull()

  const hostedPreviewSrc = q('[data-git-view-root] [data-markdown-preview] img')?.getAttribute('src')
  expect(hostedPreviewSrc).toBeTruthy()
  await expectImageResource(world, hostedPreviewSrc!, imageBytes)
  expect(readFileSync(join(world.dir, markdownPath), 'utf8')).toBe(modifiedText)
  const editorStateAfter = record(await world.agent.callAny('quirky.editor/state', { worktree: world.feat.id }))
  const buffersAfter = editorStateAfter.buffers
  if (!Array.isArray(buffersAfter)) throw new Error('Editor state did not include its buffers.')
  expect(buffersAfter.length).toBe(bufferCountBefore)
  const tabsAfter = groups((await terminalWorkspace(world)).root).reduce(
    (count, group) => count + (Array.isArray(group.tabs) ? group.tabs.length : 0), 0
  )
  expect(tabsAfter).toBe(tabsBefore + 1)

  const siblingLeaseId = crypto.randomUUID()
  const sibling = record(await world.agent.callAny('quirky.editor/markdownPreview', {
    action: 'render',
    leaseId: siblingLeaseId,
    worktree: `id:${world.feat.id}`,
    path: markdownPath,
    text: modifiedText
  }))
  expect(sibling).toMatchObject({ leaseId: siblingLeaseId, worktreeId: world.feat.id, path: markdownPath })
  const siblingSrc = imageSource(typeof sibling.html === 'string' ? sibling.html : '')
  await expectImageResource(world, siblingSrc, imageBytes)

  const sourceBuffer = record(await world.agent.callAny('quirky.editor/open', {
    worktree: `id:${world.feat.id}`,
    path: markdownPath,
    mode: 'preview',
    focus: false
  }))
  const sourcePreview = record(await world.agent.callAny('quirky.editor/markdown', {
    action: 'capabilities',
    bufferId: sourceBuffer.id,
    includePreview: true
  }))
  const sourceImageUrls = record(sourcePreview.imageUrls)
  const sourceSrc = Object.values(sourceImageUrls).find((value): value is string => typeof value === 'string')
  expect(sourceSrc).toBeTruthy()
  await expectImageResource(world, sourceSrc!, imageBytes)

  const hostedBefore = await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => record(tab.input).path === markdownPath)
    return current ?? null
  })
  const hostedTabId = hostedBefore.tab.id
  q('button[aria-label="Show Source"]')?.click()
  await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === hostedTabId)
    return current !== undefined && record(current.tab.input).display === 'source'
  })
  expect(diffTabs(await terminalWorkspace(world))).toHaveLength(1)
  expect(diffTabs(await terminalWorkspace(world))[0]?.tab.id).toBe(hostedTabId)
  await world.win.waitFor(async () => {
    const response = await fetch(imageUrl(world, hostedPreviewSrc!))
    return response.status === 404 || response.status === 410
  })
  await expectImageResourceUnavailable(world, hostedPreviewSrc!)
  await expectImageResource(world, siblingSrc, imageBytes)
  await expectImageResource(world, sourceSrc!, imageBytes)

  expect(await world.agent.callAny('quirky.editor/markdownPreview', {
    action: 'release',
    leaseId: siblingLeaseId
  })).toMatchObject({ leaseId: siblingLeaseId, released: true })
  await expectImageResourceUnavailable(world, siblingSrc)
  await expectImageResource(world, sourceSrc!, imageBytes)
}, SLOW)
