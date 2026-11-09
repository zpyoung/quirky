import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import type { TreeProps } from '../src/Tree'
import { buildTree } from '../src/view-model'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, type ActivityMarkState } from '../src/view-types'

const STYLESHEET = join(import.meta.dir, '../../../packages/ui/src/design-system/worktree-tree.css')

const REPO: Repo = { id: 'r1', name: 'QuirkyApp', path: '/repo/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }

const worktree = (id: string, name: string, isMain: boolean): WorktreeControl => ({
  id, repoId: 'r1', path: `/repo/QuirkyApp/${id}`, branch: id, head: 'abc', isMain, name, instanceId: id,
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false,
  parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: 1, manualOrder: 0, sleeping: false, sleepChangedAt: null,
  references: [], archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false, tagIds: []
}) as WorktreeControl

const context = {
  call: async () => [],
  toast: () => {},
  log: () => {},
  subscribe: () => () => {},
  onConnection: () => () => {}
} as unknown as UiPluginContext

let Tree: typeof import('../src/Tree').Tree
let createRoot: typeof import('react-dom/client').createRoot
let root: Root | null = null
let host: HTMLElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Tree = (await import('../src/Tree')).Tree
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

async function mount(options = DEFAULT_STOCK_OPTIONS, marks: Record<string, ActivityMarkState> = {}) {
  host = document.createElement('div')
  document.body.append(host)
  const worktrees = [worktree('main', 'main', true), worktree('fix', 'fix-desktop', false)]
  const model = buildTree({
    worktrees,
    repos: [REPO],
    groups: [],
    tags: [],
    spec: allSpecFromStock(options, DEFAULT_ACTIVITY_PREFERENCES),
    viewId: 'all',
    projection: null,
    marks: new Map(Object.entries(marks)),
    checks: new Map()
  })
  const props: TreeProps = {
    context, model, tagsById: new Map(), rowFact: 'last-activity', repos: [REPO], groups: [], sessions: [], selectedId: null,
    automationExpandedId: null, automationAvailability: null, onToggleAutomationDetails: () => {},
    now: 1, separatorEnabled: false, options, canShowSleeping: (worktree) => options.showSleeping || worktree.isMain, statusDefinitions: [], projectIdentities: {},
    openDialog: () => {}, requestDelete: () => {}, onDropPreviewChange: () => {}, onSeparatorStateChange: () => {}
  }
  root = createRoot(host)
  await act(async () => root!.render(createElement(Tree, props)))
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
}

const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)

test('a project header shows its name in the stored case and no worktree count', async () => {
  await mount()
  const header = host.querySelector<HTMLElement>('.repo-header')!
  expect(header.querySelector('.ui-section-header__title')?.textContent).toContain('QuirkyApp')
  expect(header.querySelector('.project-count')).toBeNull()
  expect(header.querySelector('.worktree-attention')).toBeNull()
})

test('a header shows the attention count for waiting rows in amber and for an errored row in red', async () => {
  await mount(DEFAULT_STOCK_OPTIONS, { fix: 'waiting' })
  const waiting = host.querySelector<HTMLElement>('.repo-header .worktree-attention')!
  expect(waiting.textContent).toBe('1')
  expect(waiting.dataset.attention).toBe('waiting')
  await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
  await mount(DEFAULT_STOCK_OPTIONS, { fix: 'waiting', main: 'error' })
  const errored = host.querySelector<HTMLElement>('.repo-header .worktree-attention')!
  expect(errored.textContent).toBe('2')
  expect(errored.dataset.attention).toBe('error')
})

test('header and row controls stay in the DOM, reachable by label', async () => {
  await mount()
  expect(byLabel('New worktree in QuirkyApp')).not.toBeNull()
  expect(byLabel('Actions for QuirkyApp')).not.toBeNull()
  expect(byLabel('Actions for fix-desktop')).not.toBeNull()
  expect(byLabel('Actions for main')).not.toBeNull()
  expect(host.querySelector('.worktree-reveal [aria-label="Actions for main"]')).not.toBeNull()
  expect(host.querySelector('.project-reveal')).toBeNull()
})

test('the project name and its controls survive narrowing to one project', async () => {
  await mount({ ...DEFAULT_STOCK_OPTIONS, filterRepoIds: ['r1'] })
  const header = host.querySelector<HTMLElement>('.repo-header')!
  expect(header.querySelector('.ui-section-header__title')?.textContent).toContain('QuirkyApp')
  expect(byLabel('New worktree in QuirkyApp')).not.toBeNull()
})

test('a row swaps its fact for the menu on hover, focus and selection with an opacity fade', () => {
  const css = readFileSync(STYLESHEET, 'utf8')
  expect(css).toMatch(/\.worktree-reveal\s*\{[^}]*opacity:\s*0/)
  expect(css).toMatch(/\.worktree:hover[^{]*\.worktree-reveal/)
  expect(css).toMatch(/\.worktree:focus-within[^{]*\.worktree-reveal/)
  expect(css).toMatch(/\.worktree\.selected[^{]*\.worktree-reveal/)
  expect(css).toMatch(/\.worktree:hover[^{]*\.worktree-fact[^{]*\{[^}]*opacity:\s*0/)
  expect(css).toMatch(/\.worktree-fact,\s*[^{]*\.worktree-reveal\s*\{[^}]*grid-area:\s*1\s*\/\s*1/)
  expect(css).not.toMatch(/display:\s*none/)
  expect(css).not.toMatch(/visibility:\s*hidden/)
})

test('headers carry no hover-only reveal', () => {
  const css = readFileSync(STYLESHEET, 'utf8')
  expect(css).not.toMatch(/project-reveal/)
  expect(css).not.toMatch(/\.repo-header[^{]*:hover/)
})

test('motion is opacity and transform only at 150ms ease-out, and reduced motion turns it off', () => {
  const css = readFileSync(STYLESHEET, 'utf8')
  expect(css).not.toMatch(/transition:\s*all/)
  const transitions = [...css.matchAll(/transition:\s*([^;]+);/g)].map((match) => match[1]!).filter((value) => value !== 'none')
  expect(transitions.length).toBeGreaterThan(0)
  for (const value of transitions) expect(value).toMatch(/^(opacity|transform) 150ms ease-out$/)
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*transition:\s*none/)
})

test('the stylesheet scopes every rule under the worktree panel classes', () => {
  const css = readFileSync(STYLESHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((match) => match[1].split(',').map((part) => part.trim())).filter((part) => !part.startsWith('@'))
  expect(selectors.length).toBeGreaterThan(0)
  for (const selector of selectors) expect(selector).toMatch(/\.(repo-header|worktree-tree|worktree-hover|worktree-tags)(?![a-z])/)
})
