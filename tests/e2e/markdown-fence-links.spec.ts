import { test, expect } from './helpers/quirky-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture
} from './helpers/markdown-editor-fixture'

test('source links stay outside mixed code fences', async ({ quirkyPage }, testInfo) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  const context = await getActiveWorktreeContext(quirkyPage)
  const file = await createMarkdownFixture(
    context,
    'markdown-fences',
    'links',
    testInfo.workerIndex,
    '# Fence boundaries\n\n~~~text\n```\n[[inside-code]]\n~~~\n\n[[outside-code]]\n'
  )
  try {
    await openMarkdownFixture(quirkyPage, context, file)
    await quirkyPage.evaluate(() => {
      const state = window.__store!.getState()
      if (!state.activeFileId) {
        throw new Error('missing active file')
      }
      state.setMarkdownViewMode(state.activeFileId, 'source')
    })
    const links = quirkyPage.locator('.monaco-editor .view-line').filter({
      has: quirkyPage.locator('.monaco-markdown-doc-link')
    })
    await expect(links).toHaveCount(1)
    await expect(links).toHaveText('[[outside-code]]')
    await testInfo.attach('fence-links', {
      body: await quirkyPage.screenshot({ path: testInfo.outputPath('fence-links.png') }),
      contentType: 'image/png'
    })
  } finally {
    await cleanupMarkdownFixture(file)
  }
})
