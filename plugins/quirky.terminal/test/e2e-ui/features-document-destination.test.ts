import { afterEach, expect, test } from 'bun:test'
import { FEATURE_MS, groupsOf, layoutOf, openTab, runCommand, startFeatures, stopAll, terminal, typeInto, until, waitFor } from './features-support'
import { isViewTab } from '../../src/layout/types'

afterEach(stopAll)

test('New Markdown from a non-active split opens the real editor document in that exact destination group', async () => {
  const f = await startFeatures()
  const original = await layoutOf(f.h)
  const first = groupsOf(original)[0]!
  const other = await openTab(f.h, ['--title', 'Destination'])
  const split = await terminal(f.h, 'tab', 'move', other.tab.id, '--split', 'right')
  const destination = split.workspace.activeGroup
  await terminal(f.h, 'tab', 'activate', first.tabs[0]!.id)
  expect((await layoutOf(f.h)).activeGroup).toBe(first.id)

  await runCommand(f, 'new-markdown', { group: destination })
  const title = await until(f, () => document.querySelector<HTMLInputElement>('input[aria-label="Document title"]'))
  await typeInto(title, 'Exact destination note')
  const blank = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'Blank Markdown (untitled.md)')
  if (!blank) throw new Error('Markdown creation picker is missing its Blank Markdown action')
  blank.click()

  const result = await waitFor('the new document selected in its requested group', async () => {
    const workspace = await layoutOf(f.h)
    const group = groupsOf(workspace).find((candidate) => candidate.id === destination)
    const documentTab = group?.tabs.find((tab) => isViewTab(tab) && tab.viewId === 'view:quirky.editor/document')
    return documentTab && isViewTab(documentTab) && workspace.activeGroup === destination && group?.activeTab === documentTab.id
      ? { workspace, group, documentTab }
      : undefined
  })
  expect(result.workspace.activeGroup).toBe(destination)
  expect(result.group.activeTab).toBe(result.documentTab.id)
  expect(result.documentTab.input?.mode).toBe('rich')
  expect(groupsOf(result.workspace).find((group) => group.id === first.id)?.tabs.map((tab) => tab.id)).toEqual(first.tabs.map((tab) => tab.id))
}, FEATURE_MS)
