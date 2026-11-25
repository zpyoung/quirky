import type { ReactNode } from 'react'
import { LifeBuoy } from 'lucide-react-native'
import { MobileSettingsFrame, MobileSettingsSection } from './mobile-settings-menu'
import { mobileSettingsMenuItems } from './mobile-settings-menu-items'

export default function SettingsMenuScreen({
  push,
  onBack,
  openExternal,
  children
}: {
  push: (route: string) => void
  onBack?: () => void
  openExternal: (url: string) => Promise<unknown>
  children?: ReactNode
}) {
  return (
    <MobileSettingsFrame onBack={onBack}>
      <MobileSettingsSection items={mobileSettingsMenuItems(push)} />

      {children}

      <MobileSettingsSection
        spaced
        items={[
          {
            label: 'Support',
            icon: LifeBuoy,
            external: true,
            onPress: () => void openExternal('https://github.com/zpyoung/quirky/issues')
          }
        ]}
      />
    </MobileSettingsFrame>
  )
}
