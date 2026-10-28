/** Shared daemon/UI contracts for orchestration setup; no caller-supplied authority. */
export type SkillCoverageState = 'ready' | 'missing' | 'stale' | 'unsupported' | 'error'
export interface OrchestrationSkillAgent {
  id: string
  label: string
  state: SkillCoverageState
  path: string | null
  detail: string | null
}
export interface OrchestrationSkillStatus {
  state: 'missing' | 'stale' | 'ready' | 'partial' | 'error'
  agents: readonly OrchestrationSkillAgent[]
  installCommand: string
  text: string
}
export interface OrchestrationPolicy {
  nestedWorkerMaxDepth: number
  canChange: boolean
}
export interface OrchestrationSkillInstallParams {
  /** Explicit agent IDs; absent means all detected agents with supported skill targets. */
  agents?: string[]
}
export interface OrchestrationPolicySetParams {
  nestedWorkerMaxDepth: number
}
