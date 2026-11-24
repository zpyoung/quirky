import { Badge } from '../ui/badge'
import { translate } from '../../i18n/i18n'
import { cn } from '@/lib/utils'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import { MobilePairingPathOption } from './MobilePairingPathOption'

export function MobilePairingConnectionOptions({
  value,
  onChange,
  compact = false
}: {
  value: MobilePairingConnectionMode
  onChange: (value: MobilePairingConnectionMode) => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('space-y-2', compact && 'space-y-1.5')}>
      <div
        role="radiogroup"
        aria-label={translate(
          'auto.components.settings.MobilePairingConnectionOptions.pathGroup',
          'How the phone reaches this computer'
        )}
        className="overflow-hidden rounded-md border border-border"
      >
        <MobilePairingPathOption
          selected={value === 'automatic'}
          tabIndex={-1}
          disabled
          positionInSet={1}
          setSize={2}
          onSelect={() => onChange('automatic')}
          title={translate(
            'auto.components.settings.MobilePairingConnectionOptions.anywhereTitle',
            'Orca Relay'
          )}
          description={translate(
            'auto.components.settings.MobilePairingConnectionOptions.relayUnavailable',
            'Orca Relay isn’t available in this build. Use LAN.'
          )}
          trailing={
            <Badge variant="outline" className="text-[11px]">
              {translate(
                'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                'Unavailable'
              )}
            </Badge>
          }
        />
        <div className="border-t border-border" />
        <MobilePairingPathOption
          selected={value === 'local-only'}
          tabIndex={0}
          positionInSet={2}
          setSize={2}
          onSelect={() => onChange('local-only')}
          title={translate(
            'auto.components.settings.MobilePairingConnectionOptions.localTitle',
            'LAN'
          )}
          description={translate(
            'auto.components.settings.MobilePairingConnectionOptions.localDescription',
            'Phone must be on this Wi‑Fi or connected through Tailscale. No account needed.'
          )}
        />
      </div>
    </div>
  )
}
