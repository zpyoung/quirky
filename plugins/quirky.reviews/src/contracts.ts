import type { MethodHandler, PluginCaller, PluginContext, Schema, UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'

export const REVIEW_VIEW = 'view:quirky.reviews/review'
export const CHECKS_PANEL = 'panel:quirky.reviews/checks'
export const CREATE_VIEW = 'view:quirky.reviews/create'
export const SETTINGS_VIEW = 'view:quirky.reviews/settings'
export type ReviewTab = 'conversation' | 'checks' | 'files'
export type ReviewTarget = { worktree: string; number: number; tab?: ReviewTab; prRepo?: { host: string; owner: string; repo: string } }
export type Audience = 'all' | 'humans' | 'bots'
export type JsonRecord = Record<string, unknown>
export type ReviewData = {
  provider: string; number: number; url: string; title: string; body: string
  state: 'open' | 'draft' | 'closed' | 'merged'; headRefName: string; baseRefName: string
  headRefOid: string; baseRefOid: string; mergeable: string; checksStatus: string
  reviewDecision: string; mergeStateStatus: string; autoMergeRequest: unknown; stack: unknown; mergeMethods: unknown
  mergeQueueRequired?: boolean | null; autoMergeAllowed?: boolean | null; mergeMetadataKnown?: boolean
  [key: string]: unknown
}
export type DetailState = {
  target: ReviewTarget | null; tab: ReviewTab; generation: number; loading: boolean; error: string | null
  review: ReviewData | null; details: JsonRecord | null; checks: JsonRecord | null; comments: JsonRecord | null; files: JsonRecord | null
  audience: Audience; grouping: 'grouped' | 'timeline'; expandedChecks: string[]; queuedComments: string[]
  checksCollapsed: boolean
  selectedFile: string | null; diffMode: 'inline' | 'side-by-side'; collapsedFiles: string[]; fileFilter: string; fileTreeVisible: boolean
  commentDraft: string; bodyDraft: string | null; pending: string[]; fetchedAt: number
}
export type ChecksState = {
  worktree: string | null; generation: number; loading: boolean; error: string | null
  lookup: JsonRecord | null; eligibility: JsonRecord | null; review: ReviewData | null
  checks: JsonRecord | null; comments: JsonRecord | null; conflicts: JsonRecord | null
  audience: Audience; grouping: 'grouped' | 'timeline'; expandedChecks: string[]; queuedComments: string[]
  checksCollapsed: boolean
  commentDraft: string; titleDraft: string | null; height: number; fetchedAt: number
  agentDialog: { action: 'fix' | 'conflicts' | 'comments'; prompt: string; agent?: string; args?: string; surface?: 'detail' | 'checks'; target?: ReviewTarget; headOid?: string; visible?: boolean } | null
}
export type CreationDefaults = { draft: boolean; useTemplate: boolean; generateDetailsOnOpen: boolean; openAfterCreate: boolean }
export type CreationState = {
  worktree: string | null; generation: number; loading: boolean; error: string | null; eligibility: JsonRecord | null
  title: string; body: string; base: string; head: string; draft: boolean; useTemplate: boolean
  bases: string[]; generating: boolean; requestId: string | null; submitting: boolean; generated: boolean
  result: JsonRecord | null; defaults: CreationDefaults
}
export type HostingSettingsState = {
  worktree: string | null; generation: number; loading: boolean; error: string | null
  diagnostics: JsonRecord | null; accounts: JsonRecord | null; configuration: JsonRecord | null; budget: JsonRecord | null; fetchedAt: number
}
export type ReviewsState = {
  revision: number; previousView: UiLayout['view']; detail: DetailState; checks: ChecksState; creation: CreationState
  settings: HostingSettingsState
  defaults: CreationDefaults; repoDefaults: Record<string, Partial<CreationDefaults>>
  botOverrides: string[]; links: Record<string, { number: number; url: string }>; suppressed: Record<string, { number: number; url: string }>
}
export type MethodSpec = {
  id: string; description?: string; readOnly?: boolean; destructive?: boolean; confirm?: string; describe?: string
  params: Schema; result: Schema
}
export type ReviewsEnv = {
  context: PluginContext
  read(): ReviewsState
  /** Atomic, synchronous: increment revision, persist durable defaults/links/suppression and emit changed. */
  update(change: (state: ReviewsState) => void): ReviewsState
  /** Resolve through quirky.worktree/resolve, preserving caller cwd/worktree selection. */
  resolve(params: JsonRecord, caller: PluginCaller): Promise<Worktree>
  /** Safe classified RPC error with data.reason; never return upstream secrets. */
  invalid(reason: string, message: string): Error
  /** Invoke the shared public API without a private sibling import. */
  call(method: string, params?: JsonRecord): Promise<unknown>
  /** Captures prior non-review view on first open and updates daemon layout. */
  openView(id: string, input?: JsonRecord): Promise<void>
  closeView(): Promise<void>
  /** Deliver a declared window command; propagate no-window/clipboard/browser errors. */
  windowCommand(id: string, args: JsonRecord): Promise<unknown>
  onDispose(callback: () => void | Promise<void>): void
}
export type ReviewsSurfaceProps = { context: UiPluginContext; state: ReviewsState; refresh(): Promise<void> }
export type ReviewMethodTable = Record<string, MethodHandler>

// Slice contracts (disjoint write ownership):
// detail/methods.ts exports detailMethods(env): ReviewMethodTable and detailSpecs: MethodSpec[].
// detail/ReviewPage.tsx exports ReviewPage(props: ReviewsSurfaceProps).
// detail/Comments.tsx exports Comments(props: ReviewsSurfaceProps & { surface: 'detail' | 'checks' }).
// detail/ChecksList.tsx exports ChecksList(props: ReviewsSurfaceProps & { surface: 'detail' | 'checks' }).
// detail/Actions.tsx exports ReviewActions(props: ReviewsSurfaceProps & { surface: 'detail' | 'checks' }).
// checks/methods.ts exports checksMethods(env): ReviewMethodTable and checksSpecs: MethodSpec[].
// checks/ChecksPanel.tsx exports ChecksPanel(props: ReviewsSurfaceProps).
// create/methods.ts exports createMethods(env): ReviewMethodTable and createSpecs: MethodSpec[].
// create/CreateReview.tsx exports CreateReview(props: ReviewsSurfaceProps).
// create/HostingSettings.tsx exports HostingSettings(props: ReviewsSurfaceProps).
// Parent owns env.ts, main.ts, src/ui.tsx, manifest/package/build integration and test/support.ts.
