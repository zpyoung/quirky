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
}
export type CheckResult = { id: CheckId; status: 'pass' | 'fail'; applicable: boolean; reason: string; evidence: Evidence[] }
export type SourceFile = { file: string; content: string }
export type PluginInventory = { id: string; directory: string; hasUi: boolean; targets: string[]; sources: SourceFile[] }
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
export type VisualOptions = { outputDir: string; authorFamily: ModelFamily; reviewerAlias: string; browserExecutable?: string; signal?: AbortSignal }
export type VisualDependencies = {
  capture: (options: CaptureOptions) => Promise<CaptureManifest>
  review: (manifest: CaptureManifest, options: ReviewOptions) => Promise<ReviewReport>
}
export type VisualResult = { cells: VisualCell[]; targets: CaptureTarget[]; failures: Evidence[]; operationalError: boolean }
export type StaticRatchet = Record<string, StaticCheckId[]>
export type RatchetResult = { exitCode: 0 | 1 | 2; failures: Evidence[] }
export type ScoreboardReport = {
  schemaVersion: 1; mode: 'full' | 'static-only'; commit: string; sourceDigest: string; threshold: 85
  status: 'passed' | 'failed' | 'error'; goalPassed: boolean
  plugins: Array<{ id: string; checks: CheckResult[]; targets: string[] }>
  host: { checks: CheckResult[]; targets: string[] }; cells: VisualCell[]
  sharedTokenEvidence: Evidence[]; exclusions: Exclusion[]; failures: Evidence[]
}
