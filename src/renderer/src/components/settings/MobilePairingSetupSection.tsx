import { Loader2, QrCode, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import { NetworkInterfacePicker } from '../mobile/NetworkInterfacePicker'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'

type MobilePairingSetupSectionProps = {
  networkInterfaces: MobileNetworkInterface[]
  customAddresses: readonly string[]
  selectedAddress: string | undefined
  selectedAddressIsCustom: boolean
  onSelectedAddressChange: (address: string) => void
  onCustomAddressSelect: (address: string) => void
  onCustomAddressRemove: (address: string) => void
  refreshingNetworkInterfaces: boolean
  onRefreshNetworkInterfaces: () => void
  loading: boolean
  hasQrCode: boolean
  onGenerateQr: () => void
}

export function MobilePairingSetupSection({
  networkInterfaces,
  customAddresses,
  selectedAddress,
  selectedAddressIsCustom,
  onSelectedAddressChange,
  onCustomAddressSelect,
  onCustomAddressRemove,
  refreshingNetworkInterfaces,
  onRefreshNetworkInterfaces,
  loading,
  hasQrCode,
  onGenerateQr
}: MobilePairingSetupSectionProps): React.JSX.Element {
  const generateDisabled = loading || !selectedAddress

  const addressControls = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <NetworkInterfacePicker
          networkInterfaces={networkInterfaces}
          customAddresses={customAddresses}
          selectedAddress={selectedAddress}
          selectedAddressIsCustom={selectedAddressIsCustom}
          onSelectedAddressChange={onSelectedAddressChange}
          onCustomAddressSelect={onCustomAddressSelect}
          onCustomAddressRemove={onCustomAddressRemove}
          className="min-w-[220px] justify-between font-normal"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onRefreshNetworkInterfaces}
              disabled={refreshingNetworkInterfaces}
              aria-label={translate(
                'auto.components.settings.MobilePairingSetupSection.refresh',
                'Refresh network interfaces'
              )}
              className="text-muted-foreground"
            >
              <RefreshCw className={refreshingNetworkInterfaces ? 'animate-spin' : ''} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.settings.MobilePairingSetupSection.refresh',
              'Refresh network interfaces'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.MobilePairingSetupSection.step2LocalDescription',
          'The phone must be able to reach this address on Tailscale or Wi‑Fi.'
        )}
      </p>
    </div>
  )

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate('auto.components.settings.MobilePairingSetupSection.title', 'Pair a phone')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.MobilePairingSetupSection.overview',
            'Generate a QR code, then scan it in Quirky Mobile under Pair Desktop.'
          )}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">
          {translate(
            'auto.components.settings.MobilePairingSetupSection.step2Title',
            'This computer’s address'
          )}
        </p>
        {addressControls}
      </div>

      <div className="space-y-2">
        <Button onClick={onGenerateQr} disabled={generateDisabled} size="sm" className="gap-1.5">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : hasQrCode ? (
            <RefreshCw className="size-3.5" />
          ) : (
            <QrCode className="size-3.5" />
          )}
          {hasQrCode
            ? translate(
                'auto.components.settings.MobilePairingSetupSection.regenerate',
                'Regenerate QR code'
              )
            : translate(
                'auto.components.settings.MobilePairingSetupSection.generate',
                'Generate QR code'
              )}
        </Button>
      </div>
    </section>
  )
}
