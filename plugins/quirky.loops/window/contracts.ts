import type { UiPluginContext } from '@quirky/protocol'
import type { LoopConfig, LoopCreateInput, LoopSnapshot } from '../src/types'

/** Invalid numeric text is retained until the person corrects it. */
export type LoopDraft = {
  name: string
  agent: 'claude' | 'codex'
  preset: 'until-done' | 'interval' | 'queue'
  prompt: string
  queueItems: string[]
  repeatQueue: boolean
  /** Editing pacing is independent of the loop's immutable creation preset. */
  pacingKind: 'on-idle' | 'interval'
  intervalMinutes: string
  anchor: 'from-end' | 'wall-clock'
  sessionPolicy: 'fresh' | 'continue'
  maxIterations: string
  checkCommand: string
  checkTimeout: string
  checkWhen: 'every-iteration' | 'on-claim'
  evaluatorCondition: string
  maxActiveMinutes: string
  maxCostUsd: string
  protectedPaths: string
  noProgress: boolean
  checkpointCommits: boolean
  askBeforeNext: boolean
  resumeAtLimitReset: boolean
  advanced: boolean
}

export type DraftValidation = {
  errors: Record<string, string>
  config: LoopConfig | null
  input: Omit<LoopCreateInput, 'worktree' | 'worktreeId'> | null
}

export type SurfaceHandle = {
  read(): Record<string, unknown>
  dispatch(action: string, params?: Record<string, unknown>): Promise<unknown>
}

export type SetupDialogProps = {
  context: UiPluginContext
  workspace: string
  group?: string
  onClose(): void
  onCreated(loop: LoopSnapshot): Promise<void>
  onHandle(handle: SurfaceHandle | null): void
  report?(state: unknown): void
}

export type LoopViewProps = {
  context: UiPluginContext
  loopId: string
  onHandle(handle: SurfaceHandle | null): void
  report?(state: unknown): void
}

export type ConfigFieldsProps = {
  draft: LoopDraft
  onChange(patch: Partial<LoopDraft>): void
  errors: Record<string, string>
  workspaceKind: 'git' | 'folder'
  showCost: boolean
  editing?: boolean
  disabled?: boolean
}

/** Stable public UI IDs shared with the terminal's generic menu contribution. */
export const LOOP_VIEW_ID = 'view:quirky.loops/loop'
export const LOOP_OVERLAY_ID = 'overlay:quirky.loops/dialogs'
