import type { Platform } from './MobileHero'
import { translate } from '@/i18n/i18n'
import {
  QUIRKY_ANDROID_INSTALL_URL,
  QUIRKY_IOS_INSTALL_URL
} from '../../../../shared/mobile-install-links'

// iOS ships two App Store tracks: the public App Store build (slower, ~weekly)
// and the TestFlight preview build (daily). Android only ships one APK track.
export type IosChannel = 'stable' | 'preview'

export type InstallCopy = { ctaLabel: string; url: string | null }

export const ANDROID_INSTALL_GUIDE_URL = QUIRKY_ANDROID_INSTALL_URL

const IOS_CHANNEL_COPY: Record<IosChannel, InstallCopy> = {
  stable: {
    ctaLabel: 'Open App Store',
    url: QUIRKY_IOS_INSTALL_URL
  },
  preview: {
    ctaLabel: 'Open TestFlight',
    url: QUIRKY_IOS_INSTALL_URL
  }
}

const ANDROID_COPY: InstallCopy = {
  ctaLabel: 'Download APK',
  url: QUIRKY_ANDROID_INSTALL_URL
}

export function getInstallCopy(platform: Platform, iosChannel: IosChannel): InstallCopy {
  return platform === 'ios' ? IOS_CHANNEL_COPY[iosChannel] : ANDROID_COPY
}

export function getChannelTagline(iosChannel: IosChannel): string {
  return iosChannel === 'preview'
    ? translate(
        'auto.components.mobile.mobile.platform.copy.preview.tagline',
        'Newest features, updated daily.'
      )
    : translate(
        'auto.components.mobile.mobile.platform.copy.stable.tagline',
        'The public release, updated weekly.'
      )
}
