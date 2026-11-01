import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Page } from 'playwright'
import { Dialog, FormRow } from '../src/design-system'

const executable = chromium.executablePath()
const ROOT = resolve(import.meta.dir, '../../..')
const ACCOUNT_MODULES = join(ROOT, 'plugins/quirky.accounts/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(ACCOUNT_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(ACCOUNT_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(ACCOUNT_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(ACCOUNT_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(ACCOUNT_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}

function browserEntry(app: string): string {
  return `
    import { createRoot } from 'react-dom/client'
    import { StrictMode, useEffect, useRef, useState } from 'react'
    import { Dialog, Popover } from '@quirky/ui'
    ${app}
    createRoot(document.getElementById('dialog-mount')!).render(<App />)
  `
}

function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'dialog-focus-browser-dependencies',
      setup(builder) {
        builder.onResolve(
          { filter: new RegExp('^(?:react|react/jsx-runtime|react/jsx-dev-runtime|react-dom|react-dom/client|@quirky/ui)$') },
          ({ path }) => ({ path: BROWSER_IMPORTS[path] })
        )
      }
    }
    const result = await Bun.build({
      entrypoints: [${JSON.stringify(entrypoint)}],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"development"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\\\\n'))
    await Bun.write(${JSON.stringify(outputPath)}, result.outputs[0]!)
  `
}

function buildDialogClient(app: string): string {
  const tempDir = mkdtempSync(join(import.meta.dir, '.dialog-focus-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.tsx')
    writeFileSync(entrypoint, browserEntry(app))
    const outputPath = join(tempDir, 'browser-bundle.js')
    const buildScript = join(tempDir, 'build-browser-entry.ts')
    writeFileSync(buildScript, browserBuildScript(entrypoint, outputPath))
    const build = Bun.spawnSync([process.execPath, buildScript], { cwd: ROOT })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString() || build.stdout.toString())
    return readFileSync(outputPath, 'utf8')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function mountDialogApp(page: Page, app: string): Promise<void> {
  const clientScript = buildDialogClient(app)
  await page.setContent('<main id="dialog-mount"></main>')
  await page.addScriptTag({ content: clientScript })
}

test.skipIf(!existsSync(executable))('Tab enters a newly opened portaled popover instead of the next header control', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    await mountDialogApp(page, `
      function App() {
        const anchor = useRef(null)
        const [open, setOpen] = useState(false)
        return (
          <>
            <button ref={anchor} onClick={() => setOpen((value) => !value)}>Worktrees options</button>
            <button>Minimize Worktrees</button>
            <Popover open={open} label="Worktrees options" anchor={anchor} onClose={() => setOpen(false)}>
              <details>
                <summary>Workspace options</summary>
                <button>Group by</button>
              </details>
            </Popover>
          </>
        )
      }
    `)
    const opener = page.getByRole('button', { name: 'Worktrees options', exact: true })
    await opener.click()
    await page.getByRole('dialog', { name: 'Worktrees options' }).waitFor()
    await page.keyboard.press('Tab')
    expect(await page.locator('summary').evaluate((element) => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    expect(await page.getByRole('button', { name: 'Group by' }).evaluate((element) => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    expect(await opener.evaluate((element) => document.activeElement === element)).toBe(true)
    await opener.click()
    await page.getByRole('dialog').waitFor()
    await page.keyboard.press('Tab')
    expect(await page.locator('summary').evaluate((element) => document.activeElement === element)).toBe(true)
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('autofocused dialog restores its exact opener after Escape and close-button dismissal, including reopen', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    await mountDialogApp(page, `
      function App() {
        const [open, setOpen] = useState(false)
        useEffect(() => {
          document.body.dataset.dialogOpen = String(open)
        }, [open])
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
            <button type="button" onClick={() => setOpen(true)}>Reopen dialog</button>
            <Dialog open={open} title="Focus test" onClose={() => setOpen(false)}>
              <input autoFocus aria-label="Autofocused field" />
            </Dialog>
          </>
        )
      }
    `)

    const opener = page.getByRole('button', { name: 'Open dialog', exact: true })
    const field = page.getByRole('textbox', { name: 'Autofocused field' })
    await opener.waitFor()
    await opener.click()
    await page.waitForFunction(() => document.body.dataset.dialogOpen === 'true')
    await field.waitFor()
    const focusedOnFirstOpen = await field.evaluate((element) => element.ownerDocument.activeElement === element)

    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.body.dataset.dialogOpen === 'false')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    const restoredAfterEscape = await opener.evaluate((element) => element.ownerDocument.activeElement === element)

    const nextOpener = page.getByRole('button', { name: 'Reopen dialog' })
    await nextOpener.click()
    await page.waitForFunction(() => document.body.dataset.dialogOpen === 'true')
    await field.waitFor()
    const focusedOnReopen = await field.evaluate((element) => element.ownerDocument.activeElement === element)
    await page.getByRole('button', { name: 'Close dialog' }).click()
    await page.waitForFunction(() => document.body.dataset.dialogOpen === 'false')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    const restoredAfterCloseButton = await nextOpener.evaluate((element) => element.ownerDocument.activeElement === element)

    expect({
      focusedOnFirstOpen,
      restoredAfterEscape,
      focusedOnReopen,
      restoredAfterCloseButton
    }).toEqual({
      focusedOnFirstOpen: true,
      restoredAfterEscape: true,
      focusedOnReopen: true,
      restoredAfterCloseButton: true
    })
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('StrictMode effect replay keeps an autofocused dialog field focused and restores its opener on Escape', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    await mountDialogApp(page, `
      function App() {
        const [open, setOpen] = useState(false)
        useEffect(() => {
          document.body.dataset.dialogOpen = String(open)
        }, [open])
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>Open strict dialog</button>
            {open && (
              <StrictMode>
                <Dialog open title="Strict focus test" onClose={() => setOpen(false)}>
                  <input autoFocus aria-label="Strict autofocus field" />
                </Dialog>
              </StrictMode>
            )}
          </>
        )
      }
    `)

    const opener = page.getByRole('button', { name: 'Open strict dialog' })
    const field = page.getByRole('textbox', { name: 'Strict autofocus field' })
    await opener.waitFor()
    await opener.click()
    await page.waitForFunction(() => document.body.dataset.dialogOpen === 'true')
    await field.waitFor()
    const focusedAfterReplay = await field.evaluate((element) => element.ownerDocument.activeElement === element)
    expect(focusedAfterReplay).toBe(true)
    await page.keyboard.type('StrictMode typing')
    const valueAfterReplay = await field.inputValue()

    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.body.dataset.dialogOpen === 'false')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    const restoredToOpener = await opener.evaluate((element) => element.ownerDocument.activeElement === element)

    expect(valueAfterReplay).toBe('StrictMode typing')
    expect(restoredToOpener).toBe(true)
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('nested autofocused dialog restores its inner opener before the parent restores its external opener', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    await mountDialogApp(page, `
      function App() {
        const [parentOpen, setParentOpen] = useState(false)
        const [nestedOpen, setNestedOpen] = useState(false)
        useEffect(() => {
          document.body.dataset.parentOpen = String(parentOpen)
        }, [parentOpen])
        useEffect(() => {
          document.body.dataset.nestedOpen = String(nestedOpen)
        }, [nestedOpen])
        return (
          <>
            <button type="button" onClick={() => setParentOpen(true)}>Open parent dialog</button>
            <Dialog open={parentOpen} title="Parent dialog" onClose={() => setParentOpen(false)}>
              <button type="button" onClick={() => setNestedOpen(true)}>Open nested dialog</button>
              <Dialog open={nestedOpen} title="Nested dialog" onClose={() => setNestedOpen(false)}>
                <input autoFocus aria-label="Nested autofocus field" />
              </Dialog>
            </Dialog>
          </>
        )
      }
    `)

    const externalOpener = page.getByRole('button', { name: 'Open parent dialog' })
    await externalOpener.waitFor()
    await externalOpener.click()
    await page.waitForFunction(() => document.body.dataset.parentOpen === 'true')

    const nestedOpener = page.getByRole('button', { name: 'Open nested dialog' })
    await nestedOpener.click()
    await page.waitForFunction(() => document.body.dataset.nestedOpen === 'true')
    const nestedField = page.getByRole('textbox', { name: 'Nested autofocus field' })
    await nestedField.waitFor()
    const nestedFieldFocused = await nestedField.evaluate((element) => element.ownerDocument.activeElement === element)
    const nestedDialog = page.getByRole('dialog').nth(1)
    await nestedDialog.waitFor()

    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.body.dataset.nestedOpen === 'false')
    await nestedDialog.waitFor({ state: 'detached' })
    const restoredToNestedOpener = await nestedOpener.evaluate((element) => element.ownerDocument.activeElement === element)

    await page.getByRole('button', { name: 'Close dialog' }).click()
    await page.waitForFunction(() => document.body.dataset.parentOpen === 'false')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    const restoredToExternalOpener = await externalOpener.evaluate((element) => element.ownerDocument.activeElement === element)

    expect({
      nestedFieldFocused,
      restoredToNestedOpener,
      restoredToExternalOpener
    }).toEqual({
      nestedFieldFocused: true,
      restoredToNestedOpener: true,
      restoredToExternalOpener: true
    })
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('scrolling dialog keeps checkbox focus outlines inside its scrollport in both themes', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    const tokens = await Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text()
    const components = await Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text()
    const markup = renderToStaticMarkup(
      <Dialog open title="Settings" scrollBody actions={<button>Save</button>}>
        <form className="ui-stack">
          <h3>Appearance</h3>
          <FormRow label="Sidebar section separators" htmlFor="separators" help="Show divider lines between projects and groups.">
            <input id="separators" type="checkbox" defaultChecked />
          </FormRow>
          <div style={{ height: 1000 }} />
        </form>
      </Dialog>,
    )
    for (const theme of ['dark', 'light']) {
      for (const width of [800, 360]) {
        await page.setViewportSize({ width, height: 600 })
        await page.setContent(`<style>${tokens}\n${components}</style><main data-theme="${theme}">${markup}</main>`)
        await page.keyboard.press('Tab')
        const checkbox = page.getByRole('checkbox', { name: 'Sidebar section separators' })
        await checkbox.focus()
        for (const checked of [true, false]) {
          expect(await checkbox.isChecked()).toBe(checked)
          const ring = await checkbox.evaluate((element) => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const body = element.closest<HTMLElement>('.ui-dialog__body')!
            const clip = body.getBoundingClientRect()
            const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
            return {
              focused: element.matches(':focus-visible'),
              style: style.outlineStyle,
              width: parseFloat(style.outlineWidth),
              scrolls: body.scrollHeight > body.clientHeight,
              clearance: [
                rect.left - extent - clip.left - body.clientLeft,
                rect.top - extent - clip.top - body.clientTop,
                clip.left + body.clientLeft + body.clientWidth - rect.right - extent,
                clip.top + body.clientTop + body.clientHeight - rect.bottom - extent,
              ],
            }
          })
          expect(ring.focused).toBe(true)
          expect(ring.style).toBe('solid')
          expect(ring.width).toBeGreaterThan(0)
          expect(ring.scrolls).toBe(true)
          for (const clearance of ring.clearance) expect(clearance).toBeGreaterThanOrEqual(-0.5)
          if (checked) await checkbox.press('Space')
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)
