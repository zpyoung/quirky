import type { MethodHandler, PluginContext, UiPluginContext } from '@quirky/protocol'
import type { AutomationDefinition, AutomationRun } from '../types'
import type { AutomationService } from '../service'

export const AUTOMATIONS_VIEW = 'view:quirky.automations/automations'
export const AUTOMATIONS_SETTINGS_VIEW = 'view:quirky.automations/settings'
export const API = 'quirky.automations/'
export type AutomationNavigation = {
  page: 'list' | 'detail' | 'runs' | 'run'
  automationId: string | null
  runId: string | null
  tab: 'overview' | 'runs'
  query: string
  host: string
  status: 'all' | 'enabled' | 'paused'
  lastRun: 'all' | 'failed' | 'succeeded' | 'never'
  agent: string
  sort: 'name' | 'lastRun'
  direction: 'asc' | 'desc'
  runQuery: string
  runStatus: 'all' | 'successful' | 'failed' | 'progress' | 'skipped'
}
export type AutomationDraft = {
  name: string
  prompt: string
  agentId: 'claude' | 'codex'
  projectId: string
  workspaceMode: 'existing' | 'new_per_run'
  workspaceId: string | null
  baseBranch: string | null
  setupDecision: 'run' | 'skip'
  reuseSession: boolean
  timezone: string
  rrule: string
  missedRunGraceMinutes: number
  precheck: { command: string; timeoutSeconds: number } | null
  launchOverrides: { model?: string; optionValues?: Record<string, string | boolean> } | null
  runContext: Record<string, unknown> | null
  sourceContext: Record<string, unknown> | null
}
export type AutomationUiState = {
  revision: number
  navigation: AutomationNavigation
  editor: { id: string | null; original: AutomationDefinition | null; draft: AutomationDraft; creationKey: string } | null
}
export type AutomationUiEnv = {
  context: PluginContext
  service: AutomationService
  read(): AutomationUiState
  update(change: (state: AutomationUiState) => void): AutomationUiState
  navigate(patch: Partial<AutomationNavigation>): Promise<AutomationUiState>
}
export type AutomationMethods = Record<string, MethodHandler>
export type AutomationSurfaceProps = {
  context: UiPluginContext
  state: AutomationUiState
  refresh(): Promise<void>
  notify(message: string, kind?: 'success' | 'error' | 'info'): void
}
export type AutomationEditorData = {
  hosts: { id: string; label: string; available: boolean; reason?: string }[]
  projects: { id: string; name: string; hostId: string; path: string; kind: string }[]
  workspaces: { id: string; repoId: string; name: string; path: string; isMain: boolean }[]
  agents: { id: string; label: string; enabled: boolean; installed: boolean; isDefault: boolean }[]
  errors: string[]
}
export type ExternalJob = {
  id: string
  name: string
  schedule: string
  enabled: boolean
  state: string
  promptPreview: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  runCount: number | null
  runs: Record<string, unknown>[]
}
export type ExternalManager = {
  id: 'openclaw:local'
  provider: 'openclaw'
  hostId: 'local'
  label: string
  status: 'ready' | 'unavailable'
  canManage: boolean
  error: string | null
  jobs: ExternalJob[]
  owner: { provider: 'openclaw'; hostId: 'local'; generation: string }
}
export type ExternalListResult = { managers: ExternalManager[] }
export type ExternalAction = 'pause' | 'resume' | 'run' | 'delete'
export type AutomationPageData = { definitions: AutomationDefinition[]; runs: AutomationRun[] }
