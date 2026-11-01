import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
declare global {
  interface Window {
    __createCallCount: number
    __resolveRetry: () => void
    __toastLog: { title: string; body: unknown }[]
  }
}

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.worktree/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/rpc.ts'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}
const STYLESHEETS = [
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/icons/icons.css'
]
const LONG_ERROR = 'The remote workspace could not be created because the server returned a detailed diagnostic for the missing backing directory. '.repeat(120)

let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const createDialogModule = join(ROOT, 'plugins/quirky.worktree/src/CreateDialog.tsx')
  return `
    import { createElement as h, useMemo, useRef, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { CreateDialog } from ${JSON.stringify(createDialogModule)}

    const longError = ${JSON.stringify(LONG_ERROR)}
    const noHooks = { file: null, setup: null, archive: null, agentStartup: null, sharedDirectories: [], warnings: [] }
    const repos = [
      { id: 'repo-one', name: 'one', path: '/workspace/one', addedAt: 1, kind: 'git', displayName: null, groupId: null },
      { id: 'repo-two', name: 'two', path: '/workspace/two', addedAt: 2, kind: 'git', displayName: null, groupId: null }
    ]
    window.__createCallCount = 0
    window.__toastLog = []

    function CreateDialogFixture() {
      const [open, setOpen] = useState(true)
      const [repoId, setRepoId] = useState('repo-one')
      const createCalls = useRef(0)
      const context = useMemo(() => ({
        async call(method, params) {
          if (method === 'ui.window.self') return { connId: 1 }
          if (method === 'quirky.repo/show') return { settings: { defaultBase: 'main' } }
          if (method === 'quirky.repo/hooks') return noHooks
          if (method === 'quirky.worktree/availableHosts') return []
          if (method === 'quirky.agents/list') return { agents: [] }
          if (method === 'quirky.worktree/prefetchCreate') return {}
          if (method === 'quirky.worktree/navigate') return {}
          if (method === 'quirky.worktree/create') {
            createCalls.current += 1
            window.__createCallCount = createCalls.current
            if (createCalls.current === 1) throw new Error(longError)
            if (createCalls.current === 2) {
              const retry = Promise.withResolvers()
              window.__resolveRetry = () => retry.resolve({ worktree: { id: 'created', name: 'created', path: '/workspace/created' } })
              return await retry.promise
            }
            throw new Error('A later create attempt failed.')
          }
          return {}
        },
        getLayout: () => ({ view: null }),
        toast(title, body) { window.__toastLog.push({ title, body }) },
        log() {},
        openView() {},
        subscribe() { return () => {} },
        onConnection() { return () => {} }
      }), [])

      return h('div', null,
        !open && h('button', { type: 'button', onClick: () => setOpen(true) }, 'Open workspace dialog'),
        open && h(CreateDialog, {
          context,
          repos,
          worktrees: [],
          repoId,
          onRepoChange: setRepoId,
          onClose: () => setOpen(false),
          onPending: () => () => {},
          hooks: { askTrust: async () => 'cancel', showFallback() {} }
        })
      )
    }

    createRoot(document.getElementById('root')).render(h(CreateDialogFixture))
  `
}

function pageMarkup(): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body, #root { height: 100%; margin: 0; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
        </style>
      </head>
      <body><div id="root"></div></body>
    </html>`
}
function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'worktree-create-dialog-browser-dependencies',
      setup(builder) {
        builder.onResolve(
          { filter: new RegExp('^(?:react|react/jsx-runtime|react/jsx-dev-runtime|react-dom|react-dom/client|@quirky/protocol|@quirky/ui)$') },
          ({ path }) => ({ path: BROWSER_IMPORTS[path] })
        )
      }
    }
    const result = await Bun.build({
      entrypoints: [${JSON.stringify(entrypoint)}],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\\\\n'))
    await Bun.write(${JSON.stringify(outputPath)}, result.outputs[0]!)
  `
}

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-worktree-create-dialog-browser-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    const outputPath = join(tempDir, 'browser-bundle.js')
    const buildScript = join(tempDir, 'build-browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    writeFileSync(buildScript, browserBuildScript(entrypoint, outputPath))
    const build = Bun.spawnSync([process.execPath, buildScript], { cwd: ROOT })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString() || build.stdout.toString())
    browserBundle = readFileSync(outputPath, 'utf8')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)


afterAll(async () => {
  await browser?.close()
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps a long create error readable without blocking dialog actions', async () => {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  const clientErrors: string[] = []
  page.on('pageerror', (error) => clientErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') clientErrors.push(message.text())
  })
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ content: browserBundle })
    try {
      await page.getByRole('dialog', { name: 'New workspace' }).waitFor({ timeout: 10_000 })
    } catch (error) {
      const details = clientErrors.length > 0 ? clientErrors.join('\n') : String(error)
      throw new Error(`CreateDialog browser mount failed: ${details}`)
    }

    await page.getByLabel('Create more').check()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForFunction(() => {
      const alert = document.querySelector<HTMLElement>('[role="alert"]')
      const bounds = alert?.getBoundingClientRect()
      return alert !== null && bounds !== undefined && bounds.width > 0 && bounds.height > 0
    })

    const alert = page.getByRole('alert')
    const errorText = (await alert.textContent()) ?? ''
    expect(errorText).toContain('Could not create worktree')
    expect(errorText).toContain(LONG_ERROR)
    const failedLayout = await page.getByRole('dialog', { name: 'New workspace' }).evaluate((dialog) => {
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect()
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
      }
      const alert = dialog.querySelector('[role="alert"]') as HTMLElement
      const close = dialog.querySelector('.ui-dialog__close') as HTMLButtonElement
      const actions = dialog.querySelector('.ui-actions') as HTMLElement
      const cancel = [...actions.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Cancel')!
      const create = actions.querySelector<HTMLButtonElement>('button[type="submit"]')!
      const hit = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect()
        const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
        return target === element || element.contains(target)
      }
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        dialog: rect(dialog),
        alert: rect(alert),
        alertScrolls: alert.scrollHeight > alert.clientHeight,
        close: rect(close),
        cancel: rect(cancel),
        create: rect(create),
        closeHit: hit(close),
        cancelHit: hit(cancel),
        createHit: hit(create)
      }
    })
    expect(failedLayout.viewportWidth).toBe(1280)
    expect(failedLayout.viewportHeight).toBe(720)
    expect(failedLayout.dialog.top).toBeGreaterThanOrEqual(0)
    expect(failedLayout.dialog.bottom).toBeLessThanOrEqual(failedLayout.viewportHeight)
    expect(failedLayout.alert.height).toBeLessThanOrEqual(128)
    expect(failedLayout.alertScrolls).toBe(true)
    for (const target of [failedLayout.close, failedLayout.cancel, failedLayout.create]) {
      expect(target.top).toBeGreaterThanOrEqual(0)
      expect(target.bottom).toBeLessThanOrEqual(failedLayout.viewportHeight)
    }
    expect(failedLayout.closeHit).toBe(true)
    expect(failedLayout.cancelHit).toBe(true)
    expect(failedLayout.createHit).toBe(true)

    const create = page.getByRole('button', { name: 'Create', exact: true })
    await create.click()
    await page.waitForFunction(() => window.__createCallCount === 2 && typeof window.__resolveRetry === 'function')
    expect(await page.getByRole('alert').count()).toBe(0)
    expect(await create.isDisabled()).toBe(true)
    await page.evaluate(() => window.__resolveRetry())
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]')
      return dialog !== null && document.querySelector('[role="alert"]') === null && submit?.disabled === false
    })
    expect(await page.getByRole('dialog', { name: 'New workspace' }).count()).toBe(1)
    expect(await page.getByRole('alert').count()).toBe(0)

    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes('A later create attempt failed.') === true)
    await page.locator('#create-project').selectOption('repo-two')
    await page.waitForFunction(() => document.querySelector('[role="alert"]') === null)
    expect(await page.evaluate(() => window.__toastLog.some(({ title }) => title === 'Could not create worktree'))).toBe(false)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null)
  } finally {
    await context.close()
  }
}, 60_000)
