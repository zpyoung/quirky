import type { PluginContext, UiPluginContext } from '@quirky/protocol'

export type Level = 'shadow' | 'local' | 'own-branch' | 'full'
export type SwitchId = 'messaging' | 'historyRewrite' | 'deploys'
export type Switches = Record<SwitchId, boolean>
export type AgentKind = 'claude' | 'codex' | 'pi' | 'omp'
export type Mandate = { worktreeId: string; goal: string; doneWhen: string; doneWhenKind: 'command' | 'prose'; guidelines: string[]; level: Level; switches: Switches; agent: string | null; sharedGoalId: string | null; notes: string; allowSplit: boolean; updatedAt: number }
export type SharedGoal = { id: string; goal: string; worktreeIds: string[]; mergeOrder: string[] }
export type HandoffInput = Omit<Mandate, 'worktreeId' | 'updatedAt' | 'sharedGoalId'> & { worktreeId: string; sharedGoal?: { id?: string; goal: string } }
export type WorktreeState = 'checking' | 'gate-failed' | 'briefing' | 'working' | 'waiting-on-you' | 'checking-done' | 'in-review' | 'merge-ready' | 'merged' | 'pr-ready' | 'committed' | 'parked' | 'done'
export type SheetRow = { worktreeId: string; name: string; projectId: string; projectName: string; groupId: string | null; groupName: string | null; agent: string | null; running: boolean; handedOff: boolean; eligible: boolean; reason: string | null; ungatedNote: string | null }
export type ToolCall = { agent: AgentKind; sessionId: string; worktreeId: string; cwd: string; toolName: string; toolInput: unknown; event: 'PreToolUse' | 'PermissionRequest' | 'tool_call' }
export type ActionClass = 'read' | 'edit-inside' | 'edit-outside' | 'credential' | 'test' | 'build' | 'push-own' | 'push-default' | 'push-force' | 'remote-delete' | 'pr-draft' | 'pr-ready' | 'merge' | 'message-people' | 'deploy' | 'pipe-to-shell' | 'skip-hooks' | 'agent-config' | 'network-read' | 'other'
export type StepId = 'floor-core' | 'floor-switch' | 'level' | 'fixed-rules' | 'judgment'
export type RuleDecision = { outcome: 'allow' | 'deny' | 'held' | 'judgment'; step: StepId | null; reason: string; reliedOn: string; trace: { step: StepId; result: 'pass' | 'allow' | 'deny' | 'held'; note: string }[] }
export type GateOutcome = 'allow' | 'deny' | 'held' | 'retry' | 'passthrough'
export type JournalKind = 'handoff' | 'take-back' | 'gate' | 'event' | 'brain-action' | 'brain-error' | 'rotation' | 'ask' | 'guess' | 'stuck' | 'ladder' | 'done-check' | 'finding' | 'outbox' | 'skipped-call' | 'sleep' | 'mandate-proposal' | 'notify'
export type JournalEntry = { seq: number; at: number; worktreeId: string | null; kind: JournalKind; data: Record<string, unknown> }
export type NeedKind = 'held-call' | 'question' | 'guess' | 'mandate-edit' | 'parked' | 'gate-failed' | 'brain-error' | 'merge-blocked'
export type NeedAction = 'allow-once' | 'deny' | 'confirm' | 'redo' | 'review-accept' | 'review-reject' | 'answer' | 'restart' | 'take-back' | 'restart-to-handoff'
export type NeedsYouItem = { id: string; worktreeId: string; kind: NeedKind; title: string; detail: Record<string, unknown>; actions: NeedAction[]; createdAt: number; resolvedAt: number | null; resolution: string | null }
export type Approval = { id: string; worktreeId: string; fingerprint: string; usedAt: number | null }
export type Guess = { id: string; worktreeId: string; question: string; choice: string; confirmedAt: number | null; redoneAt: number | null; commitsSince: string[] }
export type OutboxRow = { id: string; worktreeId: string; kind: 'push' | 'pr' | 'pr-ready' | 'merge' | 'merge-main-in' | 'thread-reply'; payload: Record<string, unknown>; idempotencyKey: string; state: 'recorded' | 'running' | 'done' | 'failed' | 'cancelled'; result: Record<string, unknown> | null }
export type BrainAction =
  | { type: 'judge'; requestId: string; decision: 'allow' | 'deny' | 'held'; reliedOn: string; reason: string }
  | { type: 'send'; worktreeId: string; text: string }
  | { type: 'answerAsk'; askId: string; answers: Record<string, unknown> }
  | { type: 'askUser'; worktreeId: string; questions: unknown[]; blocks: string }
  | { type: 'guess'; worktreeId: string; question: string; choice: string; reversible: boolean }
  | { type: 'proposeMandateEdit'; worktreeId: string; patch: Partial<Pick<Mandate, 'goal' | 'doneWhen' | 'guidelines' | 'notes'>>; why: string }
  | { type: 'judgeFinding'; worktreeId: string; findingId: string; valid: boolean; reason: string }
  | { type: 'stepIn'; worktreeId: string; text: string }
  | { type: 'startSession' | 'restartWorker'; worktreeId: string; note: string }
  | { type: 'runDoneWhen' | 'startReview' | 'openPr' | 'merge' | 'mergeMainIn'; worktreeId: string }
  | { type: 'park'; worktreeId: string; story: string }
  | { type: 'splitWorktree'; worktreeId: string; branch: string; goal: string }
  | { type: 'setMergeOrder'; sharedGoalId: string; order: string[] }
  | { type: 'noop'; reason: string }
export type AvatarWorktreeStatus = { state: WorktreeState; level: Level; needsYou: number }
export type ReportModel = { needsYou: NeedsYouItem[]; stories: { worktreeId: string; name: string; switchesOn: SwitchId[]; story: string; handedBackWith: string[] }[]; summary: { decisions: number; allowed: number; denied: number; held: number; guesses: number; sleeps: { at: number; durationMs: number }[]; keptAwake: boolean }; topSkippedCalls: JournalEntry[] }

export type ClassifyContext = { worktreePath: string; handedOffPaths: string[]; defaultBranch: string; ownBranch: string; home: string; allowCommands: string[]; denyCommands: string[]; deployCommands: string[] }
export type DecideInput = { call: ToolCall; classes: ActionClass[]; mandate: Mandate; switches: Switches; level: Level; ctx: ClassifyContext }

/** One handed-off worktree's lifecycle row; `active` is false after take-back while the mandate is kept. */
export type HandoffRow = { worktreeId: string; state: WorktreeState; sessionId: string | null; active: boolean; handedOffAt: number; takenBackAt: number | null }
/** What the gate decided for one call, kept so the session record can be checked against it. */
export type Receipt = { id: string; fingerprint: string; sessionId: string; toolName: string; at: number; outcome: GateOutcome; step: StepId | null }
/** An answer the person gave after the gate had already answered the held call, applied when the same call is retried. */
export type LateAnswer = { fingerprint: string; worktreeId: string; decision: 'allow' | 'deny'; reason: string; createdAt: number; usedAt: number | null }
export type Finding = { id: string; worktreeId: string; source: 'reviewer' | 'bot' | 'skill'; summary: string; detail: Record<string, unknown>; valid: boolean | null; reason: string | null; threadId: string | null; commitSha: string | null; createdAt: number }
/** Stuck-signal counters for one worktree; `rung` is the next step of the recovery ladder. */
export type StuckRow = { worktreeId: string; rung: 0 | 1 | 2 | 3; counters: Record<string, number>; updatedAt: number }
export type BrainSession = { id: string; sessionId: string; startedAt: number; endedAt: number | null; endTokens: number | null }

export type AvatarBusEvent = { type: 'journal'; entry: JournalEntry } | { type: 'needs-changed' } | { type: 'state-changed'; worktreeId: string; state: WorktreeState } | { type: 'handoffs-changed' }

/** Typed row access for one store table; `put` inserts or replaces by key, `list` filters by field equality in insertion order. */
export type TableAccess<T> = {
  get(key: string): T | null
  put(row: T): void
  list(where?: Partial<T>): T[]
  delete(key: string): boolean
}

/** The avatar's durable state. The journal is append-only; every other table is plain get/put/list/delete. */
export type AvatarStore = {
  mandates: TableAccess<Mandate>
  handoffs: TableAccess<HandoffRow>
  sharedGoals: TableAccess<SharedGoal>
  receipts: TableAccess<Receipt>
  approvals: TableAccess<Approval>
  lateAnswers: TableAccess<LateAnswer>
  needs: TableAccess<NeedsYouItem>
  guesses: TableAccess<Guess>
  outbox: TableAccess<OutboxRow>
  findings: TableAccess<Finding>
  stuck: TableAccess<StuckRow>
  brainSessions: TableAccess<BrainSession>
  /** Appends a row and returns it with its assigned `seq`; `delivered_to_brain` starts false. */
  appendJournal(entry: { at: number; worktreeId: string | null; kind: JournalKind; data: Record<string, unknown> }): JournalEntry
  /** Entries with `seq` greater than `seq`, oldest first. */
  journalSince(seq: number): JournalEntry[]
  /** Newest-first page of the journal, optionally for one worktree and before a `seq`. */
  journalPage(opts?: { worktreeId?: string; limit?: number; before?: number }): JournalEntry[]
  /** Entries not yet delivered to the brain, oldest first. */
  undeliveredJournal(): JournalEntry[]
  markDelivered(seq: number): void
  /** Runs `fn` atomically; a throw rolls back every write inside it. */
  transaction<T>(fn: () => T): T
}

export type NeedsQueue = {
  add(item: Omit<NeedsYouItem, 'id' | 'createdAt' | 'resolvedAt' | 'resolution'>): NeedsYouItem
  list(opts?: { worktreeId?: string; open?: boolean }): NeedsYouItem[]
  close(id: string, resolution: string): void
}

export type GateService = { decideCall(call: ToolCall, deadlineMs: number, signal: AbortSignal): Promise<{ outcome: GateOutcome; reason: string; encoded: string }>; writeMarker(sessionId: string, worktreeId: string, level: Level): void; removeMarker(sessionId: string): void; gateCheck(worktreeId: string): Promise<{ ok: boolean; reason: string }>; approveOnce(needId: string): void; resolveInFlight(worktreeId: string, outcome: 'passthrough'): void; noteObservedCall(sessionId: string, fingerprint: string, at: number): void; hasReceipt(sessionId: string, fingerprint: string, aroundMs: number, windowMs: number): boolean }
export type HandoffService = { handoff(items: HandoffInput[]): Promise<{ worktreeId: string; ok: boolean; error?: string }[]>; takeBack(sel: { worktreeIds: string[] } | { all: true }): Promise<{ worktreeId: string; ok: boolean; handedBackWith: string[] }[]>; eligibility(): Promise<SheetRow[]>; mandate(worktreeId: string): Mandate | null; active(): { worktreeId: string; sessionId: string | null; state: WorktreeState; mandate: Mandate }[]; setState(worktreeId: string, state: WorktreeState, note: string): void; resolveNeed(needId: string, action: NeedAction, text?: string): Promise<{ ok: boolean; error?: string }> }
export type BrainService = { judge(call: ToolCall, mandate: Mandate, deadlineMs: number): Promise<{ decision: 'allow' | 'deny' | 'held'; reliedOn: string; reason: string } | 'timeout' | 'unavailable'>; wake(): void; ready(): boolean }
export type SupervisorService = { send(worktreeId: string, text: string): Promise<{ sent: boolean; reason?: string }>; stepIn(worktreeId: string, text: string): Promise<{ sent: boolean; reason?: string }>; startSession(worktreeId: string, note: string): Promise<{ sessionId: string | null; error?: string }>; restartWorker(worktreeId: string, note: string): Promise<{ sessionId: string | null; error?: string }>; park(worktreeId: string, story: string): void; recordDenial(worktreeId: string, countsAsDenial: boolean): void }
export type ShippingService = { runDoneWhen(worktreeId: string): Promise<{ pass: boolean; output: string }>; startReview(worktreeId: string): Promise<{ started: boolean; reason?: string }>; judgeFinding(worktreeId: string, findingId: string, valid: boolean, reason: string): Promise<void>; openPr(worktreeId: string): Promise<{ ok: boolean; reason?: string }>; merge(worktreeId: string): Promise<{ ok: boolean; reason?: string }>; mergeMainIn(worktreeId: string): Promise<{ ok: boolean; reason?: string }>; reconcileOutbox(): Promise<void>; cancelOutbox(worktreeId: string): number }
export type ReportService = { report(): ReportModel; status(): { handoffs: { worktreeId: string; name: string; state: WorktreeState; level: Level }[]; needsYouCount: number }; sidebarStatus(): Record<string, AvatarWorktreeStatus> }
export type AvatarServices = { gate: GateService; handoff: HandoffService; brain: BrainService; supervisor: SupervisorService; shipping: ShippingService; report: ReportService }
export type AvatarSettings = { defaultLevel: Level; switches: Switches; houseRules: string[]; allowCommands: string[]; denyCommands: string[]; deployCommands: string[]; brainAgent: AgentKind; brainModel: string | null; judgmentTimeoutSeconds: number }
export type AvatarApp = { context: PluginContext; store: AvatarStore; settings(): AvatarSettings; services: AvatarServices; journal(worktreeId: string | null, kind: JournalKind, data: Record<string, unknown>): JournalEntry; needs: NeedsQueue; on(listener: (e: AvatarBusEvent) => void): () => void; emit(e: AvatarBusEvent): void; now(): number }

/** Each module exports one of these; a returned function is its disposer. */
export type RegisterModule = (app: AvatarApp) => void | (() => void)

/** Props every avatar UI component receives; `onClose` is set only for the hand-off sheet. */
export type AvatarUiProps = { context: UiPluginContext; input?: unknown; onClose?: () => void }
