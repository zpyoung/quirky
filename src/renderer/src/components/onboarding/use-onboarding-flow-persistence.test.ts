import { describe, expect, it } from 'vitest'
import {
  buildCompletedOnboardingNotificationSettings,
  onboardingChatPermissionSetting
} from './use-onboarding-flow-persistence'

describe('onboarding flow persistence', () => {
  it('preserves explicit focus notification suppression when completing onboarding', () => {
    const notifications = buildCompletedOnboardingNotificationSettings({
      enabled: false,
      agentTaskComplete: false,
      terminalBell: false,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: false
    })

    expect(notifications).toEqual({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: false
    })
  })

  // Yolo mode says agents run without asking, chats included; a replay left untouched keeps them.
  it('sets new chats from a flipped Yolo mode, keeping a custom mode and an untouched replay', () => {
    const set = (mode: string) => ({ nativeChatPermissionMode: mode })
    expect(onboardingChatPermissionSetting('full-access', false, true)).toEqual(set('ask'))
    expect(onboardingChatPermissionSetting('ask', true, true)).toEqual(set('full-access'))
    expect(onboardingChatPermissionSetting('ask', true, false)).toEqual({})
    expect(onboardingChatPermissionSetting('auto', false, true)).toEqual({})
  })
})
