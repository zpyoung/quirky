import type { MethodHandler, PluginContext, UiPluginContext, UiLayout } from '@quirky/protocol'

export const TASKS_VIEW = 'view:quirky.tasks/tasks'
export const TASKS_SETTINGS_VIEW = 'view:quirky.tasks/settings'
export const TASKS_API = 'quirky.tasks/'

export type ItemKind = 'issue' | 'pullRequest'
export type ItemTarget = {
  worktree: string
  kind: ItemKind
  number: number
  url?: string
  projectId?: string
  itemId?: string
  host?: string
  owner?: string
  repo?: string
}
export type TaskItem = {
  kind: ItemKind
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged' | 'draft' | 'unknown'
  url: string
  createdAt: string | null
  updatedAt: string | null
  author: string | null
  labels: string[]
  assignees: string[]
  isDraft: boolean
  headRefName?: string
  baseRefName?: string
  headRefOid?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  mergeStateStatus?: string
  reviewDecision?: string
  stateReason?: string
  duplicateOf?: number
  [key: string]: unknown
}
export type TaskRepo = { id: string; name: string; path: string; kind: string; displayName?: string | null; worktree: string }
export type ProjectTarget = { id: string; owner: string; ownerType: 'user' | 'organization'; number: number; url: string; host?: string; title?: string; viewId?: string; viewNumber?: number }
export type IssueDraft = { title: string; body: string; labels: string[]; assignees: string[]; repoId: string | null }
export type TaskPreferences = {
  showTasksButton: boolean
  visibleTaskProviders: string[]
  defaultTaskSource: string
  defaultTaskViewPreset: string
  defaultRepoSelection: string[] | null
}
export type ProjectPreferences = {
  pinned: ProjectTarget[]
  recent: ProjectTarget[]
  lastViewByProject: Record<string, string>
  queryByView: Record<string, string>
  hiddenColumns: Record<string, string[]>
  columnWidths: Record<string, Record<string, number>>
  roadmapZoom: 'month' | 'quarter' | 'year'
}
export type WorkspaceLink = { worktree: string; name: string; url: string; repoId: string }
export type TaskNavigation = {
  source: string
  mode: 'issues' | 'prs' | 'projects'
  repoIds: string[] | null
  query: string
  page: number
  scrollTop: number
  detail: ItemTarget | null
  newIssue: boolean
  project: ProjectTarget | null
}
export type TasksState = {
  revision: number
  navigation: TaskNavigation
  preferences: TaskPreferences
  issueDraft: IssueDraft
  projects: ProjectPreferences
  links: Record<string, WorkspaceLink>
}

/** update is synchronous and atomic; only durable fields persist, never the session draft/navigation. */
export type TasksEnv = {
  context: PluginContext
  read(): TasksState
  update(change: (state: TasksState) => void): TasksState
  navigate(patch: Partial<TaskNavigation>): Promise<TasksState>
  repositories(): Promise<TaskRepo[]>
  previousView: UiLayout['view']
}
export type TaskMethodTable = Record<string, MethodHandler>
export type TasksSurfaceProps = {
  context: UiPluginContext
  state: TasksState
  refresh(): Promise<void>
}

export type TaskListResult = {
  items: (TaskItem & { worktree: string; repoId: string; repoName: string })[]
  repositories: TaskRepo[]
  page: number
  totalPages: number
  perRepo: number
  failures: { repoId: string; message: string; reason?: string }[]
  sources: Record<string, unknown>
}

// Component exports owned by the corresponding vertical slice:
// list/TasksList.tsx: TasksList(props: TasksSurfaceProps)
// issue/IssueSurface.tsx: IssueSurface(props: TasksSurfaceProps)
// issue/NewIssueDialog.tsx: NewIssueDialog(props: TasksSurfaceProps)
// projects/ProjectsSurface.tsx: ProjectsSurface(props: TasksSurfaceProps)
// Each slice exports its method table factory (env: TasksEnv) from its methods.ts.
// Parent registers the union and owns manifest, environment, state/navigation, UI composition.
