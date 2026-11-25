import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { MobilePane } from './MobilePane'
import {
  getMobileOverviewSearchEntry,
  getMobileSidebarShortcutSearchEntry,
  getMobileSettingsPaneSearchEntries
} from './mobile-settings-search'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  QUIRKY_ANDROID_INSTALL_URL,
  QUIRKY_IOS_INSTALL_URL
} from '../../../../shared/mobile-install-links'
export { getMobileSettingsPaneSearchEntries }

export function MobileSettingsPane(): React.JSX.Element {
  const iosInstallUrl = QUIRKY_IOS_INSTALL_URL
  const showMobileButton = useAppStore((s) => s.settings?.showMobileButton !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="space-y-4">
      <SearchableSetting
        title={translate('auto.components.settings.MobileSettingsPane.e7a3ae8c4e', 'Mobile')}
        description={translate(
          'auto.components.settings.MobileSettingsPane.174f4a3c6d',
          'Control terminals and agents from your phone.'
        )}
        keywords={getMobileOverviewSearchEntry().keywords}
        className="space-y-3 py-2"
      >
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            {translate(
              'auto.components.settings.MobileSettingsPane.installIntro',
              'Install Quirky Mobile from the'
            )}{' '}
            {iosInstallUrl ? (
              <>
                <button
                  type="button"
                  onClick={() => void window.api.shell.openUrl(iosInstallUrl)}
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  {translate('auto.components.settings.MobileSettingsPane.b5a2ed83ff', 'App Store')}
                </button>
                {' · '}
              </>
            ) : null}
            <button
              type="button"
              // Why: Android is moving to Google Play soon, but until then
              // link directly to the pinned APK asset for the current mobile release.
              onClick={() => void window.api.shell.openUrl(QUIRKY_ANDROID_INSTALL_URL)}
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
            >
              {translate(
                'auto.components.settings.MobileSettingsPane.androidApkLabel',
                'Android APK'
              )}
            </button>
            {translate(
              'auto.components.settings.MobileSettingsPane.installOutro',
              ', then pair below.'
            )}
          </p>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.MobileSettingsPane.1de96ec8a6',
          'Show Quirky Mobile Button'
        )}
        description={translate(
          'auto.components.settings.MobileSettingsPane.682293cadf',
          'Show the Quirky Mobile button at the top of the left sidebar.'
        )}
        keywords={getMobileSidebarShortcutSearchEntry().keywords}
      >
        {/* Why: the in-page removal toast points users to Settings > Mobile. */}
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.MobileSettingsPane.1de96ec8a6',
            'Show Quirky Mobile Button'
          )}
          description={translate(
            'auto.components.settings.MobileSettingsPane.d4f2b65f30',
            'Show the Quirky Mobile shortcut in the sidebar.'
          )}
          checked={showMobileButton}
          onChange={() => updateSettings({ showMobileButton: !showMobileButton })}
        />
      </SearchableSetting>

      <div className="rounded-xl border border-border/60 bg-card/50 p-4">
        <MobilePane />
      </div>
    </div>
  )
}
