import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from 'playwright'
import type { UiModel } from '@quirky/protocol'
import { PRIMARY_PROJECT, type RegisteredCaptureFixtures } from './fixtures'
import { CLONE_ATTRIBUTE, OPEN_POPUP_SELECTOR, cloneOpenPopupExpression, removeClonesExpression, separateClonesExpression } from './popups'

/** What the scenes need from the capture run; `CaptureRuntime` satisfies it. */
export type SceneRuntime = {
  client: { callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> }
  page: Page
  model: UiModel
  fixtures: RegisteredCaptureFixtures
  options: { timeoutMs: number; signal?: AbortSignal }
  scene: SceneState
}

/** What earlier cells left behind that a later cell must not repeat or must clean up. */
export type SceneState = { tabsOpenedFor: string | null; terminalTabId: string | null; terminalSession: string | null; toastAskId: string | null }

export const newSceneState = (): SceneState => ({ tabsOpenedFor: null, terminalTabId: null, terminalSession: null, toastAskId: null })

export const SELECTED_WORKTREE = 'ui-review-ready'
const TOAST_WORKTREE = 'ui-review-notes'
const SHELL_TOOL_TITLES = ['Worktrees', 'Tasks', 'Changes', 'Ledger'] as const
const FOCUSED_TOOL_TITLE = 'Worktrees'
/** Lets panels that load after the tools open (Changes, Ledger, Tasks) fill in before the screenshot. */
const SETTLE_MS = 3_000
const PROJECT_SWITCHER = 0
const WORKTREE_SWITCHER = 1

const SEEDED_FILES: readonly (readonly [string, string])[] = [
  ['src/ToolShell.tsx', 'export const toolShell = 1\n'],
  ['src/tool-shell.css', '.tool-shell { display: grid; }\n'],
  ['src/project-tile.ts', 'export const tile = 1\n'],
  ['package.json', '{ "name": "ui-review-fixture" }\n'],
  ['old-notes.md', '# Notes\n']
]
const SEEDED_LEDGER_TITLES = ['Ran the UI tests', 'Asked to approve a merge', 'typecheck failed in design-window', 'Finished and opened a review']

const TERMINAL_OUTPUT = [
  '\\033[32m$ bun test packages/ui\\033[0m',
  '\\033[90mbun test v1.3 · 32 files · 214 tests\\033[0m',
  '',
  '\\033[32m✓ shell/tool-shell.test.tsx (42 tests)\\033[0m',
  '\\033[32m✓ shell/chrome.test.tsx (18 tests)\\033[0m',
  '\\033[32m✓ design-system/panels.test.tsx (27 tests)\\033[0m',
  'running design-system/menu.test.tsx …'
].map((line) => `${line}\\n`).join('')
const TERMINAL_INPUT = `clear; printf '${TERMINAL_OUTPUT}'\r`

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function call(runtime: SceneRuntime, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (runtime.options.signal?.aborted) throw runtime.options.signal.reason instanceof Error ? runtime.options.signal.reason : new Error('capture was aborted')
  return await runtime.client.callAny(method, params, { timeoutMs: runtime.options.timeoutMs })
}

function worktreeNamed(runtime: SceneRuntime, name: string) {
  const worktree = runtime.fixtures.worktrees.find((candidate) => candidate.name === name && candidate.repoId === runtime.fixtures.repo.id)
  if (!worktree) throw new Error(`fixture worktree ${name} is unavailable`)
  return worktree
}

function toolIdNamed(runtime: SceneRuntime, title: string): string {
  const tool = runtime.model.tools?.find((candidate) => candidate.title === title)
  if (!tool) throw new Error(`the ${title} tool is not registered`)
  return tool.id
}

async function openCenterTabs(runtime: SceneRuntime, worktreeId: string, cwd: string): Promise<string> {
  const workspace = worktreeId
  await call(runtime, 'quirky.terminal/newTab', { workspace, cwd, agent: 'claude', title: 'Claude', activate: false })
  await call(runtime, 'quirky.terminal/newTab', { workspace, cwd, agent: 'codex', title: 'Codex', activate: false })
  const shell = record(await call(runtime, 'quirky.terminal/newTab', { workspace, cwd, agent: 'shell', title: 'zsh', activate: false }))
  if (typeof shell.tab !== 'string' || typeof shell.session !== 'string') throw new Error('quirky.terminal/newTab did not return a tab and session')
  runtime.scene.terminalSession = shell.session
  await call(runtime, 'quirky.editor/open', { worktree: worktreeId, path: 'src/app.ts', mode: 'source', focus: false, pinned: true })
  await call(runtime, 'quirky.browser/paneOpen', { worktree: worktreeId, url: 'http://localhost:5173', mode: 'native' })
  return shell.tab
}

/**
 * Makes `tab` the active tab and confirms it stays so: the browser pane claims the active tab again
 * when it finishes mounting, so one call right after opening it can lose.
 */
async function activateTerminalTab(runtime: SceneRuntime, worktreeId: string, tab: string): Promise<void> {
  const deadline = Date.now() + 10_000
  let stable = 0
  while (stable < 3) {
    await call(runtime, 'quirky.terminal/activateTab', { workspace: worktreeId, tab })
    const workspace = record(record(await call(runtime, 'quirky.terminal/workspace', { workspace: worktreeId })).workspace)
    stable = record(workspace.root).activeTab === tab ? stable + 1 : 0
    if (Date.now() > deadline) throw new Error('the zsh tab did not stay the active tab')
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

/**
 * Brings the window to the populated shell the goldens show: a worktree selected with its center
 * tabs open, the four default tools open, and the Worktrees panel focused. Every step goes through
 * the same methods and clicks a person's session would; only the project and worktree data is made up.
 */
/** Gives the selected worktree uncommitted files and the project ledger entries, so Changes and Ledger show rows as the golden does. */
async function seedRows(runtime: SceneRuntime, worktree: { id: string; path: string; repoId: string }): Promise<void> {
  for (const [path, text] of SEEDED_FILES) {
    const target = join(worktree.path, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  for (const title of SEEDED_LEDGER_TITLES) {
    await call(runtime, 'quirky.ledger/file', {
      target: { workspaceId: worktree.id },
      type: 'bug',
      content: {
        title,
        file: { path: 'src/app.ts', base: { kind: 'project', id: worktree.repoId } },
        description: 'Made-up review fixture.',
        severity: 'medium'
      }
    })
  }
}

export async function populateShell(runtime: SceneRuntime): Promise<void> {
  const worktree = worktreeNamed(runtime, SELECTED_WORKTREE)
  await call(runtime, 'quirky.worktree/setOptions', { filterRepoIds: [] })
  await call(runtime, 'quirky.worktree/navigate', { worktree: `id:${worktree.id}` })
  const firstVisit = runtime.scene.tabsOpenedFor !== worktree.id
  if (firstVisit) {
    await seedRows(runtime, worktree)
    runtime.scene.terminalTabId = await openCenterTabs(runtime, worktree.id, worktree.path)
    runtime.scene.tabsOpenedFor = worktree.id
  }
  await activateTerminalTab(runtime, worktree.id, runtime.scene.terminalTabId!)
  for (const title of SHELL_TOOL_TITLES) await call(runtime, 'ui.tool.open', { id: toolIdNamed(runtime, title) })
  const panel = runtime.page.locator(`[data-tool-panel=${JSON.stringify(toolIdNamed(runtime, FOCUSED_TOOL_TITLE))}]`)
  await panel.waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
  await panel.locator('.ui-tool-panel-frame__title').click({ timeout: runtime.options.timeoutMs })
  await runtime.page.locator('[data-tool-panel][data-panel-focused]').waitFor({ state: 'attached', timeout: runtime.options.timeoutMs })
  await runtime.page.locator('.xterm canvas').first().waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
  if (firstVisit) await call(runtime, 'quirky.terminal/write', { session: runtime.scene.terminalSession!, data: TERMINAL_INPUT })
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

async function openSwitcher(runtime: SceneRuntime, index: number): Promise<void> {
  const switchers = runtime.page.locator('.window-bar__switcher')
  if (await switchers.count() !== 2) throw new Error('the window bar does not show both switchers')
  await switchers.nth(index).click({ timeout: runtime.options.timeoutMs })
}

/** Narrows the Worktrees panel to the primary fixture project by choosing it in the real project switcher. */
export async function scopeToProject(runtime: SceneRuntime): Promise<void> {
  await openSwitcher(runtime, PROJECT_SWITCHER)
  await runtime.page.getByRole('menuitem', { name: new RegExp(PRIMARY_PROJECT) }).click({ timeout: runtime.options.timeoutMs })
  await runtime.page.locator('.window-bar__switcher').nth(PROJECT_SWITCHER).getByText(PRIMARY_PROJECT, { exact: true })
    .waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
  await runtime.page.locator(OPEN_POPUP_SELECTOR).waitFor({ state: 'detached', timeout: runtime.options.timeoutMs })
}

async function copyAndClosePopup(runtime: SceneRuntime): Promise<void> {
  const { page } = runtime
  const popup = page.locator(OPEN_POPUP_SELECTOR)
  await popup.waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
  await page.waitForFunction((selector) => {
    const node = document.querySelector(selector)
    return node !== null && getComputedStyle(node).visibility !== 'hidden' && node.getBoundingClientRect().height > 0
  }, OPEN_POPUP_SELECTOR, { timeout: runtime.options.timeoutMs })
  if (await page.evaluate(cloneOpenPopupExpression()) !== true) throw new Error('no popup was open to copy')
  await page.evaluate(separateClonesExpression())
  await page.keyboard.press('Escape')
  await popup.waitFor({ state: 'detached', timeout: runtime.options.timeoutMs })
}

/**
 * Opens the project switcher, the worktree switcher and the Checks status value one after another
 * through real clicks, leaving an inert copy of each popup on the page after the app closes it. The
 * app allows one open popup at a time, so the copies are the only way one picture shows them together.
 * The Checks value exists only when a hosted review has check data, which an offline fixture lacks.
 */
export async function showPopupsTogether(runtime: SceneRuntime): Promise<void> {
  await openSwitcher(runtime, PROJECT_SWITCHER)
  await copyAndClosePopup(runtime)
  await openSwitcher(runtime, WORKTREE_SWITCHER)
  await copyAndClosePopup(runtime)
  const checks = runtime.page.locator('[data-region="status-bar"] button[aria-label$="checks passing"]')
  if (await checks.count() > 0) {
    await checks.first().click({ timeout: runtime.options.timeoutMs })
    await copyAndClosePopup(runtime)
  }
  const copies = await runtime.page.locator(`[${CLONE_ATTRIBUTE}]`).count()
  if (copies < 2) throw new Error(`expected at least two popup copies, found ${copies}`)
}

/** Raises the needs-you toast the way an agent would: a pending question for a worktree other than the selected one. */
export async function raiseNeedsYouToast(runtime: SceneRuntime): Promise<void> {
  const worktree = worktreeNamed(runtime, TOAST_WORKTREE)
  const created = record(await call(runtime, 'quirky.ask/create', {
    worktree: worktree.id,
    spec: {
      title: `${worktree.name} needs you`,
      questions: [{
        id: 'merge',
        type: 'select',
        question: 'Approve merge into build/roadmap?',
        options: [{ value: 'approve', label: 'Approve' }, { value: 'decline', label: 'Decline' }]
      }]
    }
  }))
  if (typeof created.askId !== 'string') throw new Error('quirky.ask/create did not return an ID')
  runtime.scene.toastAskId = created.askId
  await runtime.page.locator('.shell-attention-toasts').waitFor({ state: 'visible', timeout: runtime.options.timeoutMs })
}

/** Removes what a scene added outside the app's own state: popup copies and the toast's question. */
export async function clearScene(runtime: SceneRuntime): Promise<void> {
  await runtime.page.evaluate(removeClonesExpression())
  const askId = runtime.scene.toastAskId
  if (askId === null) return
  runtime.scene.toastAskId = null
  await call(runtime, 'quirky.ask/cancel', { askId })
}
