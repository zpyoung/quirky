import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { TasksState } from '../src/contracts'
import { CompactTasks } from '../src/list/CompactTasks'

type Fixture = { firstNumber: number; rowCount: number }
type Call = { method: string; params: Record<string, unknown> }
type MenuMock = {
  calls: Call[]
  commands: { id: string; args: unknown }[]
  opened: { id: string; input: unknown }[]
  toasts: string[]
}

const { compactMenuFixture } = window as unknown as { compactMenuFixture: Fixture }
const mock: MenuMock = { calls: [], commands: [], opened: [], toasts: [] }
Object.assign(window, { compactMenuMock: mock })

const state: TasksState = {
  revision: 3,
  navigation: {
    source: 'github', mode: 'prs', repoIds: null, query: 'is:pr is:open', page: 1, scrollTop: 0,
    detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: 'is:pr is:open', page: 1 }
  },
  preferences: {
    showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github',
    defaultTaskViewPreset: 'open', defaultRepoSelection: null
  },
  issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
  projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
  links: {}
}

const repository = { id: 'repo-1', name: 'quirky', path: '/work/quirky', kind: 'git', worktree: 'wt-main', displayName: null }
const items = Array.from({ length: compactMenuFixture.rowCount }, (_, index) => {
  const number = compactMenuFixture.firstNumber + index
  return {
    kind: 'pullRequest' as const,
    number,
    title: `Pull request ${number}`,
    body: '',
    state: 'open' as const,
    url: `https://github.com/acme/quirky/pull/${number}`,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    author: 'sam',
    labels: [],
    assignees: [],
    isDraft: false,
    worktree: 'wt-main',
    repoId: 'repo-1',
    repoName: 'quirky'
  }
})

const context = {
  provide: () => undefined,
  async call(method: string, params: Record<string, unknown> = {}) {
    mock.calls.push({ method, params })
    switch (method) {
      case 'quirky.tasks/prepare':
      case 'quirky.tasks/state':
      case 'quirky.tasks/navigate':
        return state
      case 'quirky.tasks/list':
        return {
          items,
          repositories: [repository],
          page: 1,
          totalPages: 1,
          perRepo: items.length,
          failures: [],
          sources: { 'repo-1': { origin: { host: 'github.com', owner: 'acme', repo: 'quirky' } } }
        }
      case 'quirky.tasks/counts':
        return { issues: 12, prs: items.length }
      case 'quirky.tasks/checks':
      case 'quirky.tasks/mergeMetadata':
        return null
      case 'quirky.hosting/viewer':
        return { login: 'sam' }
      case 'quirky.agent-status/dashboard':
        return { cards: [] }
      case 'quirky.reviews/open':
        return null
      default:
        throw new Error(`Unexpected browser fixture call: ${method}`)
    }
  },
  subscribe: () => () => undefined,
  toast: (title: string) => { mock.toasts.push(title) },
  async executeCommand(id: string, args: unknown) {
    mock.commands.push({ id, args })
  },
  openView(id: string, input: unknown) {
    mock.opened.push({ id, input })
  }
} as unknown as UiPluginContext

createRoot(document.getElementById('host')!).render(<CompactTasks context={context} />)
