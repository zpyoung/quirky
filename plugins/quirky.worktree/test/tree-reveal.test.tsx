import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { Repo, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import type { TreeModel, TreeRow } from '../src/report'
import type { TreeProps } from '../src/Tree'

const REPO: Repo = { id: 'r1', name: 'QuirkyApp', path: '/repo/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }

const worktree = (id: string, name: string, isMain: boolean): WorktreeControl => ({
  id, repoId: 'r1', path: `/repo/QuirkyApp/${id}`, branch: id, head: 'abc', isMain, name, instanceId: id,
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false,
  parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: 1, manualOrder: 0, sleeping: false, sleepChangedAt: null,
  references: [], archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false
}) as WorktreeControl

const row = (item: WorktreeControl): TreeRow => ({ worktree: item, depth: 0, childCount: 0, descendants: [], ancestors: [] })

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

async function mount(options = DEFAULT_STOCK_OPTIONS) {
  host = document.createElement('div')
  document.body.append(host)
  const model: TreeModel = {
    pinned: [],
    groups: [],
    projects: [{ repo: REPO, rows: [row(worktree('main', 'main', true)), row(worktree('fix', 'fix-desktop', false))], pending: [] }]
  }
  const props: TreeProps = {
    context, model, groups: [], sessions: [], selectedId: null,
    automationExpandedId: null, automationAvailability: null, onToggleAutomationDetails: () => {},
    now: 1, separatorEnabled: false, options, statusDefinitions: [], projectIdentities: {},
    openDialog: () => {}, requestDelete: () => {}, onDropPreviewChange: () => {}, onSeparatorStateChange: () => {}
  }
  root = createRoot(host)
  await act(async () => root!.render(createElement(Tree, props)))
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
}

const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)

test('a project header shows its name in the stored case and the worktree count', async () => {
  await mount()
  const header = host.querySelector<HTMLElement>('.repo-header')!
  expect(header.querySelector('.ui-section-header__title')?.textContent).toContain('QuirkyApp')
  expect(header.querySelector('.project-count')?.textContent).toBe('2')
})

test('hidden controls stay in the DOM and reachable by label', async () => {
  await mount()
  expect(byLabel('New worktree in QuirkyApp')).not.toBeNull()
  expect(byLabel('Actions for QuirkyApp')).not.toBeNull()
  expect(byLabel('Actions for fix-desktop')).not.toBeNull()
  expect(byLabel('Actions for main')).not.toBeNull()
  const primary = [...host.querySelectorAll<HTMLElement>('.worktree-reveal')].find((node) => node.textContent?.includes('Primary'))
  expect(primary).toBeDefined()
  expect(host.querySelector('.worktree-reveal [aria-label="Actions for main"]')).not.toBeNull()
  expect(host.querySelector('.project-reveal [aria-label="Actions for QuirkyApp"]')).not.toBeNull()
})

test('the count and project name survive narrowing to one project', async () => {
  await mount({ ...DEFAULT_STOCK_OPTIONS, filterRepoIds: ['r1'] })
  const header = host.querySelector<HTMLElement>('.repo-header')!
  expect(header.querySelector('.ui-section-header__title')?.textContent).toContain('QuirkyApp')
  expect(header.querySelector('.project-count')?.textContent).toBe('2')
  expect(byLabel('New worktree in QuirkyApp')).not.toBeNull()
})
