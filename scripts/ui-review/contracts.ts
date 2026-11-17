/** Shared developer-tool contracts; no app runtime imports or side effects. */
export const CAPTURE_SCHEMA_VERSION = 1 as const
export const THEMES = ['dark', 'light'] as const
export const SCORE_DIMENSIONS = ['palette', 'typography', 'spacing', 'components', 'hierarchy'] as const
export type CaptureTheme = typeof THEMES[number]
export type ScoreDimension = typeof SCORE_DIMENSIONS[number]
export type ModelFamily = 'openai' | 'anthropic' | 'google' | 'xai'
export type CaptureTarget = {
  id: string
  plugin: string | null
  title: string
  kind: 'host' | 'panel' | 'view' | 'sidebar-section' | 'activity-item' | 'status-bar' | 'overlay' | 'settings-section'
}
export type ToolNavigationAlias = {
  declaration: CaptureTarget
  toolId: string
  renderedTarget: CaptureTarget
  reason: 'tool-navigation-alias'
}
export type ContributionInventory = {
  declaredTargets: CaptureTarget[]
  toolAliases: ToolNavigationAlias[]
}
export type ImageEvidence = { path: string; sha256: string }
export type CaptureEvidence = {
  targetId: string
  theme: CaptureTheme
  image: ImageEvidence | null
  /** The approved golden this capture is scored against; `goldenFor` picks it per target. */
  reference: ImageEvidence
  status: 'captured' | 'failed'
  error?: string
}
export type CaptureManifest = {
  schemaVersion: typeof CAPTURE_SCHEMA_VERSION
  createdAt: string
  commit: string
  surface: 'desktop-renderer'
  viewport: { width: number; height: number }
  scope: 'full' | 'filtered'
  selectors: string[]
  targets: CaptureTarget[]
  captures: CaptureEvidence[]
  failures: string[]
  contributionInventory?: ContributionInventory
  activatedVisibilitySettings?: string[]
}
export type CaptureOptions = {
  repoRoot: string
  outputDir: string
  only: string[]
  skipBuild: boolean
  browserExecutable?: string
  /** Themes to capture; defaults to both. A subset cannot be reviewed, so only diagnostics should narrow it. */
  themes?: readonly CaptureTheme[]
  timeoutMs: number
  signal?: AbortSignal
  /** Test-only bound for overlay visibility waits. */
  overlayOpenMs?: number
}
export type ReviewCellKey = { targetId: string; theme: CaptureTheme }
export type ContractRule = { id: string; source: string; text: string }
export type HostContractContext = {
  schemaVersion: 1
  targetId: string
  theme: CaptureTheme
  rules: ContractRule[]
}
export type ContractAudit = {
  contextSha256: string
  acknowledgedRuleIds: string[]
  reasonChecks: {
    reasonIndex: number
    contractIds: string[]
    conflictsWithContract: boolean
    affectsScore: boolean
  }[]
  conflicts: { contractId: string; reason: string; affectsScore: boolean }[]
}
export type ContractAwareResponse = { assessment: VisualAssessment; contractAudit: ContractAudit }
export type ContractReviewEvidence = {
  contextPath: string
  contextSha256: string
  audit: ContractAudit
}
export type ReviewIssue = {
  targetId?: string
  theme?: CaptureTheme
  code: 'operational' | 'response-shape' | 'invalid-sample' | 'contract-conflict' |
    'evidence-changed' | 'identity-mismatch' | 'persistence' | 'aborted' | 'usage-limit'
  message: string
}
export type ReviewOptions = {
  outputDir: string
  reviewerAlias: string
  authorFamily: ModelFamily
  threshold: number
  timeoutMs: number
  /** Explicit executable override for local installs and isolated subprocess tests. */
  reviewerExecutable?: string
  signal?: AbortSignal
  /** Internal retry selection; the full manifest and all evidence are still validated. */
  onlyCells?: readonly ReviewCellKey[]
}
export type ReviewerIdentity = { alias: string; provider: string; model: string; family: ModelFamily }
export type VisualAssessment = {
  targetVisible: boolean
  imagesRead: boolean
  scores: Record<ScoreDimension, number>
  reasons: string[]
}
export type ReviewedCapture = {
  targetId: string
  theme: CaptureTheme
  image: ImageEvidence
  reference: ImageEvidence
  reviewer: ReviewerIdentity
  assessment: VisualAssessment
  score: number
  passed: boolean
  contractReview?: ContractReviewEvidence
}
export type ReviewReport = {
  schemaVersion: 1
  createdAt: string
  status: 'passed' | 'failed' | 'error'
  scope: CaptureManifest['scope']
  threshold: number
  authorFamily: ModelFamily
  reviewerAlias: string
  captures: ReviewedCapture[]
  failures: string[]
  issues?: ReviewIssue[]
  selectedCells?: ReviewCellKey[]
}

/** capture.ts exports: captureApplication(options: CaptureOptions): Promise<CaptureManifest>.
 * review.ts exports: reviewManifest(manifest: CaptureManifest, options: ReviewOptions): Promise<ReviewReport>.
 * Both honor AbortSignal, bound operations, preserve partial evidence, and never silently skip failures.
 */
