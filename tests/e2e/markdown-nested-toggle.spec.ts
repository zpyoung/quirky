import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/quirky-app'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import {
  expectEditableNestedToggles,
  expectFileKeepsNesting,
  expectPassthroughFallback,
  expectSentinelInsideNestedToggle,
  NESTED_TOGGLE_FIXTURE_DIRECTORY,
  NESTED_TOGGLE_MARKDOWN,
  placeCaretInNestedToggleBody,
  UNSUPPORTED_NESTED_TOGGLE_MARKDOWN
} from './helpers/markdown-nested-toggle'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.describe('Markdown nested toggle regression', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
    await waitForActiveWorktree(quirkyPage)
  })

  test('a plain details block opens as an editable toggle', async ({ quirkyPage }, testInfo) => {
    const context = await getActiveWorktreeContext(quirkyPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'plain-details',
        testInfo.workerIndex,
        '<details>\n<summary>Toggle</summary>\n\nBody\n\n</details>\n'
      )
      await openMarkdownFixture(quirkyPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(quirkyPage)
      const toggle = editor.locator('[data-type="details"]')

      await expect(toggle).toHaveCount(1)
      await expect(toggle.locator('summary')).toHaveText('Toggle')
      await expect(editor.locator('[data-raw-markdown-html-block]')).toHaveCount(0)
      const screenshotPath = testInfo.outputPath('plain-details-rich-editor.png')
      await quirkyPage.screenshot({ path: screenshotPath })
      await testInfo.attach('plain-details-rich-editor', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('a nested toggle on disk reopens as editable toggles', async ({ quirkyPage }, testInfo) => {
    const context = await getActiveWorktreeContext(quirkyPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'nested-toggle-reopen',
        testInfo.workerIndex,
        NESTED_TOGGLE_MARKDOWN
      )
      await openMarkdownFixture(quirkyPage, context, filePath)
      await waitForRichMarkdownEditor(quirkyPage)

      await expectEditableNestedToggles(quirkyPage)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('editing a nested toggle survives save and reopen', async ({ quirkyPage }, testInfo) => {
    const context = await getActiveWorktreeContext(quirkyPage)
    const sentinel = `editedInsideNestedToggle${Date.now()}`
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'nested-toggle-edit',
        testInfo.workerIndex,
        NESTED_TOGGLE_MARKDOWN
      )
      await openMarkdownFixture(quirkyPage, context, filePath)
      await waitForRichMarkdownEditor(quirkyPage)
      await expectEditableNestedToggles(quirkyPage)

      await placeCaretInNestedToggleBody(quirkyPage)
      await quirkyPage.keyboard.type(` ${sentinel}`)
      await expectSentinelInsideNestedToggle(quirkyPage, sentinel)

      // Save through the real shortcut and assert the bytes that landed on disk.
      await quirkyPage.keyboard.press('ControlOrMeta+S')
      const savedPath = filePath
      await expect
        .poll(() => readFileSync(savedPath, 'utf8'), { timeout: 10_000 })
        .toContain(sentinel)
      expectFileKeepsNesting(readFileSync(savedPath, 'utf8'), sentinel)

      // The reported bug only appeared on reopen, so close the tab and parse
      // the saved file again from scratch.
      await closeActiveEditorTab(quirkyPage, savedPath)
      await openMarkdownFixture(quirkyPage, context, savedPath)
      await waitForRichMarkdownEditor(quirkyPage)
      await expectEditableNestedToggles(quirkyPage)
      await expectSentinelInsideNestedToggle(quirkyPage, sentinel)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('a nested toggle that cannot be represented stays raw passthrough', async ({
    quirkyPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(quirkyPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'nested-toggle-unsupported',
        testInfo.workerIndex,
        UNSUPPORTED_NESTED_TOGGLE_MARKDOWN
      )
      await openMarkdownFixture(quirkyPage, context, filePath)
      await waitForRichMarkdownEditor(quirkyPage)

      await expectPassthroughFallback(quirkyPage)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
