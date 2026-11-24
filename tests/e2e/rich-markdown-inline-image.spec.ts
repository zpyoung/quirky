import { test, expect } from './helpers/quirky-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import {
  collectRichMarkdownPageErrors,
  expectNoRichMarkdownSchemaCrash,
  INLINE_IMAGE_DETAILS_MARKDOWN,
  INLINE_IMAGE_FIXTURE_DIRECTORY,
  INLINE_IMAGE_PARAGRAPH_MARKDOWN,
  writeInlineImageAsset
} from './helpers/markdown-inline-image'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// A markdown image nested in a paragraph or a toggle summary used to parse into a
// schema-invalid document that only threw on the first edit reassembling it.
test.describe('Rich markdown inline image regression', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
    await waitForActiveWorktree(quirkyPage)
  })

  test('an inline image inside a paragraph survives a keystroke', async ({
    quirkyPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(quirkyPage)
    const pageErrors = collectRichMarkdownPageErrors(quirkyPage)
    let filePath: string | null = null

    try {
      writeInlineImageAsset(context.rootPath)
      filePath = await createMarkdownFixture(
        context,
        INLINE_IMAGE_FIXTURE_DIRECTORY,
        'paragraph-inline-image',
        testInfo.workerIndex,
        INLINE_IMAGE_PARAGRAPH_MARKDOWN
      )
      await openMarkdownFixture(quirkyPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(quirkyPage)

      const paragraph = editor.locator('p').filter({ hasText: 'more text' }).first()
      await expect(paragraph).toBeVisible({ timeout: 15_000 })
      await expect(editor.locator('img')).toHaveCount(1, { timeout: 15_000 })

      // Typing at the paragraph start reassembles the whole paragraph, which is
      // the frame the reported RangeError bottomed out in.
      await paragraph.click({ position: { x: 12, y: 8 } })
      await quirkyPage.keyboard.press('Home')
      await quirkyPage.keyboard.type('X')

      await expect(editor.locator('p').filter({ hasText: 'XSome text' })).toHaveCount(1)
      await expect(editor.locator('img')).toHaveCount(1)
      await expectNoRichMarkdownSchemaCrash(quirkyPage, pageErrors)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('an inline image inside a toggle summary survives a keystroke', async ({
    quirkyPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(quirkyPage)
    const pageErrors = collectRichMarkdownPageErrors(quirkyPage)
    let filePath: string | null = null

    try {
      writeInlineImageAsset(context.rootPath)
      filePath = await createMarkdownFixture(
        context,
        INLINE_IMAGE_FIXTURE_DIRECTORY,
        'details-inline-image',
        testInfo.workerIndex,
        INLINE_IMAGE_DETAILS_MARKDOWN
      )
      await openMarkdownFixture(quirkyPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(quirkyPage)

      const summary = editor.locator('summary').first()
      await expect(summary).toBeVisible({ timeout: 15_000 })
      await expect(editor.locator('summary img')).toHaveCount(1, { timeout: 15_000 })

      await summary.click()
      await quirkyPage.keyboard.press('End')
      await quirkyPage.keyboard.type('X')

      await expect(editor.locator('summary').filter({ hasText: 'labelX' })).toHaveCount(1)
      await expect(editor.locator('summary img')).toHaveCount(1)
      await expectNoRichMarkdownSchemaCrash(quirkyPage, pageErrors)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('a formatting command over an inline image keeps the image', async ({
    quirkyPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(quirkyPage)
    const pageErrors = collectRichMarkdownPageErrors(quirkyPage)
    let filePath: string | null = null

    try {
      writeInlineImageAsset(context.rootPath)
      filePath = await createMarkdownFixture(
        context,
        INLINE_IMAGE_FIXTURE_DIRECTORY,
        'paragraph-inline-image-bold',
        testInfo.workerIndex,
        INLINE_IMAGE_PARAGRAPH_MARKDOWN
      )
      await openMarkdownFixture(quirkyPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(quirkyPage)

      const paragraph = editor.locator('p').filter({ hasText: 'more text' }).first()
      await expect(paragraph).toBeVisible({ timeout: 15_000 })
      await expect(editor.locator('img')).toHaveCount(1, { timeout: 15_000 })

      // toggleBold runs tr.addMark across the selection, which reassembles every
      // paragraph it spans — and silently dropped the image before the fix.
      await paragraph.click({ position: { x: 12, y: 8 } })
      await quirkyPage.keyboard.press('ControlOrMeta+a')
      await quirkyPage.getByRole('button', { name: 'Bold', exact: true }).first().click()

      await expect(editor.locator('strong').first()).toBeVisible()
      await expect(editor.locator('img')).toHaveCount(1)
      await expectNoRichMarkdownSchemaCrash(quirkyPage, pageErrors)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
