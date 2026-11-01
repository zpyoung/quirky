import type { UiPluginContext } from '@quirky/protocol'
import type { DiffViewInput } from '../shared/view-input'
import type { DiffSettings, SettingName } from './settings'
import type { ViewHandle } from './registry'

/** What the diff view reports to `ui.state`. */
export type ViewReport = {
  mode: DiffViewInput['mode']
  source: string | null
  path: string | null
  area: string | null
  /** Stable worktree and hosted-tab identity when the view is in the terminal tab strip. */
  worktree?: string
  tabId?: string | null
  groupId?: string | null
  /** The hosted view's placement in its terminal workspace. */
  placement?: 'preview' | 'permanent' | 'split'
  display?: 'source' | 'preview'
  commit: string | null
  changes: number
  currentChange: number | null
  dirty: boolean
  stale: boolean
  tooLarge: boolean
  sections?: number
  loadedSections?: string[]
  collapsed?: boolean
  conflicts?: number
  currentConflict?: number | null
}

/** The commands a mode implements; the root forwards the view handle's calls to it. */
export type Controller = Partial<Omit<ViewHandle, 'input' | 'requestClose'>> & { isDirty?(): boolean }

/** What the root hands every mode. */
export type ModeProps = {
  context: UiPluginContext
  input: DiffViewInput
  settings: DiffSettings
  setSetting(name: SettingName, value: boolean | string): void
  report(state: ViewReport): void
  bind(controller: Controller): void
  /** Reopens the worktree's sessions view. */
  close(): void
}
