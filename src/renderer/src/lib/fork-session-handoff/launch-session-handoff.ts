import { submitPromptToAgentPty } from '@/lib/agent-paste-draft'
import { detectAgentSessionContinuationAgents } from '@/lib/launch-agent-session-continuation'
import {
  launchAgentInNewTab,
  type LaunchAgentInNewTabArgs,
  type LaunchAgentInNewTabResult
} from '@/lib/launch-agent-in-new-tab'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { LaunchSource } from '../../../../shared/agent-kind'
import { TUI_AGENT_CONFIG, type TuiAgentConfig } from '../../../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  ForkHandoffRelationship,
  ForkSessionHandoffLineageRecord,
  LineageEndpointIdentity
} from '../../../../shared/fork-session-handoff/session-lineage-types'
import { clearHandoffDraft } from '../../components/agent-session-continuation/fork-session-handoff/handoff-draft-preservation'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import {
  resolveHandoffDeliveryEvidence,
  type HandoffDeliveryOutcome,
  type ResolveHandoffDeliveryEvidenceArgs
} from './handoff-delivery-evidence'
import { enrichSessionLineage, recordSessionLineage } from './session-lineage-actions'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'

export type LaunchForkSessionHandoffArgs = {
  agent: TuiAgent
  briefText: string
  target: HandoffTargetResolution
  groupId: string | null
  launchSource: LaunchSource
  lineage: {
    relationship: ForkHandoffRelationship
    parent: LineageEndpointIdentity
  }
}

export type LaunchForkSessionHandoffResult =
  | {
      ok: true
      tabId: string | null
      deliveryOutcome: Promise<HandoffDeliveryOutcome>
    }
  | { ok: false; reason: 'agent-unavailable' | 'launch-failed' }

type StoreState = ReturnType<typeof useAppStore.getState>
type AgentTrustPreset = NonNullable<TuiAgentConfig['preflightTrust']>

export type LaunchForkSessionHandoffCollaborators = {
  getState?: () => StoreState
  subscribeToStore?: (listener: (state: StoreState) => void) => () => void
  detectAgents?: (worktreeId: string) => Promise<TuiAgent[]>
  isAgentEnabled?: (agent: TuiAgent, state: StoreState) => boolean
  markAgentTrusted?: (args: {
    preset: AgentTrustPreset
    workspacePath: string
    connectionId?: string
  }) => Promise<void>
  launchAgent?: (args: LaunchAgentInNewTabArgs) => LaunchAgentInNewTabResult
  submitPrompt?: typeof submitPromptToAgentPty
  resolveDeliveryEvidence?: (args: ResolveHandoffDeliveryEvidenceArgs) => HandoffDeliveryOutcome
  recordLineage?: (record: ForkSessionHandoffLineageRecord) => Promise<void>
  enrichLineage?: typeof enrichSessionLineage
  clearDraft?: typeof clearHandoffDraft
  now?: () => number
  createLineageId?: () => string
}

export type RetainedHandoffBrief = {
  tabId: string
  briefText: string
  automaticResendAttempted: boolean
}

export type HandoffResendOutcome = 'resent' | 'failed' | 'unavailable' | 'already-attempted'

export type ResendRetainedHandoffBriefOptions = {
  automatic?: boolean
  getState?: () => StoreState
  submitPrompt?: typeof submitPromptToAgentPty
}

type RetainedHandoffBriefEntry = RetainedHandoffBrief & {
  resendInFlight?: Promise<HandoffResendOutcome>
}

const retainedBriefsByTabId = new Map<string, RetainedHandoffBriefEntry>()

/**
 * Drop briefs whose tab is gone. A brief can carry diff bodies and secret-scan-flagged
 * content, and a tab closed while its recovery toast is still pending never clears its own.
 */
function releaseBriefsForClosedTabs(getState: () => { ptyIdsByTabId: Record<string, unknown> }) {
  if (retainedBriefsByTabId.size === 0) {
    return
  }
  const liveTabIds = getState().ptyIdsByTabId
  for (const [tabId, entry] of retainedBriefsByTabId) {
    if (!entry.resendInFlight && !(tabId in liveTabIds)) {
      retainedBriefsByTabId.delete(tabId)
    }
  }
}

/** Return the brief retained for a launched tab without exposing mutable map state. */
export function getRetainedHandoffBrief(tabId: string): RetainedHandoffBrief | null {
  const entry = retainedBriefsByTabId.get(tabId)
  return entry
    ? {
        tabId: entry.tabId,
        briefText: entry.briefText,
        automaticResendAttempted: entry.automaticResendAttempted
      }
    : null
}

/** Clear retained brief content after delivery or toast dismissal. */
export function clearRetainedHandoffBrief(tabId: string): boolean {
  return retainedBriefsByTabId.delete(tabId)
}

/** Alias used by toast dismissal handlers to release retained brief content. */
export function dismissRetainedHandoffBrief(tabId: string): boolean {
  return clearRetainedHandoffBrief(tabId)
}

/** Resend through the existing bracketed-paste transaction and clear only on success. */
export async function resendRetainedHandoffBrief(
  tabId: string,
  options: ResendRetainedHandoffBriefOptions = {}
): Promise<HandoffResendOutcome> {
  const entry = retainedBriefsByTabId.get(tabId)
  if (!entry) {
    return 'unavailable'
  }
  if (entry.resendInFlight) {
    return entry.resendInFlight
  }
  if (options.automatic && entry.automaticResendAttempted) {
    return 'already-attempted'
  }

  const getState = options.getState ?? useAppStore.getState
  const ptyId = getState().ptyIdsByTabId[tabId]?.[0]
  if (!ptyId) {
    return 'unavailable'
  }
  if (options.automatic) {
    entry.automaticResendAttempted = true
  }

  const submitPrompt = options.submitPrompt ?? submitPromptToAgentPty
  const resend = submitPrompt({ tabId, ptyId, content: entry.briefText })
    .then((submitted) => {
      if (submitted) {
        retainedBriefsByTabId.delete(tabId)
        return 'resent' as const
      }
      return 'failed' as const
    })
    .catch(() => 'failed' as const)
    .finally(() => {
      const retained = retainedBriefsByTabId.get(tabId)
      if (retained === entry) {
        delete retained.resendInFlight
      }
    })
  entry.resendInFlight = resend
  return resend
}

/** Launch a handoff with readiness-gated prompt delivery and lineage recording. */
export async function launchForkSessionHandoff(
  args: LaunchForkSessionHandoffArgs,
  collaborators: LaunchForkSessionHandoffCollaborators = {}
): Promise<LaunchForkSessionHandoffResult> {
  const dependencies = resolveCollaborators(collaborators)
  const state = dependencies.getState()
  if (!dependencies.isAgentEnabled(args.agent, state)) {
    return { ok: false, reason: 'agent-unavailable' }
  }

  try {
    const detectedAgents = await dependencies.detectAgents(args.target.worktreeId)
    if (!detectedAgents.includes(args.agent)) {
      return { ok: false, reason: 'agent-unavailable' }
    }
  } catch {
    return { ok: false, reason: 'agent-unavailable' }
  }

  await preflightTrust(args, dependencies)

  let callbackReportedDelivered = false
  const launchedAtMs = dependencies.now()
  let launchResult: LaunchAgentInNewTabResult
  try {
    launchResult = dependencies.launchAgent({
      requestId: newAgentLaunchRequestId(),
      agent: args.agent,
      worktreeId: args.target.worktreeId,
      ...(args.groupId ? { groupId: args.groupId } : {}),
      prompt: args.briefText,
      promptDelivery: 'submit-after-ready',
      initialCwd: args.target.initialCwd,
      launchSource: args.launchSource,
      onPromptDelivered: () => {
        callbackReportedDelivered = true
      }
    })
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
  if (!launchResult) {
    return { ok: false, reason: 'launch-failed' }
  }

  // Why: v1.4.206 replaced the result's `tabId: string | null` with a surface union, where
  // host-published is the case that used to be null — the handoff waits on prompt delivery there.
  const tabId = launchResult.surface.kind === 'host-published' ? null : launchResult.surface.tabId
  let promptDeliveryResult = launchResult.promptDeliveryResult
  if (tabId === null) {
    if (!promptDeliveryResult) {
      return { ok: false, reason: 'launch-failed' }
    }
    try {
      const report = await promptDeliveryResult
      if (report.failureNotified) {
        return { ok: false, reason: 'launch-failed' }
      }
      promptDeliveryResult = Promise.resolve(report)
    } catch {
      return { ok: false, reason: 'launch-failed' }
    }
  }

  releaseBriefsForClosedTabs(useAppStore.getState)
  if (tabId) {
    retainedBriefsByTabId.set(tabId, {
      tabId,
      briefText: args.briefText,
      automaticResendAttempted: false
    })
  }

  dependencies.clearDraft({
    sourcePaneKey: args.lineage.parent.paneKey,
    vaultAgent: args.lineage.parent.agent,
    vaultSessionId: args.lineage.parent.providerSessionId
  })

  const lineageRecord = createLineageRecord(args, tabId, launchedAtMs, dependencies)
  try {
    await dependencies.recordLineage(lineageRecord)
  } catch {
    // lineage persistence must not turn an opened child session into a launch failure
  }
  if (tabId) {
    watchForLineageChild(lineageRecord.id, tabId, dependencies)
  }

  const deliveryOutcome = settleDeliveryOutcome({
    tabId,
    launchedAtMs,
    callbackReportedDelivered: () => callbackReportedDelivered,
    promptDeliveryResult,
    dependencies
  })
  return { ok: true, tabId, deliveryOutcome }
}

type ResolvedCollaborators = Required<LaunchForkSessionHandoffCollaborators>

function resolveCollaborators(
  overrides: LaunchForkSessionHandoffCollaborators
): ResolvedCollaborators {
  return {
    getState: overrides.getState ?? useAppStore.getState,
    subscribeToStore: overrides.subscribeToStore ?? ((listener) => useAppStore.subscribe(listener)),
    detectAgents: overrides.detectAgents ?? detectAgentSessionContinuationAgents,
    isAgentEnabled:
      overrides.isAgentEnabled ??
      ((agent, state) => isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)),
    markAgentTrusted:
      overrides.markAgentTrusted ??
      // Why: the main process pre-trusts the workspace on every fresh agent spawn, honouring the user's setting.
      (async () => undefined),
    launchAgent: overrides.launchAgent ?? launchAgentInNewTab,
    submitPrompt: overrides.submitPrompt ?? submitPromptToAgentPty,
    resolveDeliveryEvidence: overrides.resolveDeliveryEvidence ?? resolveHandoffDeliveryEvidence,
    recordLineage: overrides.recordLineage ?? recordSessionLineage,
    enrichLineage: overrides.enrichLineage ?? enrichSessionLineage,
    clearDraft: overrides.clearDraft ?? clearHandoffDraft,
    now: overrides.now ?? Date.now,
    createLineageId: overrides.createLineageId ?? createBrowserUuid
  }
}

async function preflightTrust(
  args: LaunchForkSessionHandoffArgs,
  dependencies: ResolvedCollaborators
): Promise<void> {
  const preset = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preset || !args.target.workspacePath) {
    return
  }
  try {
    await dependencies.markAgentTrusted({
      preset,
      workspacePath: args.target.workspacePath,
      ...(args.target.sshConnectionId ? { connectionId: args.target.sshConnectionId } : {})
    })
  } catch {
    // trust preflight is best-effort so a prepared handoff still launches
  }
}

function createLineageRecord(
  args: LaunchForkSessionHandoffArgs,
  tabId: string | null,
  createdAt: number,
  dependencies: ResolvedCollaborators
): ForkSessionHandoffLineageRecord {
  return {
    id: dependencies.createLineageId(),
    createdAt,
    relationship: args.lineage.relationship,
    parent: args.lineage.parent,
    child: {
      paneKey: null,
      agent: args.agent,
      providerSessionId: null,
      transcriptPath: null,
      worktreeId: args.target.worktreeId,
      title: null,
      tabId
    }
  }
}

async function settleDeliveryOutcome(args: {
  tabId: string | null
  launchedAtMs: number
  callbackReportedDelivered: () => boolean
  promptDeliveryResult: NonNullable<LaunchAgentInNewTabResult>['promptDeliveryResult']
  dependencies: ResolvedCollaborators
}): Promise<HandoffDeliveryOutcome> {
  let deliveryReported: boolean | undefined = args.callbackReportedDelivered() || undefined
  if (args.promptDeliveryResult) {
    try {
      deliveryReported = (await args.promptDeliveryResult).delivered
    } catch {
      deliveryReported = false
    }
  }
  if (args.callbackReportedDelivered()) {
    deliveryReported = true
  }

  // Why: this promise is consumed by a fire-and-forget toast, so a throwing evidence read
  // must degrade to the recovery path instead of becoming an unhandled rejection.
  let outcome: HandoffDeliveryOutcome
  try {
    outcome = args.dependencies.resolveDeliveryEvidence({
      tabId: args.tabId,
      launchedAtMs: args.launchedAtMs,
      deliveryReported,
      state: args.dependencies.getState()
    })
  } catch {
    outcome = 'unobservable'
  }
  if (outcome === 'delivered' && args.tabId) {
    clearRetainedHandoffBrief(args.tabId)
  } else if (outcome === 'not-delivered' && args.tabId) {
    await resendRetainedHandoffBrief(args.tabId, {
      automatic: true,
      getState: args.dependencies.getState,
      submitPrompt: args.dependencies.submitPrompt
    })
  }
  return outcome
}

function watchForLineageChild(
  recordId: string,
  tabId: string,
  dependencies: ResolvedCollaborators
): void {
  let stopped = false
  let unsubscribe: (() => void) | null = null
  const stop = (): void => {
    stopped = true
    unsubscribe?.()
  }
  const inspect = (state: AppState): void => {
    for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
      if (parsePaneKey(paneKey)?.tabId !== tabId || !entry.providerSession?.id) {
        continue
      }
      stop()
      void dependencies
        .enrichLineage({
          recordId,
          paneKey,
          providerSessionId: entry.providerSession.id
        })
        .catch(() => undefined)
      return
    }
    const tabExists = Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.id === tabId)
    )
    if (!tabExists) {
      stop()
    }
  }

  unsubscribe = dependencies.subscribeToStore(inspect)
  inspect(dependencies.getState())
  if (stopped) {
    unsubscribe()
  }
}
