import { BadgeCheck, Check, Loader2 } from 'lucide-react'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing
} from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { PluginCatalogAvatar } from '../plugin-catalog/PluginCatalogAvatar'
import { pluginDisplayNameFromKey } from '../plugin-catalog/plugin-display-name'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

type PluginMarketplaceListingRowProps = {
  listing: PluginMarketplaceHostListing
  installed: PluginHostListEntry | null
  busy: boolean
  onPreview: (listing: PluginMarketplaceHostListing, update: boolean) => void
}

export function PluginMarketplaceListingRow({
  listing,
  installed,
  busy,
  onPreview
}: PluginMarketplaceListingRowProps): React.JSX.Element {
  const canCheckUpdate = installed?.source?.kind === 'marketplace'
  const name = pluginDisplayNameFromKey(listing.pluginKey)
  return (
    <article
      className="flex min-h-36 flex-col rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-xs transition-colors hover:border-border"
      data-marketplace-plugin-key={listing.pluginKey}
    >
      <div className="flex items-start gap-3">
        <PluginCatalogAvatar name={name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-sm font-semibold">{name}</h4>
            {listing.official ? (
              <BadgeCheck
                className="plugin-security-chrome size-4 shrink-0 text-muted-foreground"
                role="img"
                aria-label={translate(
                  'auto.components.settings.PluginMarketplaceListingRow.official',
                  'Official'
                )}
              />
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={listing.pluginKey}>
            {listing.marketplaceOwner}
          </p>
        </div>
        {installed ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Check className="size-3.5" aria-hidden="true" />
            {translate(
              'auto.components.settings.PluginMarketplaceListingRow.installed',
              'Installed'
            )}
          </span>
        ) : null}
      </div>

      <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
        {listing.description ??
          translate(
            'auto.components.settings.PluginMarketplaceListingRow.noDescription',
            'No description provided.'
          )}
      </p>

      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-3">
        <div className="flex min-w-0 flex-wrap gap-1">
          {listing.categories.slice(0, 3).map((category) => (
            <Badge key={category} variant="outline" className="text-[10px] text-muted-foreground">
              {category}
            </Badge>
          ))}
        </div>
        {canCheckUpdate ? (
          <Button
            variant="outline"
            size="sm"
            className="w-40"
            disabled={busy}
            onClick={() => onPreview(listing, true)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {translate(
              'auto.components.settings.PluginMarketplaceListingRow.checkUpdate',
              'Check for update'
            )}
          </Button>
        ) : installed ? null : (
          <Button
            variant="outline"
            size="sm"
            className="w-28"
            disabled={busy}
            onClick={() => onPreview(listing, false)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.settings.PluginMarketplaceListingRow.install', 'Install')}
          </Button>
        )}
      </div>
    </article>
  )
}
