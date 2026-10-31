import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import type { AccountUiSnapshot } from '../../../plugins/quirky.accounts/src/window/model'

const executable = chromium.executablePath()
const ROOT = resolve(import.meta.dir, '../../..')
const ACCOUNT_MODULES = join(ROOT, 'plugins/quirky.accounts/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(ACCOUNT_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(ACCOUNT_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(ACCOUNT_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(ACCOUNT_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(ACCOUNT_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}

const snapshot: AccountUiSnapshot = {
  scope: { kind: 'local', worktreeId: null },
  accounts: {
    accounts: [],
    active: { claude: null, codex: null },
    systemDefault: {
      claude: { label: 'System default', email: null, hasAuth: false, authKind: 'none' },
      codex: { label: 'System default', email: null, hasAuth: false, authKind: 'none' }
    },
    pendingLogin: null,
    staleSessions: [],
    configWarnings: [],
    preferences: {
      mode: 'compact',
      direction: 'used',
      hidden: false,
      visibleProviders: [],
      density: 'normal',
      claudeSwitchPolicy: 'ask',
      skipCodexResetConfirm: false
    },
    revision: 0
  },
  usage: null,
  ui: { open: false, provider: null, expanded: null, settingsSection: null },
  credentials: [],
  login: null,
  loginStarting: false,
  loginCancelling: false,
  agentDetection: { status: 'ready', installedProviders: [] },
  loading: false,
  refreshing: false,
  error: null
}
function browserEntry(): string {
  const usageModule = join(ROOT, 'plugins/quirky.accounts/src/window/Usage.tsx')
  const modelModule = join(ROOT, 'plugins/quirky.accounts/src/window/model.ts')
  return `
    import { createRoot } from 'react-dom/client'
    import { StatusBarUsage } from ${JSON.stringify(usageModule)}
    import type { AccountsUiStore } from ${JSON.stringify(modelModule)}
    const snapshot = ${JSON.stringify(snapshot)}
    const store = { getSnapshot: () => snapshot, subscribe: () => () => {} } as unknown as AccountsUiStore
    createRoot(document.getElementById('usage-mount')!).render(<StatusBarUsage store={store} />)
  `
}

function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'usage-focus-browser-dependencies',
      setup(builder) {
        builder.onResolve(
          { filter: new RegExp('^(?:react|react/jsx-runtime|react/jsx-dev-runtime|react-dom|react-dom/client|@quirky/ui|@quirky/protocol)$') },
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


test.skipIf(!existsSync(executable))('Usage focus outline stays inside the compact status bar in both themes', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const [tokens, components, accounts, chrome] = await Promise.all([
      Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/accounts.css', import.meta.url)).text(),
      Bun.file(new URL('../src/shell/chrome.css', import.meta.url)).text()
    ])
    const tempDir = mkdtempSync(join(import.meta.dir, '.usage-focus-'))
    let clientScript: string
    try {
      const entrypoint = join(tempDir, 'browser-entry.tsx')
      writeFileSync(entrypoint, browserEntry())
      const outputPath = join(tempDir, 'browser-bundle.js')
      const buildScript = join(tempDir, 'build-browser-entry.ts')
      writeFileSync(buildScript, browserBuildScript(entrypoint, outputPath))
      const build = Bun.spawnSync([process.execPath, buildScript], { cwd: ROOT })
      if (build.exitCode !== 0) throw new Error(build.stderr.toString() || build.stdout.toString())
      clientScript = readFileSync(outputPath, 'utf8')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }

    for (const theme of ['dark', 'light']) {
      await page.setContent(`<style>${tokens}\n${components}\n${accounts}\n${chrome}\nhtml, body { height: 100%; margin: 0; overflow: hidden; }</style>
        <div data-theme="${theme}" style="display:flex;flex-direction:column;height:100vh;overflow:hidden">
          <div style="flex:1 1 auto;min-height:0"></div>
          <footer class="shell-statusbar" data-region="status-bar" aria-label="Status bar">
            <div class="shell-statusbar__start"></div>
            <div class="shell-statusbar__values" aria-label="Workspace status"><div id="usage-mount" class="accounts-mount-root accounts-mount-root--bar"></div></div>
          </footer>
        </div>`)
      await page.addScriptTag({ content: clientScript })
      const trigger = page.getByRole('button', { name: 'Open Usage' })
      await trigger.waitFor()
      await page.keyboard.press('Tab')
      const ring = await trigger.evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const row = element.closest('.shell-statusbar')!.getBoundingClientRect()
        const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
        const clearance = (bounds: DOMRect) => [
          rect.left - extent - bounds.left,
          rect.top - extent - bounds.top,
          bounds.right - rect.right - extent,
          bounds.bottom - rect.bottom - extent
        ]
        return {
          focused: element.matches(':focus-visible'),
          style: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
          rowClearance: clearance(row),
          viewportClearance: [
            rect.left - extent,
            rect.top - extent,
            window.innerWidth - rect.right - extent,
            window.innerHeight - rect.bottom - extent
          ]
        }
      })

      expect(ring.focused).toBe(true)
      expect(ring.style).toBe('solid')
      expect(ring.width).toBeGreaterThan(0)
      for (const clearance of [...ring.rowClearance, ...ring.viewportClearance]) expect(clearance).toBeGreaterThanOrEqual(-0.5)
    }
  } finally {
    await browser.close()
  }
}, 60_000)
