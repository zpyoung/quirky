import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { applyAgentPermissionMode } from '../../../shared/tui-agent-permissions'

// Simulates a profile created before the dedicated Experimental switch was persisted.
function normalizeLegacyProfile(overrides: Record<string, unknown>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const settings: Partial<GlobalSettings> = { ...defaults.settings }
  delete settings.experimentalActivity
  delete settings.experimentalAgentDashboardPopout
  Object.assign(settings, overrides)
  const parsed: PersistedState = { ...defaults, settings: settings as GlobalSettings }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

describe('retired setup placement', () => {
  it.each(['split-vertical', 'split-horizontal', 'new-tab', undefined])(
    'drops saved setup location %s without changing terminal preferences',
    (setupScriptLaunchMode) => {
      const normalized = normalizeLegacyProfile({
        setupScriptLaunchMode,
        terminalFocusFollowsMouse: true
      })
      expect(normalized).not.toHaveProperty('setupScriptLaunchMode')
      expect(normalized.terminalFocusFollowsMouse).toBe(true)
    }
  )
})

describe('retired Agents sidebar setting', () => {
  it('does not mark new profiles as migrated', () => {
    expect(normalizeLegacyProfile({}).agentsSidebarMigratedFromExperimental).toBe(false)
  })

  it('drops the old visibility setting while preserving migration metadata', () => {
    const normalized = normalizeLegacyProfile({
      experimentalActivity: true,
      showAgentsSidebar: false
    })
    expect('showAgentsSidebar' in normalized).toBe(false)
    expect(normalized.agentsSidebarMigratedFromExperimental).toBe(true)
  })
})

describe('retired managed servers experiment', () => {
  it('drops the stored toggle, since managed servers are the default SSH path', () => {
    expect('experimentalManagedServers' in normalizeLegacyProfile({})).toBe(false)
    expect(
      'experimentalManagedServers' in normalizeLegacyProfile({ experimentalManagedServers: true })
    ).toBe(false)
  })
})

describe('retired hosted relay pairing mode', () => {
  it('drops the stored connection mode, since pairing is LAN-only', () => {
    expect('mobilePairingConnectionMode' in normalizeLegacyProfile({})).toBe(false)
    expect(
      'mobilePairingConnectionMode' in
        normalizeLegacyProfile({ mobilePairingConnectionMode: 'automatic' })
    ).toBe(false)
  })
})

describe('retired chat default selectors', () => {
  it('keeps Chat UI on while dropping both older keys from a saved profile', () => {
    const normalized = normalizeLegacyProfile({
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: true
    })
    expect(normalized.experimentalNativeChat).toBe(true)
    expect(normalized).not.toHaveProperty('experimentalStructuredNativeChat')
    expect(normalized).not.toHaveProperty('openAgentTabsInChatByDefault')
  })

  it('turns Chat UI off when new tabs opened in the terminal, dropping both older keys', () => {
    const normalized = normalizeLegacyProfile({
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: false
    })
    expect(normalized.experimentalNativeChat).toBe(false)
    expect(normalized).not.toHaveProperty('experimentalStructuredNativeChat')
    expect(normalized).not.toHaveProperty('openAgentTabsInChatByDefault')
  })
})

describe('structured chat shell environment settings', () => {
  it('keeps a valid saved list and an explicit opt-out', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatInheritShellEnvironment: false,
      nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'CODEX_LB_API_KEY']
    })
    expect(normalized.nativeChatInheritShellEnvironment).toBe(false)
    expect(normalized.nativeChatShellEnvironmentVariables).toEqual([
      'HTTPS_PROXY',
      'CODEX_LB_API_KEY'
    ])
  })

  it('degrades a malformed hand-edited value to the defaults instead of failing a chat', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatInheritShellEnvironment: 'no',
      nativeChatShellEnvironmentVariables: 'HTTPS_PROXY, CODEX_LB_API_KEY'
    })
    expect(normalized.nativeChatInheritShellEnvironment).toBe(true)
    expect(normalized.nativeChatShellEnvironmentVariables).toEqual([])
  })

  it('drops non-string and invalid entries from a saved list', () => {
    expect(
      normalizeLegacyProfile({
        nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 7, null, 'not valid', 'HTTPS_PROXY']
      }).nativeChatShellEnvironmentVariables
    ).toEqual(['HTTPS_PROXY'])
  })
})

describe('machine name setting', () => {
  it('trims persisted names and defaults missing legacy values to automatic detection', () => {
    expect(normalizeLegacyProfile({ machineName: '  Build server  ' }).machineName).toBe(
      'Build server'
    )
    expect(normalizeLegacyProfile({ machineName: undefined }).machineName).toBe('')
    expect(normalizeLegacyProfile({ machineName: 'x'.repeat(300) }).machineName).toHaveLength(255)
  })
})

describe('chat appearance settings', () => {
  it('normalizes old and malformed profiles on load', () => {
    expect(normalizeLegacyProfile({}).nativeChatAppearance).toBeUndefined()
    expect(
      normalizeLegacyProfile({
        nativeChatAppearance: { fontSize: 40, codeFontSize: 1, width: 'wide' }
      }).nativeChatAppearance
    ).toEqual({ fontSize: 20, codeFontSize: 10, width: 'wide' })
    expect(
      normalizeLegacyProfile({
        nativeChatAppearance: { fontSize: 14, codeFontSize: 12, width: 'comfortable' }
      }).nativeChatAppearance
    ).toBeUndefined()
  })
})

describe('the new-chat permission setting', () => {
  it.each([
    ['manual', 'ask'],
    ['yolo', 'full-access']
  ] as const)('seeds a profile without it from %s Agent Permissions', (mode, expected) => {
    const normalized = normalizeLegacyProfile({
      nativeChatPermissionMode: undefined,
      ...applyAgentPermissionMode({ mode })
    })
    expect(normalized.nativeChatPermissionMode).toBe(expected)
  })

  // Seeded once: after the next save the setting is the user's, not a mirror of Agent Permissions.
  it('keeps a saved value when Agent Permissions change afterwards', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatPermissionMode: 'ask',
      ...applyAgentPermissionMode({ mode: 'yolo' })
    })
    expect(normalized.nativeChatPermissionMode).toBe('ask')
  })
})

describe('scoped new-chat permission defaults', () => {
  it('preserves an agent override across load while rejecting unsupported stored modes', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatPermissionMode: 'full-access',
      agentNativeChatPermissionModes: { codex: 'auto', claude: 'ask', omp: 'auto', unknown: 'auto' }
    })
    expect(normalized.agentNativeChatPermissionModes).toEqual({ codex: 'auto', claude: 'ask' })
    expect(normalized.nativeChatPermissionMode).toBe('full-access')
  })
})

describe('terminal default shell', () => {
  it('trims a hand-edited value and treats whitespace-only as unset', () => {
    expect(
      normalizeLegacyProfile({ terminalDefaultShell: '  /bin/zsh  ' }).terminalDefaultShell
    ).toBe('/bin/zsh')
    expect(normalizeLegacyProfile({ terminalDefaultShell: '   ' }).terminalDefaultShell).toBe('')
  })
})

describe('terminal graphite defaults', () => {
  const unmigrated = {
    terminalGraphiteDefaultsMigrated: undefined,
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalThemeLight: 'Builtin Tango Light',
    terminalDividerColorDark: '#3f3f46',
    terminalDividerColorLight: '#d4d4d8'
  }

  it('moves a profile still on the old defaults to Quirky Graphite and stamps the marker', () => {
    const normalized = normalizeLegacyProfile(unmigrated)

    expect(normalized).toMatchObject({
      terminalThemeDark: 'Quirky Graphite Dark',
      terminalThemeLight: 'Quirky Graphite Light',
      terminalDividerColorDark: '#24262c',
      terminalDividerColorLight: '#e3e5ea',
      terminalGraphiteDefaultsMigrated: true
    })
  })

  it('keeps a custom theme and moves only the key on the old default', () => {
    const normalized = normalizeLegacyProfile({ ...unmigrated, terminalThemeDark: 'Dracula' })

    expect(normalized.terminalThemeDark).toBe('Dracula')
    expect(normalized.terminalThemeLight).toBe('Quirky Graphite Light')
  })

  it('does not move an old theme the user picked after the marker was stamped', () => {
    const normalized = normalizeLegacyProfile({
      ...unmigrated,
      terminalGraphiteDefaultsMigrated: true
    })

    expect(normalized.terminalThemeDark).toBe('Ghostty Default Style Dark')
    expect(normalized.terminalDividerColorDark).toBe('#3f3f46')
  })
})
