import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { SearchableSetting } from '../settings/SearchableSetting'
import { SettingsSubsectionHeader } from '../settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { ImportFromOrcaReport } from './ImportFromOrcaReport'
import { useImportFromOrca } from './useImportFromOrca'

/** Settings → General action that re-runs the Orca Dev import, adding only what is new. */
export function ImportFromOrcaSettingsSection(): React.JSX.Element {
  const { running, report, run } = useImportFromOrca()
  const title = translate('auto.components.importFromOrca.settings.title', 'Import from Orca Dev')
  const description = translate(
    'auto.components.importFromOrca.settings.description',
    'Bring over anything new from Orca Dev. Items you removed in Quirky stay removed, and nothing in Quirky is deleted.'
  )
  return (
    <section key="import-from-orca" className="space-y-4">
      <SettingsSubsectionHeader title={title} description={description} />
      <SearchableSetting title={title} description={description} className="space-y-3">
        <Button variant="outline" size="sm" disabled={running} onClick={() => void run('rerun')}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {running
            ? translate('auto.components.importFromOrca.settings.running', 'Importing...')
            : title}
        </Button>
        {report ? <ImportFromOrcaReport report={report} /> : null}
      </SearchableSetting>
    </section>
  )
}
