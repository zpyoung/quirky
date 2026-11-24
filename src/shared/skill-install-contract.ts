import type { SkillInstallFailure } from './skill-install-failure'

export type SkillPlacementResult = {
  provider: string
  path: string
  topology: 'canonical-copy' | 'provider-alias' | 'independent-copy'
  status: 'installed' | 'unchanged' | 'removed' | 'skipped' | 'failed'
  errorCategory?: string
  failure?: SkillInstallFailure
}
