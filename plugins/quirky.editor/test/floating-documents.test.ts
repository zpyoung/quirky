import { expect, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { registerIsolatedEditorFixtures } from './isolated-environment'

let active: Harness | null = null
registerIsolatedEditorFixtures(async () => { await active?.cleanup(); active = null })

test('floating Markdown is confined to its explicit owner root and exact destination group', async () => {
  const home = makeHomeWithoutAutoHooks('floating-documents-')
  active = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  const client = await active.connect('cli')
  const call = <T>(method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>
  const root = await call<{ id: string; path: string }>('quirky.editor/documentRoot', { worktree: 'floating' })
  expect(root.id).toBe('floating')
  expect(root.path.startsWith(`${realpathSync(home)}/`)).toBe(true)
  const layout = await call<{ workspace: { activeGroup: string } }>('quirky.terminal/workspace', { workspace: 'floating' })
  const note = await call<{ buffer: { id: string; worktreeId: string; root: string }; path: string }>('quirky.editor/markdown', {
    action: 'new', worktree: 'floating', group: layout.workspace.activeGroup, title: 'Floating note'
  })
  expect(note.buffer.worktreeId).toBe('floating')
  expect(note.buffer.root).toBe(root.path)
  expect(readFileSync(join(root.path, note.path), 'utf8')).toBe('')
  const outside = join(home, 'outside.txt')
  writeFileSync(outside, 'private')
  await expect(call('quirky.editor/open', { worktree: 'floating', path: outside })).rejects.toThrow('outside')
  symlinkSync(outside, join(root.path, 'escape.txt'))
  await expect(call('quirky.editor/open', { worktree: 'id:floating', path: 'escape.txt' })).rejects.toThrow('outside')
  expect(readFileSync(outside, 'utf8')).toBe('private')
  expect(existsSync(join(root.path, note.path))).toBe(true)
  const browser = await call<{ id: string; worktreeId: string; tabId: string }>('quirky.browser/paneOpen', {
    worktree: 'floating', group: layout.workspace.activeGroup, mode: 'native', url: 'about:blank'
  })
  expect(browser.worktreeId).toBe('floating')
  const browserTabs = await call<{ tabs: { id: string }[] }>('quirky.browser/paneState', { worktree: 'floating' })
  expect(browserTabs.tabs.map((tab) => tab.id)).toContain(browser.id)
  await call('quirky.browser/paneClose', { pane: browser.id })
})
