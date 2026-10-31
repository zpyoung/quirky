import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../../..')
const AGENT_MODULES = join(ROOT, 'plugins/quirky.agents/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(AGENT_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(AGENT_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(AGENT_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(AGENT_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(AGENT_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const STYLESHEETS = [
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/agents.css'
]
const AGENTS = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'claude-agent-teams', label: 'Claude Agent Teams', command: 'claude --teammate-mode in-process' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'gemini', label: 'Gemini', command: 'gemini' }
] as const
const READABLE_AGENT_IDS = ['claude', 'opencode', 'gemini']
const CARD_WIDTHS = [470, 360]
const PAGE_WIDTHS = [360, 590, 1000]

function chromiumExecutable(): string | null {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
}

const executable = chromiumExecutable()
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const agentRow = join(ROOT, 'plugins/quirky.agents/src/window/AgentRow.tsx')
  const agentsView = join(ROOT, 'plugins/quirky.agents/src/window/AgentsView.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { AgentRow } from ${JSON.stringify(agentRow)}
    import { AgentsView } from ${JSON.stringify(agentsView)}
    import type { AgentInfo, AgentListing } from ${JSON.stringify(join(ROOT, 'plugins/quirky.agents/src/core/types.ts'))}
    import type { AgentsStore } from ${JSON.stringify(join(ROOT, 'plugins/quirky.agents/src/window/model.ts'))}

    const agents: AgentInfo[] = ${JSON.stringify(AGENTS)}.map((agent) => ({
      ...agent,
      plugin: 'quirky.agents',
      installed: true,
      enabled: true,
      isDefault: false,
      promptMode: 'argv',
      resumable: true,
      canFork: true,
      homepage: 'https://docs.example.test/agents',
      install: null,
      commandOverridden: false,
      args: '',
      argsOverridden: false,
      env: {},
      envOverridden: false,
      showEnv: false,
      permissions: { mode: 'manual', hasAuto: true }
    }))
    const listing = {
      defaultAgent: 'auto',
      workspaceTrust: false,
      permissions: { summary: 'manual', nonAuto: 'manual' },
      agents
    } as AgentListing
    const snapshot = { status: 'ready', listing, error: null, refreshing: false } as const
    const store = {
      subscribe: () => () => {},
      getSnapshot: () => snapshot
    } as unknown as AgentsStore
    const cards = agents.map((info) => createElement(
      'section',
      { key: info.id, 'data-card': info.id, style: { width: '470px', boxSizing: 'border-box' } },
      createElement(
        'ul',
        { style: { listStyle: 'none', margin: 0, padding: 0 } },
        createElement(AgentRow, { info, listing, store })
      )
    ))
    const cardsHost = document.getElementById('agents')
    if (cardsHost) {
      createRoot(cardsHost).render(
        createElement('div', { className: 'agents-ui', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '16px' } }, ...cards)
      )
    }
    const pageHost = document.getElementById('agents-page')
    if (pageHost) {
      Object.assign(pageHost.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
      createRoot(pageHost).render(createElement(AgentsView, { store }))
    }
  `
}

function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'agent-row-layout-browser-dependencies',
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
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\\n'))
    await Bun.write(${JSON.stringify(outputPath)}, result.outputs[0]!)
  `
}

beforeAll(async () => {
  if (!executable) return
  const tempDir = mkdtempSync(join(ROOT, 'plugins/quirky.agents/.agent-row-layout-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const outputPath = join(tempDir, 'browser-bundle.js')
    const buildScript = join(tempDir, 'build-browser-entry.ts')
    writeFileSync(buildScript, browserBuildScript(entrypoint, outputPath))
    const build = Bun.spawnSync([process.execPath, buildScript], { cwd: ROOT })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString() || build.stdout.toString())
    browserBundle = readFileSync(outputPath, 'utf8')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    executablePath: executable,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

describe('installed agent settings controls', () => {
  test.skipIf(!executable)('keeps each card’s switch label and actions aligned at narrow widths', async () => {
    const context = await browser!.newContext({ viewport: { width: 640, height: 600 } })
    const page = await context.newPage()
    try {
      await page.setContent('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>html, body { margin: 0; min-height: 100%; }</style></head><body><div id="agents"></div></body></html>')
      for (const stylesheet of STYLESHEETS) {
        await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
      }
      await page.addScriptTag({ content: browserBundle })
      await page.getByRole('switch', { name: 'Enabled: Claude', exact: true }).waitFor()

      for (const width of CARD_WIDTHS) {
        await page.locator('[data-card]').evaluateAll((cards, cardWidth) => {
          for (const card of cards) (card as HTMLElement).style.width = `${cardWidth}px`
        }, width)

        for (const agent of AGENTS) {
          const card = page.locator(`[data-card="${agent.id}"]`)
          const row = card.locator(`[data-agent="${agent.id}"]`)
          const cardBox = await card.boundingBox()
          const switchControl = row.getByRole('switch', { name: `Enabled: ${agent.label}`, exact: true })
          const visibleLabel = row.locator('label').filter({ hasText: /Enabled/ })
          const switchBox = await switchControl.boundingBox()
          const labelTextBox = await visibleLabel.evaluate((label) => {
            const textNode = document.createTreeWalker(label, NodeFilter.SHOW_TEXT).nextNode()
            if (!textNode) return null
            const range = document.createRange()
            range.selectNodeContents(textNode)
            const { y, height } = range.getBoundingClientRect()
            return { y, height }
          })
          if (!cardBox || !switchBox || !labelTextBox || labelTextBox.height === 0) {
            throw new Error(`Missing layout geometry for ${agent.label}`)
          }

          expect(Math.abs((switchBox.y + switchBox.height / 2) - (labelTextBox.y + labelTextBox.height / 2))).toBeLessThanOrEqual(1)

          const controls = [
            switchControl,
            visibleLabel,
            row.getByRole('button', { name: `Set default: ${agent.label}`, exact: true }),
            row.getByRole('link', { name: `Docs: ${agent.label}`, exact: true }),
            row.getByRole('button', { name: 'Expand agent settings', exact: true })
          ]
          const boxes = await Promise.all(controls.map((control) => control.boundingBox()))
          if (boxes.some((box) => box === null)) throw new Error(`Missing action control for ${agent.label}`)
          const actionBoxes = boxes as NonNullable<(typeof boxes)[number]>[]
          const centers = actionBoxes.map((box) => box.y + box.height / 2)
          expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
          for (const box of actionBoxes) {
            expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 1)
            expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
          }
        }
      }

    } finally {
      await context.close()
    }
  }, 60_000)
  test.skipIf(!executable)('keeps the full Agents view usable across page widths', async () => {
    const context = await browser!.newContext({ viewport: { width: 360, height: 1200 } })
    const page = await context.newPage()
    try {
      await page.setContent('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>html, body { margin: 0; width: 100%; height: 100%; } body { display: flex; flex-direction: column; }</style></head><body><div id="agents-page"></div></body></html>')
      for (const stylesheet of STYLESHEETS) {
        await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
      }
      await page.addScriptTag({ content: browserBundle })
      await page.getByRole('switch', { name: 'Enabled: OpenCode', exact: true }).waitFor()

      const mount = page.locator('#agents-page')
      const pageRoot = page.locator('.agents-ui')
      const frame = page.locator('.ui-tool-panel-frame')
      const choiceGroup = page.getByRole('group', { name: 'Default agent', exact: true })
      const choiceButtons = choiceGroup.getByRole('button')

      for (const width of PAGE_WIDTHS) {
        await page.setViewportSize({ width, height: 1200 })
        const [mountBox, pageBox, frameBox] = await Promise.all([
          mount.boundingBox(),
          pageRoot.boundingBox(),
          frame.boundingBox()
        ])
        if (!mountBox || !pageBox || !frameBox) throw new Error('Missing full-page layout geometry')

        expect(mountBox.width).toBeGreaterThanOrEqual(width - 1)
        expect(mountBox.width).toBeLessThanOrEqual(width + 1)
        expect(Math.abs(frameBox.x - mountBox.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(frameBox.width - mountBox.width)).toBeLessThanOrEqual(2)
        expect(Math.abs(frameBox.width - pageBox.width)).toBeLessThanOrEqual(2)

        const rows = page.locator('.agents-ui [data-agent]')
        expect(await rows.count()).toBe(AGENTS.length)
        for (const agent of AGENTS) {
          const row = page.locator(`.agents-ui [data-agent="${agent.id}"]`)
          const rowBox = await row.boundingBox()
          if (!rowBox) throw new Error(`Missing installed row geometry for ${agent.label}`)
          expect(rowBox.x).toBeGreaterThanOrEqual(frameBox.x - 1)
          expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1)
          expect(rowBox.width).toBeGreaterThanOrEqual(frameBox.width - 64)

          const switchControl = row.getByRole('switch', { name: `Enabled: ${agent.label}`, exact: true })
          const visibleLabel = row.locator('label').filter({ hasText: /Enabled/ })
          const controls = [
            switchControl,
            visibleLabel,
            row.getByRole('button', { name: `Set default: ${agent.label}`, exact: true }),
            row.getByRole('link', { name: `Docs: ${agent.label}`, exact: true }),
            row.getByRole('button', { name: 'Expand agent settings', exact: true })
          ]
          const boxes = await Promise.all(controls.map((control) => control.boundingBox()))
          if (boxes.some((box) => box === null)) throw new Error(`Missing action control for ${agent.label}`)
          const actionBoxes = boxes as NonNullable<(typeof boxes)[number]>[]
          const centers = actionBoxes.map((box) => box.y + box.height / 2)
          expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
          for (const box of actionBoxes) {
            expect(box.x).toBeGreaterThanOrEqual(rowBox.x - 1)
            expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
            expect(box.y).toBeGreaterThanOrEqual(rowBox.y - 1)
            expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1)
          }
          for (let i = 0; i < actionBoxes.length; i += 1) {
            for (let j = i + 1; j < actionBoxes.length; j += 1) {
              if (i === 0 && j === 1) continue
              expect(actionBoxes[i].x + actionBoxes[i].width).toBeLessThanOrEqual(actionBoxes[j].x + 1)
            }
          }

          if (READABLE_AGENT_IDS.includes(agent.id)) {
            for (const selector of ['strong', 'code']) {
              const textBoxes = await row.locator(selector).evaluate((element) => {
                const range = document.createRange()
                range.selectNodeContents(element)
                return Array.from(range.getClientRects()).map(({ x, y, width, height }) => ({ x, y, width, height }))
                  .filter(({ width, height }) => width > 0 && height > 0)
              })
              expect(textBoxes).toHaveLength(1)
              expect(textBoxes[0].x).toBeGreaterThanOrEqual(rowBox.x - 1)
              expect(textBoxes[0].x + textBoxes[0].width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
            }
          }
        }

        const groupBox = await choiceGroup.boundingBox()
        const auto = choiceGroup.getByRole('button', { name: 'Auto', exact: true })
        const autoBox = await auto.boundingBox()
        const autoTextBox = await auto.evaluate((button) => {
          const range = document.createRange()
          range.selectNodeContents(button)
          const { x, y, width, height } = range.getBoundingClientRect()
          return { x, y, width, height }
        })
        if (!groupBox || !autoBox) throw new Error('Missing default-agent choices geometry')
        expect(groupBox.width).toBeGreaterThanOrEqual(frameBox.width - 64)
        expect(autoBox.width).toBeGreaterThan(0)
        expect(autoBox.height).toBeGreaterThan(0)
        expect(autoBox.x).toBeGreaterThanOrEqual(groupBox.x - 1)
        expect(autoBox.x + autoBox.width).toBeLessThanOrEqual(groupBox.x + groupBox.width + 1)
        expect(autoTextBox.width).toBeGreaterThan(0)
        expect(autoTextBox.height).toBeGreaterThan(0)
        expect(autoTextBox.x).toBeGreaterThanOrEqual(autoBox.x - 1)
        expect(autoTextBox.x + autoTextBox.width).toBeLessThanOrEqual(autoBox.x + autoBox.width + 1)

        const choiceCount = await choiceButtons.count()
        expect(choiceCount).toBe(AGENTS.length + 2)
        const boxes = await Promise.all(
          Array.from({ length: choiceCount }, (_, index) => choiceButtons.nth(index).boundingBox())
        )
        if (boxes.some((box) => box === null)) throw new Error('Missing default-agent choice geometry')
        const choiceBoxes = boxes as NonNullable<(typeof boxes)[number]>[]
        const lines: { y: number; count: number }[] = []
        for (const box of choiceBoxes) {
          expect(box.x).toBeGreaterThanOrEqual(groupBox.x - 1)
          expect(box.x + box.width).toBeLessThanOrEqual(groupBox.x + groupBox.width + 1)
          expect(box.y).toBeGreaterThanOrEqual(groupBox.y - 1)
          expect(box.y + box.height).toBeLessThanOrEqual(groupBox.y + groupBox.height + 1)
          const center = box.y + box.height / 2
          const line = lines.find((candidate) => Math.abs(candidate.y - center) <= 1)
          if (line) line.count += 1
          else lines.push({ y: center, count: 1 })
        }
        expect(Math.max(...lines.map((line) => line.count))).toBeGreaterThan(1)
        expect(lines.length).toBeLessThan(choiceBoxes.length)
        if (width === 360) expect(lines.length).toBeGreaterThan(1)
      }
    } finally {
      await context.close()
    }
  }, 60_000)
})
