import type { ImportErrorCode } from '../../shared/import-from-orca-types'

/** A failure the importer reports by code instead of letting it surface as an exception. */
export class ImportFailure extends Error {
  readonly code: ImportErrorCode

  constructor(code: ImportErrorCode, message: string) {
    super(message)
    this.name = 'ImportFailure'
    this.code = code
  }
}
