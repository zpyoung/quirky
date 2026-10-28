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
export type ImageEvidence = { path: string; sha256: string }
export type CaptureEvidence = {
  targetId: string
  theme: CaptureTheme
  image: ImageEvidence | null
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
  references: Record<CaptureTheme, ImageEvidence>
  captures: CaptureEvidence[]
  failures: string[]
}
export type CaptureOptions = {
  repoRoot: string
  outputDir: string
  only: string[]
  skipBuild: boolean
  browserExecutable?: string
  timeoutMs: number
  signal?: AbortSignal
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
}

/** capture.ts exports: captureApplication(options: CaptureOptions): Promise<CaptureManifest>.
 * review.ts exports: reviewManifest(manifest: CaptureManifest, options: ReviewOptions): Promise<ReviewReport>.
 * Both honor AbortSignal, bound operations, preserve partial evidence, and never silently skip failures.
 */
