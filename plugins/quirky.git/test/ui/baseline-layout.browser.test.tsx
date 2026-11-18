import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { join, resolve } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { browserExecutable } from '../../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../../..')
const UI_MODULES = join(ROOT, 'packages/ui/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(UI_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(UI_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(UI_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(UI_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(UI_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const ACTIONS = [
  { action: 'commitMessage', title: 'Commit message' },
  { action: 'fixCommitFailure', title: 'Commit failure fixes' },
  { action: 'fixPushFailure', title: 'Push failure fixes' },
  { action: 'resolveConflicts', title: 'Conflict resolution' },
  { action: 'branchSummary', title: 'Branch summary' },
  { action: 'pullRequestDetails', title: 'Pull request details' },
  { action: 'pullRequestReview', title: 'Pull request review' },
  { action: 'reviewConversation', title: 'Review conversation' },
  { action: 'branchName', title: 'Branch name' },
  { action: 'conversationName', title: 'Conversation name' }
]
const WORKTREE = '/fixture/feature'
const executable = browserExecutable()

type FixtureCall = { method: string; params: Record<string, unknown> }
type FixtureToast = { title: string; message: string; options: { kind: string } }
type FixtureOptions = {
  settings?: Record<string, unknown>
  failures?: Record<string, string>
}
type BrowserTestWindow = typeof window & {
  __aiSettingsFixture: {
    calls: FixtureCall[]
    toasts: FixtureToast[]
    pending: number
    mounted: boolean
    failures: Record<string, string>
    mount(options?: FixtureOptions): void
    cleanup(): void
    setSetting(name: string, value: unknown): void
    emit(event: { type: string; id?: string; value?: unknown }): void
  }
}

let browser: Browser | undefined
let browserBundle = ''
let browserStyles = ''

function browserEntry(): string {
  const settingsView = join(ROOT, 'plugins/quirky.git/src/ai/AiSettingsView.tsx')
  const productionStyles = [
    join(ROOT, 'packages/ui/src/styles.css'),
    join(ROOT, 'packages/ui/src/shell/chrome.css'),
    join(ROOT, 'packages/ui/src/shell/tool-shell.css')
  ]
  return `
    import ${JSON.stringify(productionStyles[0])}
    import ${JSON.stringify(productionStyles[1])}
    import ${JSON.stringify(productionStyles[2])}
    import { mountAiSettings } from ${JSON.stringify(settingsView)}

    const worktree = ${JSON.stringify(WORKTREE)}
    const effort = {
      id: 'effort', label: 'Effort', type: 'select',
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'max', label: 'Max' }
      ]
    }
    const catalog = {
      supported: true,
      discoverable: true,
      models: [{ id: 'opus', label: 'Opus', options: [effort] }],
      unlisted: 'accept',
      unlistedOptions: [effort],
      extraArgs: { allowed: null }
    }
    const agentList = {
      defaultAgent: 'claude',
      agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, canGenerate: true }]
    }
    const recipe = (action) => ({
      action, agent: null, args: '', template: '{basePrompt}', launchOptions: {},
      sources: { agent: 'default', args: 'default', template: 'default', launchOptions: 'default' }
    })
    const fixture = {
      calls: [], toasts: [], pending: 0, mounted: false,
      listeners: new Set(), cleanupMount: null, settings: {}, failures: {},
      cleanup() {
        if (fixture.cleanupMount) fixture.cleanupMount()
        fixture.cleanupMount = null
        fixture.mounted = false
      },
      mount(options = {}) {
        fixture.cleanup()
        fixture.calls = []
        fixture.toasts = []
        fixture.pending = 0
        fixture.listeners = new Set()
        fixture.failures = options.failures || {}
        fixture.settings = { 'ai-enabled': true, 'ai-custom-command': '', ...(options.settings || {}) }
        const context = {
          async call(method, params = {}) {
            fixture.calls.push({ method, params })
            fixture.pending += 1
            try {
              if (fixture.failures[method]) throw new Error(fixture.failures[method])
              if (method === 'quirky.git/aiRecipe') return recipe(params.action)
              if (method === 'quirky.agents/list') return agentList
              if (method === 'quirky.agents/options') return { ...catalog, agent: params.agent }
              if (method === 'quirky.agents/discoverModels') return { authoritative: true }
              if (method === 'quirky.session/list') return [
                { kind: 'structured', id: 'session-1', title: 'Fixture conversation', worktreeId: worktree }
              ]
              if (method === 'quirky.git/setAiRecipe') return { recipe: recipe(params.action) }
              if (method === 'setting.set') {
                const name = String(params.id).split('/').at(-1)
                fixture.settings[name] = params.value
                return {}
              }
              throw new Error('Unexpected AI settings call: ' + method)
            } finally {
              fixture.pending -= 1
            }
          },
          getSetting(name) { return fixture.settings[name] },
          subscribe(listener) {
            fixture.listeners.add(listener)
            return () => fixture.listeners.delete(listener)
          },
          toast(title, message, options) { fixture.toasts.push({ title, message, options }) },
          openView() {},
          getLayout() { return {} }
        }
        const element = document.getElementById('settings-root')
        if (!element) throw new Error('Missing AI settings fixture root.')
        fixture.cleanupMount = mountAiSettings(context)(element, { input: { worktree } })
        fixture.mounted = true
      },
      setSetting(name, value) { fixture.settings[name] = value },
      emit(event) { for (const listener of fixture.listeners) listener(event) }
    }
    window.__aiSettingsFixture = fixture
  `
}

function browserBuildScript(entrypoint: string, directory: string): string {
  return `
    const imports = ${JSON.stringify(BROWSER_IMPORTS)}
    const result = await Bun.build({
      entrypoints: [${JSON.stringify(entrypoint)}],
      target: 'browser',
      format: 'iife',
      plugins: [{
        name: 'ai-settings-layout-browser-dependencies',
        setup(builder) {
          builder.onResolve({ filter: /^(?:react(?:\\/.*)?|react-dom(?:\\/.*)?|@quirky\\/ui|@quirky\\/protocol)$/ }, ({ path }) => ({
            path: imports[path] ?? path
          }))
        }
      }],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\\n'))
    for (const extension of ['js', 'css']) {
      const output = result.outputs.find((entry) => entry.path.endsWith('.' + extension))
      if (!output) throw new Error('Missing AI settings browser output: ' + extension)
      await Bun.write(${JSON.stringify(directory)} + '/bundle.' + extension, output)
    }
  `
}

async function openPage(theme: 'dark' | 'light', width: number): Promise<{
  context: BrowserContext
  page: Page
  pageErrors: string[]
}> {
  const context = await browser!.newContext({ viewport: { width: 1000, height: 900 } })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setContent(`<!doctype html>
    <html data-theme="${theme}">
      <head><meta charset="utf-8"></head>
      <body><div id="settings-root" style="width:${width}px"></div></body>
    </html>`)
  await page.addStyleTag({ content: browserStyles })
  await page.addScriptTag({ content: browserBundle })
  return { context, page, pageErrors }
}

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-ai-settings-layout-'))
  try {
    const entrypoint = join(directory, 'entry.tsx')
    const buildScript = join(directory, 'build.ts')
    writeFileSync(entrypoint, browserEntry())
    writeFileSync(buildScript, browserBuildScript(entrypoint, directory))
    const build = Bun.spawnSync([process.execPath, buildScript], { cwd: ROOT })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString() || build.stdout.toString())
    browserBundle = readFileSync(join(directory, 'bundle.js'), 'utf8')
    browserStyles = readFileSync(join(directory, 'bundle.css'), 'utf8')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: executable,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

for (const theme of ['dark', 'light'] as const) {
  for (const width of [280, 800]) {
    test(`AI recipe headings and controls: ${theme}, ${width}px`, async () => {
      const { context, page, pageErrors } = await openPage(theme, width)
      try {
        await page.evaluate(() => (window as BrowserTestWindow).__aiSettingsFixture.mount())
        await page.waitForFunction(() => {
          const fixture = (window as BrowserTestWindow).__aiSettingsFixture
          const root = document.getElementById('settings-root')
          return fixture.mounted && fixture.pending === 0 && root !== null &&
            root.querySelectorAll('section[data-action]').length === 10 &&
            root.querySelectorAll('input[aria-label$=" model"]').length === 10 &&
            root.querySelectorAll('select[aria-label$=" effort"]').length === 10 &&
            root.querySelectorAll('button').length >= 22 &&
            root.querySelectorAll('[role="status"]').length === 0
        })
        expect(pageErrors).toEqual([])

        const headingMetrics = await page.evaluate(() => {
          const root = document.getElementById('settings-root')
          if (!root) throw new Error('The AI settings root did not render.')
          const token = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-section').trim()
          const sections = Array.from(root.querySelectorAll<HTMLElement>(':scope > .ui-stack > section[data-action]'))
          return {
            token,
            sections: sections.map((section) => {
              const heading = section.querySelector<HTMLElement>('h2, h3')
              if (!heading) return { action: section.dataset.action ?? '', title: '', fontSize: '', margins: [] }
              const style = getComputedStyle(heading)
              return {
                action: section.dataset.action ?? '',
                title: heading.textContent?.trim() ?? '',
                tag: heading.tagName.toLowerCase(),
                fontSize: style.fontSize,
                margins: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft]
              }
            })
          }
        })

        expect(headingMetrics.sections.map(({ action, title }) => ({ action, title }))).toEqual(ACTIONS)
        expect(headingMetrics.sections.map(({ fontSize, margins }) => ({ fontSize, margins }))).toEqual(
          ACTIONS.map(() => ({ fontSize: headingMetrics.token, margins: ['0px', '0px', '0px', '0px'] }))
        )

        const layout = await page.evaluate(() => {
          const root = document.getElementById('settings-root')
          if (!root) throw new Error('The AI settings root did not render.')
          const resolveColor = (token: string) => {
            const probe = document.createElement('span')
            probe.style.color = `var(${token})`
            document.body.append(probe)
            const color = getComputedStyle(probe).color
            probe.remove()
            return color
          }
          const buttonByText = (scope: ParentNode, label: string): HTMLButtonElement | null =>
            Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === label) ?? null
          const headerData = Array.from(root.querySelectorAll<HTMLElement>(':scope > .ui-stack > section[data-action]')).map((section) => {
            const headers = Array.from(section.children).filter((child): child is HTMLElement =>
              child instanceof HTMLElement && child.classList.contains('ui-section-header'))
            const header = headers[0] ?? null
            const titles = header ? Array.from(header.children).filter((child): child is HTMLElement =>
              child instanceof HTMLElement && child.classList.contains('ui-section-header__title')) : []
            const title = titles[0] ?? null
            const titleStyle = title ? getComputedStyle(title) : null
            const headerStyle = header ? getComputedStyle(header) : null
            const headerRect = header?.getBoundingClientRect()
            const sectionRect = section.getBoundingClientRect()
            const previousGap = (button: HTMLButtonElement | null) => {
              const previous = button?.previousElementSibling
              if (!button || !(previous instanceof HTMLElement)) return null
              return button.getBoundingClientRect().top - previous.getBoundingClientRect().bottom
            }
            const agent = Array.from(section.querySelectorAll<HTMLElement>('[aria-label]')).find((node) => node.getAttribute('aria-label') === `${section.querySelector('.ui-section-header__title')?.textContent} agent`)
            const action = section.dataset.action ?? ''
            const label = section.querySelector<HTMLElement>('.ui-section-header__title')?.textContent ?? ''
            const reset = buttonByText(section, 'Reset')
            const inheritedReset = buttonByText(section, 'Use inherited launch choices')
            const refresh = buttonByText(section, 'Refresh models')
            const generator = action === 'branchName'
              ? buttonByText(section, 'Generate branch name')
              : action === 'conversationName'
                ? buttonByText(section, 'Generate conversation name')
                : null
            const fields = Array.from(section.querySelectorAll<HTMLElement>('[aria-label]'))
            const hasLabel = (name: string) => fields.some((field) => field.getAttribute('aria-label') === name)
            return {
              action,
              title: label.trim(),
              headerCount: headers.length,
              titleCount: titles.length,
              titleTag: title?.tagName.toLowerCase() ?? null,
              fontSize: titleStyle?.fontSize ?? null,
              margins: titleStyle ? [titleStyle.marginTop, titleStyle.marginRight, titleStyle.marginBottom, titleStyle.marginLeft] : null,
              color: titleStyle?.color ?? null,
              mutedColor: resolveColor('--ui-muted'),
              textTransform: titleStyle?.textTransform ?? null,
              minHeight: headerStyle?.minHeight ?? null,
              rowSingle: getComputedStyle(document.documentElement).getPropertyValue('--ui-row-single').trim(),
              headerFits: header !== null && headerRect !== undefined && header.clientWidth >= 0 &&
                header.scrollWidth <= header.clientWidth && headerRect.left >= sectionRect.left - 0.5 && headerRect.right <= sectionRect.right + 0.5,
              hasAgent: agent !== undefined,
              hasArgs: hasLabel(`${label} CLI arguments`),
              hasTemplate: hasLabel(`${label} command template`),
              hasModel: hasLabel(`${label} model`),
              hasEffort: hasLabel(`${label} effort`),
              resetExists: reset !== null,
              resetDisabled: reset?.disabled ?? null,
              inheritedResetExists: inheritedReset !== null,
              inheritedResetDisabled: inheritedReset?.disabled ?? null,
              refreshExists: refresh !== null,
              refreshGap: previousGap(refresh),
              inheritedResetGap: previousGap(inheritedReset),
              generatorExists: generator !== null,
              generatorDisabled: generator?.disabled ?? null,
              conversationChoiceExists: action !== 'conversationName' || hasLabel('Captured conversation')
            }
          })
          const topHeader = root.querySelector<HTMLElement>(':scope > .ui-stack > .ui-section-header')
          return {
            topTitle: topHeader?.querySelector<HTMLElement>(':scope > .ui-section-header__title')?.textContent?.trim() ?? null,
            close: topHeader ? buttonByText(topHeader, 'Close')?.textContent?.trim() ?? null : null,
            sections: headerData
          }
        })

        expect(layout.topTitle).toBe('Source Control AI defaults')
        expect(layout.close).toBe('Close')
        expect(layout.sections.map(({ action, title }) => ({ action, title }))).toEqual(ACTIONS)
        for (const section of layout.sections) {
          expect(section.headerCount).toBe(1)
          expect(section.titleCount).toBe(1)
          expect(section.titleTag).toBe('h2')
          expect(section.fontSize).toBe(headingMetrics.token)
          expect(section.margins).toEqual(['0px', '0px', '0px', '0px'])
          expect(section.color).toBe(section.mutedColor)
          expect(section.textTransform).toBe('uppercase')
          expect(section.minHeight).toBe(section.rowSingle)
          expect(section.headerFits).toBe(true)
          expect(section.hasAgent).toBe(true)
          expect(section.hasArgs).toBe(true)
          expect(section.hasTemplate).toBe(true)
          expect(section.hasModel).toBe(true)
          expect(section.hasEffort).toBe(true)
          expect(section.resetExists).toBe(true)
          expect(section.resetDisabled).toBe(true)
          expect(section.inheritedResetExists).toBe(true)
          expect(section.inheritedResetDisabled).toBe(true)
          expect(section.refreshExists).toBe(true)
          expect(section.refreshGap).toBeGreaterThanOrEqual(8)
          expect(section.inheritedResetGap).toBeGreaterThanOrEqual(8)
          if (section.action === 'branchName') {
            expect(section.generatorExists).toBe(true)
            expect(section.generatorDisabled).toBe(false)
          } else if (section.action === 'conversationName') {
            expect(section.conversationChoiceExists).toBe(true)
            expect(section.generatorExists).toBe(true)
            expect(section.generatorDisabled).toBe(true)
          }
        }

        const recipeCalls = await page.evaluate(() =>
          (window as BrowserTestWindow).__aiSettingsFixture.calls
            .filter((call) => call.method === 'quirky.git/aiRecipe')
            .map((call) => call.params)
        )
        expect(recipeCalls).toEqual(ACTIONS.map(({ action }) => ({ worktree: WORKTREE, action })))
      } finally {
        await context.close()
      }
    }, 60_000)
  }
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [280, 800]) {
    test(`AI switch inline geometry and native interactions: ${theme}, ${width}px`, async () => {
      const { context, page, pageErrors } = await openPage(theme, width)
      try {
        await page.evaluate(() => (window as BrowserTestWindow).__aiSettingsFixture.mount())
        await page.waitForFunction(() => {
          const fixture = (window as BrowserTestWindow).__aiSettingsFixture
          return fixture.pending === 0 &&
            document.querySelectorAll('[data-action] input[aria-label$=" model"]').length === 10 &&
            document.querySelectorAll('[role="status"]').length === 0
        })
        const toggle = page.getByRole('switch', { name: 'Show Source Control AI actions', exact: true })
        expect(await toggle.count()).toBe(1)
        expect(await toggle.isChecked()).toBe(true)
        const geometry = await toggle.evaluate((element) => {
          const input = element as HTMLInputElement
          const row = input.closest('.ui-form-row')!
          const label = row.querySelector<HTMLLabelElement>('label')!
          const inputRect = input.getBoundingClientRect()
          const labelRect = label.getBoundingClientRect()
          const rootRect = document.getElementById('settings-root')!.getBoundingClientRect()
          const labelLineHeight = parseFloat(getComputedStyle(label).lineHeight)
          return {
            centerDifference: Math.abs(inputRect.top + inputRect.height / 2 - (labelRect.top + labelLineHeight / 2)),
            gap: labelRect.left - inputRect.right,
            width: inputRect.width,
            height: inputRect.height,
            sizeToken: parseFloat(getComputedStyle(input).getPropertyValue('--ui-checkbox-size')),
            withinForm: inputRect.left >= rootRect.left && labelRect.right <= rootRect.right &&
              inputRect.right <= rootRect.right && labelRect.left >= rootRect.left,
            id: input.id,
            labelFor: label.htmlFor,
            label: label.textContent,
            type: input.type,
            inlineRows: document.querySelectorAll('.ui-form-row--inline').length,
            otherRowsStacked: [...document.querySelectorAll('.ui-form-row')].filter((candidate) => candidate !== row)
              .every((candidate) => {
                const style = getComputedStyle(candidate)
                return style.display === 'flex' && style.flexDirection === 'column'
              })
          }
        })
        expect(geometry.centerDifference).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.gap - 8)).toBeLessThanOrEqual(0.5)
        expect(geometry.width).toBe(geometry.sizeToken)
        expect(geometry.height).toBe(geometry.sizeToken)
        expect(geometry.withinForm).toBe(true)
        expect(geometry.id).not.toBe('')
        expect(geometry.labelFor).toBe(geometry.id)
        expect(geometry.label).toBe('Show Source Control AI actions')
        expect(geometry.type).toBe('checkbox')
        expect(geometry.inlineRows).toBe(1)
        expect(geometry.otherRowsStacked).toBe(true)

        const label = page.locator('.ui-form-row__label').filter({ hasText: /^Show Source Control AI actions$/ })
        const settingCalls = () => page.evaluate(() =>
          (window as BrowserTestWindow).__aiSettingsFixture.calls.filter((call) => call.method === 'setting.set').map((call) => call.params)
        )
        await label.click()
        await page.waitForFunction(() => {
          const input = document.querySelector<HTMLInputElement>('input[role="switch"]')
          return input?.checked === false && (window as BrowserTestWindow).__aiSettingsFixture.pending === 0
        })
        expect(await settingCalls()).toEqual([{ id: 'setting:quirky.git/ai-enabled', value: false }])

        await toggle.focus()
        await toggle.press('Space')
        await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[role="switch"]')?.checked === true)
        expect(await settingCalls()).toEqual([
          { id: 'setting:quirky.git/ai-enabled', value: false },
          { id: 'setting:quirky.git/ai-enabled', value: true }
        ])
        const focus = await toggle.evaluate((input) => {
          const style = getComputedStyle(input)
          return {
            active: document.activeElement === input,
            visible: input.matches(':focus-visible'),
            width: parseFloat(style.outlineWidth),
            style: style.outlineStyle,
            color: style.outlineColor
          }
        })
        expect(focus.active).toBe(true)
        expect(focus.visible).toBe(true)
        expect(focus.width).toBeGreaterThan(0)
        expect(focus.style).not.toBe('none')
        expect(focus.color).not.toBe('rgba(0, 0, 0, 0)')

        await page.evaluate(() => {
          (window as BrowserTestWindow).__aiSettingsFixture.failures['setting.set'] = 'setting refused'
        })
        await label.click()
        await page.waitForFunction(() => {
          const fixture = (window as BrowserTestWindow).__aiSettingsFixture
          return fixture.pending === 0 && fixture.toasts.length === 1 &&
            document.querySelector<HTMLInputElement>('input[role="switch"]')?.checked === true
        })
        expect(await settingCalls()).toEqual([
          { id: 'setting:quirky.git/ai-enabled', value: false },
          { id: 'setting:quirky.git/ai-enabled', value: true },
          { id: 'setting:quirky.git/ai-enabled', value: false }
        ])
        expect(await page.evaluate(() => (window as BrowserTestWindow).__aiSettingsFixture.toasts)).toEqual([{
          title: 'Could not change the setting',
          message: 'setting refused',
          options: { kind: 'error' }
        }])
        await page.evaluate(() => {
          const fixture = (window as BrowserTestWindow).__aiSettingsFixture
          fixture.setSetting('ai-enabled', false)
          fixture.emit({ type: 'setting.changed', id: 'setting:quirky.git/ai-enabled', value: false })
        })
        await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[role="switch"]')?.checked === false)
        expect(await settingCalls()).toHaveLength(3)
      } finally {
        await context.close()
        expect(pageErrors).toEqual([])
      }
    }, 60_000)
  }
}
