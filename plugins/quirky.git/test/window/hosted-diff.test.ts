import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import type { World } from './world'

// The headless window must register DOM globals before loading its window module.

registerDom()
const { boot, shutdown, DIFF_VIEW } = await import('./world')
const { modifiedEditor, q, rowOf, text } = await import('./dom')
const { EditorView } = await import('@codemirror/view')
const { scratch } = isolateGitConfig()

afterAll(() => GlobalRegistrator.unregister())
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

test('Source Control preview replaces only a clean hosted tab, promotes on double click or pin, and splits with Option-click', async () => {
  const world = await boot(scratch, { published: false })
  world.write('math.ts', 'changed math\n')
  world.write('README.md', 'changed readme\n')
  world.write('a.ts', 'changed a\n')
  await world.win.waitFor(() => rowOf('math.ts') && rowOf('README.md') && rowOf('a.ts'))

  clickRow('math.ts')
  const first = await world.win.waitFor(async () => {
    const tabs = diffTabs(await terminalWorkspace(world))
    return tabs.find(({ tab }) => record(tab.input).path === 'math.ts') ?? null
  })
  expect(first.tab.preview).toBe(true)
  const previewId = first.tab.id

  clickRow('README.md')
  const replaced = await world.win.waitFor(async () => {
    const tabs = diffTabs(await terminalWorkspace(world))
    return tabs.find(({ tab }) => tab.id === previewId && record(tab.input).path === 'README.md') ?? null
  })
  expect(replaced.tab.preview).toBe(true)
  expect(diffTabs(await terminalWorkspace(world))).toHaveLength(1)

  clickRow('README.md', 2)
  const promoted = await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === previewId)
    return current?.tab.preview === false ? current : null
  })
  expect(promoted.tab.id).toBe(previewId)

  clickRow('a.ts', 1, { altKey: true })
  const split = await world.win.waitFor(async () => {
    const workspace = await terminalWorkspace(world)
    const tabs = diffTabs(workspace)
    return tabs.find(({ tab }) => record(tab.input).path === 'a.ts') ?? null
  })
  const splitWorkspace = await terminalWorkspace(world)
  expect(groups(splitWorkspace.root)).toHaveLength(2)
  expect(record(split.tab.input)).toMatchObject({ worktree: world.feat.id, path: 'a.ts', split: true, groupId: split.group.id })
  expect(split.tab.preview).toBe(false)

  await world.win.waitFor(async () => (await world.viewReport())?.placement === 'split')
  expect(await world.viewReport()).toMatchObject({
    worktree: world.feat.id,
    tabId: split.tab.id,
    groupId: split.group.id,
    mode: 'file',
    path: 'a.ts',
    placement: 'split',
    display: 'source'
  })

  await world.agent.callAny('quirky.terminal/pinTab', { tab: previewId, pinned: true })
  await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === previewId)
    return current?.tab.pinned === true && current.tab.preview === false
  })
})

test('dirty hosted diffs refuse close and are never replaced by another preview', async () => {
  const world = await boot(scratch, { published: false })
  world.write('math.ts', 'changed math\n')
  world.write('README.md', 'changed readme\n')
  await world.win.waitFor(() => rowOf('math.ts') && rowOf('README.md'))
  clickRow('math.ts')
  const opened = await world.win.waitFor(async () => {
    const tabs = diffTabs(await terminalWorkspace(world))
    return tabs.find(({ tab }) => record(tab.input).path === 'math.ts') ?? null
  })
  await world.win.waitFor(() => q('.qgv-file .cm-editor'))
  const editor = modifiedEditor(EditorView, q('.qgv-file')!)
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
  await world.win.waitFor(async () => diffTabs(await terminalWorkspace(world)).some(({ tab }) =>
    tab.id === opened.tab.id && record(tab.input).path === 'math.ts'
  ))
})

test('Markdown preview renders only the modified side, states image limits, and switches source in the same tab', async () => {
  const world = await boot(scratch, { published: false })
  world.write('README.md', '# Draft heading\\n\\nModified body.\\n')
  await world.win.waitFor(() => rowOf('README.md'))
  await world.run('open-diff', { path: 'README.md', source: 'unstaged', display: 'preview', preview: true })
  await world.win.waitFor(() => q('.qgv-markdown-preview'))
  const preview = q('.qgv-markdown-preview')!
  expect(text(preview)).toContain('Draft heading')
  expect(text(preview)).toContain('Modified body.')
  expect(text(preview)).not.toContain('one')
  expect(text(q('.qgv-markdown-preview-notice'))).toContain('Local images are omitted')

  const before = await world.win.waitFor(async () => diffTabs(await terminalWorkspace(world))[0] ?? null)
  const sourceButton = q('button[aria-label="Show Source"]')!
  sourceButton.click()
  await world.win.waitFor(async () => {
    const current = diffTabs(await terminalWorkspace(world)).find(({ tab }) => tab.id === before.tab.id)
    return current !== undefined && record(current.tab.input).display === 'source'
  })
  expect(diffTabs(await terminalWorkspace(world))).toHaveLength(1)
})
