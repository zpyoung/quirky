import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  SkillInstallFailureSchema,
  type SkillInstallFailure
} from '../../shared/skill-install-failure'

export class SkillInstallOperationError extends Error {
  readonly code = SKILL_INSTALL_RPC_ERROR_CODE
  readonly data: SkillInstallFailure

  constructor(failure: SkillInstallFailure, options?: ErrorOptions) {
    super(failure.code, options)
    this.name = 'SkillInstallOperationError'
    this.data = SkillInstallFailureSchema.parse(failure)
  }
}
