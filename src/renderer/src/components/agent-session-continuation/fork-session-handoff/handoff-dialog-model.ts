import { translate } from '@/i18n/i18n'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import type {
  AgentSessionContinuationRequest,
  AgentSessionContinuationSource
} from '@/lib/agent-session-continuation'
export { getHandoffTemplates } from '@/lib/fork-session-handoff/handoff-template-catalog'
import type { HandoffPreviewPhase } from '@/lib/fork-session-handoff/handoff-preview-detach'
import {
  composeHandoffBrief,
  type HandoffBriefInputs
} from '@/lib/fork-session-handoff/handoff-brief-composer'
import type { SecretScanHit } from '@/lib/fork-session-handoff/handoff-secret-scan'
import type { HandoffTranscriptReachability } from '@/lib/fork-session-handoff/handoff-transcript-reachability'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { LaunchSource } from '../../../../../shared/agent-kind'
import {
  getHandoffAnchorRepoId,
  resolveHandoffTarget,
  type HandoffTargetResolution
} from '@/lib/fork-session-handoff/handoff-target-resolution'
import type { ForkSessionHandoffSettings } from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { HandoffDialogWarning } from './HandoffWarningsBanner'

export type HandoffDialogStoreInputs = Pick<
  AppState,
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'worktreesByRepo'
>

export function selectHandoffDialogStoreInputs(state: AppState): HandoffDialogStoreInputs {
  return {
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    activeWorkspaceKey: state.activeWorkspaceKey,
    activeWorktreeId: state.activeWorktreeId,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    repos: state.repos,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    worktreesByRepo: state.worktreesByRepo
  }
}

export function chooseHandoffAgent(
  available: TuiAgent[],
  ...preferred: unknown[]
): TuiAgent | null {
  return (
    preferred.find(
      (agent): agent is TuiAgent =>
        typeof agent === 'string' && available.includes(agent as TuiAgent)
    ) ??
    available[0] ??
    null
  )
}

export function buildHandoffWarnings(args: {
  sourceBusy: boolean
  hostChanged: boolean
  secretHits: SecretScanHit[]
  transcriptReachability: HandoffTranscriptReachability
  compositionWarnings: string[]
  previewPhase: HandoffPreviewPhase
  operationErrors: string[]
}): HandoffDialogWarning[] {
  const warnings: HandoffDialogWarning[] = []
  if (args.sourceBusy) {
    warnings.push({ kind: 'source-busy' })
  }
  if (args.hostChanged) {
    warnings.push({ kind: 'host-changed' })
  }
  if (args.secretHits.length) {
    warnings.push({ kind: 'secret-hits', hits: args.secretHits })
  }
  if (args.transcriptReachability === 'unreachable') {
    warnings.push({ kind: 'transcript-unreachable' })
  }
  if (args.transcriptReachability === 'unverifiable') {
    warnings.push({ kind: 'transcript-unverifiable' })
  }
  for (const code of args.compositionWarnings) {
    if (code === 'no-transcript-context' || code === 'diff-truncated' || code === 'no-context') {
      warnings.push({ kind: code })
    }
  }
  if (args.previewPhase.phase === 'detached' && args.previewPhase.staleReasons.length) {
    warnings.push({ kind: 'stale-preview', reasons: args.previewPhase.staleReasons })
  }
  for (const message of args.operationErrors) {
    if (message) {
      warnings.push({ kind: 'operation-error', message })
    }
  }
  return warnings
}

/** Explain why Start refreshed the preview instead of sending it. */
export function handoffCaptureChangedNotice(): string {
  return translate(
    'components.agentSessionContinuation.forkSessionHandoff.captureChanged',
    'The source session changed. The preview was refreshed — review it, then start again.'
  )
}

export function handoffLaunchError(reason: 'agent-unavailable' | 'launch-failed'): string {
  return reason === 'agent-unavailable'
    ? translate(
        'components.agentSessionContinuation.forkSessionHandoff.agentUnavailable',
        'The selected Agent is no longer available on the target host.'
      )
    : translate(
        'components.agentSessionContinuation.forkSessionHandoff.launchFailed',
        'Could not start the new Agent session. Your handoff is unchanged.'
      )
}

async function createInlineHandoffWorktree(args: {
  anchorWorktreeId: string
  name: string
  baseBranch: string
  launchSource: LaunchSource
}): Promise<string> {
  const state = useAppStore.getState()
  const repoId = getHandoffAnchorRepoId(state, args.anchorWorktreeId)
  if (!repoId) {
    throw new Error(
      translate(
        'components.agentSessionContinuation.forkSessionHandoff.createUnavailable',
        'No Git repository is available for worktree creation.'
      )
    )
  }
  const result = await state.createWorktree(
    repoId,
    args.name.trim(),
    args.baseBranch.trim() || undefined,
    undefined,
    undefined
  )
  return result.worktree.id
}

function resolveCreatedHandoffTarget(worktreeId: string): HandoffTargetResolution {
  const target = resolveHandoffTarget(useAppStore.getState(), worktreeId)
  if (!target) {
    throw new Error(
      translate(
        'components.agentSessionContinuation.forkSessionHandoff.createdTargetUnavailable',
        'The new worktree could not be resolved.'
      )
    )
  }
  return target
}

export async function createAndSelectInlineHandoffTarget(args: {
  anchorWorktreeId: string
  name: string
  baseBranch: string
  launchSource: LaunchSource
  onCreated: (worktreeId: string) => void
}): Promise<HandoffTargetResolution> {
  const worktreeId = await createInlineHandoffWorktree(args)
  args.onCreated(worktreeId)
  return resolveCreatedHandoffTarget(worktreeId)
}

export type HandoffStartBodyResolution =
  | { status: 'ready'; body: string }
  | { status: 'capture-changed'; body: string; latestCapture: string | null }

export function resolveHandoffBodyForStart(args: {
  inputs: HandoffBriefInputs
  previewPhase: HandoffPreviewPhase
  editedBody: string
  previewedBody: string
  latestCapture: string | null
}): HandoffStartBodyResolution {
  if (args.previewPhase.phase === 'detached') {
    return { status: 'ready', body: args.editedBody }
  }
  const body = composeHandoffBrief({
    ...args.inputs,
    source: {
      ...args.inputs.source,
      capturedText: args.latestCapture ?? args.inputs.source.capturedText
    },
    inlinedCapture: args.inputs.transcriptUsableOnTarget
      ? null
      : (args.latestCapture ?? args.inputs.inlinedCapture)
  }).editableBody
  return body === args.previewedBody
    ? { status: 'ready', body }
    : { status: 'capture-changed', body, latestCapture: args.latestCapture }
}

export function isHandoffStartDisabled(args: {
  starting: boolean
  detectingAgents: boolean
  selectedAgent: TuiAgent | null
  target: HandoffTargetResolution | null
  noContext: boolean
  transcriptReachabilityLoading: boolean
  repoStateLoading: boolean
  repoStateIncluded: boolean
  createMode: boolean
  createName: string
}): boolean {
  return (
    args.starting ||
    args.detectingAgents ||
    !args.selectedAgent ||
    !args.target ||
    args.noContext ||
    args.transcriptReachabilityLoading ||
    (args.repoStateIncluded && args.repoStateLoading) ||
    (args.createMode && !args.createName.trim())
  )
}

export function isHandoffContextEmpty(args: {
  compositionWarnings: string[]
  previewPhase: HandoffPreviewPhase
  editedBody: string
}): boolean {
  return args.previewPhase.phase === 'detached'
    ? !args.editedBody.trim()
    : args.compositionWarnings.includes('no-context')
}

export function visibleHandoffCompositionWarnings(args: {
  compositionWarnings: string[]
  previewPhase: HandoffPreviewPhase
  editedBody: string
}): string[] {
  return args.compositionWarnings.filter(
    (code) =>
      code !== 'no-context' || args.previewPhase.phase === 'attached' || !args.editedBody.trim()
  )
}

export async function persistHandoffPreferencesBestEffort(args: {
  update: (settings: { forkSessionHandoff: ForkSessionHandoffSettings }) => Promise<void>
  settings: ForkSessionHandoffSettings
}): Promise<void> {
  try {
    await args.update({ forkSessionHandoff: args.settings })
  } catch {}
}

export function getHandoffAgentCatalog(detectedAgents: TuiAgent[]): AgentCatalogEntry[] {
  return getAgentCatalog().filter((entry) => detectedAgents.includes(entry.id))
}

/** The dialog's live view of the source: the capture the user took and the path
 *  the host actually resolved both override what the request arrived with. */
export function resolveHandoffDialogSource(
  request: AgentSessionContinuationRequest | null,
  capturedText: string | null,
  transcriptResolvedPath: string | null
): AgentSessionContinuationSource | null {
  return request
    ? {
        ...request.source,
        capturedText: capturedText ?? request.source.capturedText,
        transcriptPath: transcriptResolvedPath ?? request.source.transcriptPath
      }
    : null
}

/** The bounded capture stands in whenever the saved transcript will not travel —
 *  absent and unverified both qualify, since neither can be referenced. */
export function handoffInlinedCapture(
  reachability: HandoffTranscriptReachability,
  capturedText: string | null
): string | null {
  return reachability === 'unreachable' || reachability === 'unverifiable' ? capturedText : null
}

export function getHandoffContextDisabledReason(
  reachability: HandoffTranscriptReachability
): string | null {
  if (reachability === 'usable') {
    return null
  }
  return reachability === 'unverifiable'
    ? translate(
        'components.agentSessionContinuation.forkSessionHandoff.contextUnverifiable',
        'A full saved transcript could not be verified on this target. Focused context will be used.'
      )
    : translate(
        'components.agentSessionContinuation.forkSessionHandoff.contextUnavailable',
        'A full saved transcript is not reachable on this target. Focused context will be used.'
      )
}
