import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { runProcess } from '@quirky/process-host'
import { expect, test } from './helpers/quirky-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// The fixture's hidden renderer is driven and captured through Playwright's CDP connection.
test('CLI file positioning preserves background navigation and reveals the requested line', async ({
  electronApp,
  quirkyPage
}, testInfo) => {
  await waitForSessionReady(quirkyPage)
  const worktreeId = await waitForActiveWorktree(quirkyPage)
  const root = await quirkyPage.evaluate(
    (id) =>
      Object.values(window.__store?.getState().worktreesByRepo ?? {})
        .flat()
        .find((worktree) => worktree.id === id)?.path ?? '',
    worktreeId
  )
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const relativePath = 'cli-position-proof.ts'
  const filePath = path.join(root, relativePath)
  writeFileSync(
    filePath,
    Array.from({ length: 400 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n')
  )

  const open = async (flags: string[]): Promise<void> => {
    const result = await runProcess({
      program: process.execPath,
      args: [
        path.join(process.cwd(), 'out', 'cli', 'index.js'),
        'file',
        'open',
        relativePath,
        '--worktree',
        `id:${worktreeId}`,
        '--json',
        ...flags
      ],
      env: { ...process.env, QUIRKY_USER_DATA_PATH: userDataDir },
      timeoutMs: 30_000
    })
    expect(result.code, result.stderr).toBe(0)
  }
  const cursor = () =>
    quirkyPage.evaluate(() => {
      const probe = window.__monacoEditorE2E
      const snapshot = probe?.snapshot()
      return {
        line: snapshot?.selection?.positionLineNumber,
        column: snapshot?.selection?.positionColumn,
        visible: snapshot?.visibleRanges
      }
    })
  const proofDir = path.join(process.cwd(), 'validation-screenshots', 'file-position')
  mkdirSync(proofDir, { recursive: true })
  try {
    await open(['--focus'])
    await expect(quirkyPage.locator('.editor-header-path').first()).toContainText(relativePath)
    await expect.poll(async () => (await cursor()).line).toBe(1)
    await testInfo.attach('before-default-file-open.png', {
      body: await quirkyPage.screenshot({ path: path.join(proofDir, 'before.png') }),
      contentType: 'image/png'
    })
    await open(['--line', '300', '--column', '7'])
    await quirkyPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    expect(await cursor()).toMatchObject({ line: 1, column: 1 })
    await open([])
    await quirkyPage.evaluate((id) => {
      const state = window.__store?.getState()
      const tab = state?.getActiveTab(id)
      if (!state || !tab) {
        throw new Error('No active editor tab')
      }
      state.createTab(id)
      state.activateTab(tab.id)
    }, worktreeId)
    await quirkyPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    expect(
      await quirkyPage.evaluate(() => window.__store?.getState().pendingEditorReveal)
    ).toBeNull()
    expect(await cursor()).toMatchObject({ line: 1, column: 1 })
    await open(['--line', '300', '--column', '7', '--focus'])
    await expect
      .poll(async () => {
        const position = await cursor()
        return { line: position.line, column: position.column }
      })
      .toEqual({ line: 300, column: 7 })
    await expect
      .poll(async () =>
        (await cursor()).visible?.some(
          (range) => range.startLineNumber <= 300 && range.endLineNumber >= 300
        )
      )
      .toBe(true)
    await testInfo.attach('after-line-300-column-7.png', {
      body: await quirkyPage.screenshot({ path: path.join(proofDir, 'after.png') }),
      contentType: 'image/png'
    })
    await open(['--line', '1', '--focus'])
    await expect.poll(async () => (await cursor()).line).toBe(1)
    const split = await quirkyPage.evaluate((id) => {
      const state = window.__store?.getState()
      const tab = state?.getActiveTab(id)
      if (!state || !tab) {
        throw new Error('No active editor tab')
      }
      const siblingGroupId = state.createEmptySplitGroup(id, tab.groupId, 'right')
      if (!siblingGroupId) {
        throw new Error('Split group was not created')
      }
      return { tabId: tab.id, groupId: tab.groupId, siblingGroupId }
    }, worktreeId)
    await quirkyPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect.poll(async () => (await cursor()).line).toBe(1)
    const targetProbe = await quirkyPage.evaluateHandle(() => window.__monacoEditorE2E)
    await quirkyPage.evaluate(
      ({ id, split }) => {
        const state = window.__store?.getState()
        const tab = state?.unifiedTabsByWorktree[id]?.find((item) => item.id === split.tabId)
        if (!state || !tab) {
          throw new Error('Editor tab missing')
        }
        state.createUnifiedTab(id, tab.contentType, {
          entityId: tab.entityId,
          label: tab.label,
          targetGroupId: split.siblingGroupId
        })
        state.focusGroup(id, split.groupId)
      },
      { id: worktreeId, split }
    )
    await expect(quirkyPage.locator('.monaco-editor:visible')).toHaveCount(2)
    const siblingProbe = await quirkyPage.evaluateHandle(() => window.__monacoEditorE2E)
    expect(await targetProbe.evaluate((target, sibling) => target === sibling, siblingProbe)).toBe(
      false
    )
    await expect
      .poll(() => siblingProbe.evaluate((probe) => probe?.snapshot().selection?.positionLineNumber))
      .toBe(1)
    await quirkyPage
      .locator('.monaco-editor:visible')
      .first()
      .getByRole('textbox', { name: 'Editor content' })
      .focus()
    await expect
      .poll(() =>
        quirkyPage.evaluate(
          (id) => window.__store?.getState().activeGroupIdByWorktree[id],
          worktreeId
        )
      )
      .toBe(split.groupId)
    await open(['--line', '300', '--column', '7', '--focus'])
    await expect
      .poll(() =>
        targetProbe.evaluate((probe) => {
          const selection = probe?.snapshot().selection
          return { line: selection?.positionLineNumber, column: selection?.positionColumn }
        })
      )
      .toEqual({ line: 300, column: 7 })
    expect(
      await siblingProbe.evaluate((probe) => {
        const selection = probe?.snapshot().selection
        return { line: selection?.positionLineNumber, column: selection?.positionColumn }
      })
    ).toEqual({ line: 1, column: 1 })
    expect(
      await quirkyPage.evaluate(
        (id) => window.__store?.getState().activeGroupIdByWorktree[id],
        worktreeId
      )
    ).toBe(split.groupId)
    await expect
      .poll(() =>
        targetProbe.evaluate((probe) =>
          probe
            ?.snapshot()
            .visibleRanges.some(
              (range) => range.startLineNumber <= 300 && range.endLineNumber >= 300
            )
        )
      )
      .toBe(true)
    await testInfo.attach('same-file-split-target-only.png', {
      body: await quirkyPage.screenshot({ path: path.join(proofDir, 'split.png') }),
      contentType: 'image/png'
    })
    await targetProbe.dispose()
    await siblingProbe.dispose()
  } finally {
    rmSync(filePath, { force: true })
  }
})
