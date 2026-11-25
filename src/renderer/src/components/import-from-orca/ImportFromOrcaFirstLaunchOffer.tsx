import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { translate } from '@/i18n/i18n'
import { ImportFromOrcaReport } from './ImportFromOrcaReport'
import { useImportFromOrca } from './useImportFromOrca'
import { dismissImportOffer, useImportOfferStatus } from './import-from-orca-offer-state'

/** First-launch dialog offering to import from Orca Dev; shown before onboarding, only while Quirky has no repos and the source exists. */
export function ImportFromOrcaFirstLaunchOffer(): React.JSX.Element | null {
  const offered = useImportOfferStatus() === 'offered'
  const { running, report, run } = useImportFromOrca()

  const close = (): void => {
    if (running) {
      return
    }
    if (report?.ok) {
      window.location.reload()
      return
    }
    dismissImportOffer()
  }

  return (
    <Dialog open={offered} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.importFromOrca.offer.title',
              'Import your setup from Orca Dev?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.importFromOrca.offer.description',
              'Quirky found Orca Dev on this Mac. You can bring over your repos, worktrees, settings, keybindings, automations and linked accounts. Orca Dev is only read and stays unchanged, and automations arrive paused.'
            )}
          </DialogDescription>
        </DialogHeader>
        {report ? (
          <ImportFromOrcaReport report={report} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.importFromOrca.offer.keychainNote',
              "macOS will ask once for access to Orca Dev's keychain item so Quirky can re-encrypt your saved secrets."
            )}
          </p>
        )}
        <DialogFooter>
          {report ? (
            <Button onClick={close}>
              {report.ok
                ? translate('auto.components.importFromOrca.offer.reload', 'Reload Quirky')
                : translate('auto.components.importFromOrca.offer.close', 'Close')}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={running} onClick={close}>
                {translate('auto.components.importFromOrca.offer.notNow', 'Not now')}
              </Button>
              <Button disabled={running} onClick={() => void run('first-run')}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {running
                  ? translate('auto.components.importFromOrca.offer.running', 'Importing...')
                  : translate(
                      'auto.components.importFromOrca.offer.import',
                      'Import from Orca Dev'
                    )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
