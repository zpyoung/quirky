export const PLUGIN_ID = 'quirky.notifications'
export const SETTINGS_VIEW_ID = `view:${PLUGIN_ID}/settings`

export const settingId = (name: SettingName) => `setting:${PLUGIN_ID}/${name}`

export const SUBTITLE = 'Native desktop notifications for agent activity and terminal events.'

export const SETTING_NAMES = [
  'enabled',
  'agentTaskComplete',
  'terminalBell',
  'terminalNotifications',
  'sound',
  'customSoundPath',
  'volume',
  'suppressWhenFocused',
  'showMenuBarIcon'
] as const

export type SettingName = (typeof SETTING_NAMES)[number]

export type Values = {
  enabled: boolean
  agentTaskComplete: boolean
  terminalBell: boolean
  terminalNotifications: boolean
  sound: string
  customSoundPath: string
  volume: number
  suppressWhenFocused: boolean
  showMenuBarIcon: boolean
}

export const DEFAULT_VALUES: Values = {
  enabled: true,
  agentTaskComplete: true,
  terminalBell: false,
  terminalNotifications: true,
  sound: 'system',
  customSoundPath: '',
  volume: 100,
  suppressWhenFocused: true,
  showMenuBarIcon: true
}

type SwitchName = Exclude<SettingName, 'sound' | 'customSoundPath' | 'volume'>

/** The switch rows in display order; the title and description repeat the manifest's declaration. */
export const SWITCH_ROWS: { name: SwitchName; title: string; description: string }[] = [
  { name: 'enabled', title: 'Enable Notifications', description: 'Native system notifications for background events.' },
  { name: 'agentTaskComplete', title: 'Agent Task Complete', description: 'A coding agent finishes or needs input.' },
  { name: 'terminalBell', title: 'Terminal Bell', description: 'A background terminal emits a bell character.' },
  { name: 'terminalNotifications', title: 'Terminal Notifications', description: 'A terminal program sends a notification (OSC 9, 99 or 777).' },
  { name: 'suppressWhenFocused', title: 'Suppress While Focused', description: 'Skip notifications when the triggering worktree is already visible.' },
  { name: 'showMenuBarIcon', title: 'Show Menu Bar Icon', description: 'Keep a Quirky shortcut and activity indicator in the macOS menu bar.' }
]

export const SOUND_ROW = {
  title: 'Notification Sound',
  description: 'Choose the alert Quirky plays when a desktop notification is delivered.'
}

export const BUILT_IN_SOUNDS: { value: string; label: string }[] = [
  { value: 'system', label: 'System Default' },
  { value: 'two-tone', label: 'Two Tone' },
  { value: 'bong', label: 'Bong' },
  { value: 'thump', label: 'Thump' },
  { value: 'blip', label: 'Blip' },
  { value: 'sonar', label: 'Sonar' },
  { value: 'blop', label: 'Blop' },
  { value: 'ding', label: 'Ding' },
  { value: 'clack', label: 'Clack' },
  { value: 'beep', label: 'Beep' }
]
