import type { PreloadApi } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { noopUnsubscribe } from './web-storage'

export function createUpdaterApi(): NonNullable<Partial<PreloadApi>['updater']> {
  return {
    getVersion: () => Promise.resolve('web'),
    getStatus: () => Promise.resolve({ state: 'idle' } as never),
    check: () => Promise.resolve(),
    download: () => Promise.resolve(),
    quitAndInstall: () => Promise.resolve(),
    dismissAvailableUpdate: () => Promise.resolve(),
    // Why: the web client cannot install a desktop build, so channel switching
    // reports unavailable rather than an empty list that looks like a fetch miss.
    listBuilds: (channel) =>
      Promise.resolve({
        ok: false,
        channel,
        message: translate(
          'auto.components.settings.ReleaseChannelSection.webUnavailable',
          'Switching builds is only available in the desktop app.'
        )
      }),
    onStatus: () => noopUnsubscribe
  }
}
