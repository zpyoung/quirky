import type React from 'react'
import type { ImportErrorCode, ImportReport } from '../../../../shared/import-from-orca-types'
import { translate } from '@/i18n/i18n'

function errorCopy(code: ImportErrorCode): string {
  switch (code) {
    case 'SOURCE_MISSING':
      return translate(
        'auto.components.importFromOrca.error.sourceMissing',
        'Orca Dev data was not found on this Mac.'
      )
    case 'SOURCE_INCOMPATIBLE':
      return translate(
        'auto.components.importFromOrca.error.sourceIncompatible',
        "Orca Dev's data could not be read by this version of Quirky."
      )
    case 'KEYCHAIN_DENIED':
      return translate(
        'auto.components.importFromOrca.error.keychainDenied',
        'Access to the Orca Dev keychain item was denied, so secrets were not imported.'
      )
    case 'WRITE_FAILED':
      return translate(
        'auto.components.importFromOrca.error.writeFailed',
        'The import failed and everything it wrote was rolled back.'
      )
  }
}

/** Summarizes what an import did: counts per domain, skipped secrets, which keychain item worked, and what was left out. */
export function ImportFromOrcaReport({ report }: { report: ImportReport }): React.JSX.Element {
  const importedEntries = Object.entries(report.imported).filter(([, count]) => count > 0)
  const normalizedEntries = Object.entries(report.normalizedAway)
  return (
    <div className="space-y-2 text-sm" data-testid="import-from-orca-report">
      <p className="font-medium">
        {report.ok
          ? translate('auto.components.importFromOrca.report.done', 'Import finished.')
          : translate('auto.components.importFromOrca.report.failed', 'Import did not finish.')}
      </p>
      {report.errors.map((error) => (
        <p key={`${error.code}:${error.message}`} className="text-muted-foreground">
          {errorCopy(error.code)}
        </p>
      ))}
      {report.ok && importedEntries.length === 0 ? (
        <p className="text-muted-foreground">
          {translate('auto.components.importFromOrca.report.nothingNew', 'Nothing new to import.')}
        </p>
      ) : null}
      {importedEntries.length > 0 ? (
        <div>
          <p className="text-muted-foreground">
            {translate('auto.components.importFromOrca.report.imported', 'Imported')}
          </p>
          <ul className="list-disc pl-5">
            {importedEntries.map(([domain, count]) => (
              <li key={domain}>
                <code>{domain}</code>: {count}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.keychainItem === 'primary' ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.importFromOrca.report.keychainPrimary',
            'Secrets were unlocked with the Orca Dev keychain item.'
          )}
        </p>
      ) : null}
      {report.keychainItem === 'fallback' ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.importFromOrca.report.keychainFallback',
            'Secrets were unlocked with the fallback Orca Dev keychain item.'
          )}
        </p>
      ) : null}
      {report.skippedSecrets.length > 0 ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.importFromOrca.report.skippedSecrets',
            'Secrets skipped: {{value0}}',
            { value0: report.skippedSecrets.join(', ') }
          )}
        </p>
      ) : null}
      {report.copiedFiles.length > 0 ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.importFromOrca.report.copiedFiles',
            'Copied files and account folders: {{value0}}',
            { value0: report.copiedFiles.join(', ') }
          )}
        </p>
      ) : null}
      {normalizedEntries.length > 0 ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.importFromOrca.report.leftOut',
            'Left out because Quirky no longer supports them: {{value0}}',
            {
              value0: normalizedEntries.map(([domain, count]) => `${domain} (${count})`).join(', ')
            }
          )}
        </p>
      ) : null}
      {report.notImported.length > 0 ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.importFromOrca.report.notImported',
            'Not imported by this version: {{value0}}',
            { value0: report.notImported.join(', ') }
          )}
        </p>
      ) : null}
    </div>
  )
}
