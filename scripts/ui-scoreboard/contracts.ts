import type { CaptureTarget, CaptureTheme, ImageEvidence, ReviewerIdentity, VisualAssessment, CaptureManifest, CaptureOptions, ReviewOptions, ReviewReport, ModelFamily } from '../ui-review/contracts'

export const CHECK_IDS = ['compatibility-tokens', 'loading', 'empty', 'error', 'commands', 'screenshots'] as const
export type CheckId = typeof CHECK_IDS[number]
export type StaticCheckId = Exclude<CheckId, 'screenshots'>
export type SourceLocation = { file: string; line: number; column: number }
export type Evidence = {
  code: string; message: string; source?: SourceLocation
  basis?: 'scan' | 'source-audit' | 'rendered-review'
  sharedEvidence?: 'compatibility-tokens'; targetId?: string; theme?: CaptureTheme
  api?: string; cli?: string; component?: string
  coverageFile?: string
}
export type CheckResult = { id: CheckId; status: 'pass' | 'fail'; applicable: boolean; reason: string; evidence: Evidence[] }
export type SourceFile = { file: string; content: string }
export type Ref = { file: string; quote: string }
export type StateKind = 'loading' | 'empty' | 'error'
export type Decision = { applicable: true } | { applicable: false; reason: string; evidence: Ref[] }
export type Render =
  | { component: 'EmptyState' | 'NoticeLine' | 'InlineError' | 'FormRow'; element: Ref; import: Ref; via?: Ref[] }
  | { component: 'toast'; call: Ref; via?: Ref[] }
export type StateEntry = { surface: string; state: StateKind; site: Ref; anchor?: string; render: Render }
export type NotStateEntry = { site: Ref; anchor?: string; reason: string }
export type Route = { invoke: Ref; target: string; via?: Ref[] }
export type ActionEntry =
  | { site: Ref; anchor?: string; route: Route }
  | { site: Ref; anchor?: string; transient: 'caret' | 'hover' | 'draft'; reason: string }
  | { site: Ref; anchor?: string; notAction: 'lifecycle' | 'subscription' | 'forwarded'; reason: string }
export type CoverageFile = {
  schemaVersion: 1
  surfaces: Record<string, { loading: Decision; empty: Decision; error: Decision }>
  states: StateEntry[]
  notState: NotStateEntry[]
  actions: ActionEntry[]
}
export type CandidateCategory = 'state' | 'action'
export type Candidate = {
  category: CandidateCategory; kind: string; file: string
  anchorStart: number; anchorEnd: number; anchorText: string
}
export type CliCommandDeclaration = { id: string; words?: string; methods: string[] }
export type PluginContributions = { methods: string[]; commands: string[]; cliCommands: CliCommandDeclaration[] }
export type PluginInventory = {
  id: string; directory: string; hasUi: boolean; targets: string[]; sources: SourceFile[]
  contributions?: PluginContributions
  coverage?: SourceFile
  coverageFragments?: SourceFile[]
}
export type Exclusion = { plugin: string; reason: 'paused-unmerged'; branch: string; pr: 305; steerDate: '2026-11-13' }
export type Inventory = {
  repoRoot: string; commit: string; sourceDigest: string; dirty: boolean
  plugins: PluginInventory[]; targets: CaptureTarget[]; sharedSources: SourceFile[]
  exclusions: Exclusion[]; failures: Evidence[]
}
export type VisualCell = {
  targetId: string; plugin: string | null; theme: CaptureTheme
  status: 'pass' | 'fail'; code: string; reasons: string[]; score: number | null
  assessment: VisualAssessment | null; image: ImageEvidence | null; reference: ImageEvidence | null
  reviewer: ReviewerIdentity | null
}
export type VisualOptions = { outputDir: string; authorFamily: ModelFamily; reviewerAlias: string; browserExecutable?: string; signal?: AbortSignal; plugin?: string }
export type VisualDependencies = {
  capture: (options: CaptureOptions) => Promise<CaptureManifest>
  review: (manifest: CaptureManifest, options: ReviewOptions) => Promise<ReviewReport>
}
export type VisualResult = { cells: VisualCell[]; targets: CaptureTarget[]; failures: Evidence[]; operationalError: boolean }
export type StaticRatchet = Record<string, StaticCheckId[]>
export type RatchetResult = { exitCode: 0 | 1 | 2; failures: Evidence[] }
export type ScoreboardReport = {
  schemaVersion: 1; mode: 'full' | 'static-only' | 'plugin'; plugin?: string; commit: string; sourceDigest: string; threshold: 85
  status: 'passed' | 'failed' | 'error'; goalPassed: boolean
  plugins: Array<{ id: string; checks: CheckResult[]; targets: string[] }>
  host: { checks: CheckResult[]; targets: string[] }; cells: VisualCell[]
  sharedTokenEvidence: Evidence[]; exclusions: Exclusion[]; failures: Evidence[]
}
