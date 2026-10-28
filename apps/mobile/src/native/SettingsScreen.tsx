import { useCallback, useEffect, useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import type { MobileHost, MobilePreferences } from '../contracts'
import type { MobileRuntimeInstance } from './runtime'
import { ActionButton, FieldLabel, Notice, ScreenHeader, Section, uiStyles } from './ui'

const SCALE_OPTIONS: MobilePreferences['terminalTextScale'][] = [0.5, 0.75, 1, 1.25, 1.5, 2]
const RESTORE_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: 60_000, label: '1 minute' },
  { value: 300_000, label: '5 minutes' },
  { value: 1_800_000, label: '30 minutes' }
]

type RemotePreference = { value?: number | null; error?: string; saving?: boolean }

function restoreValue(value: unknown): number | null {
  if (value === null || value === 60_000 || value === 300_000 || value === 1_800_000) return value
  throw new Error('Desktop returned an unsupported restore delay')
}

export function SettingsScreen(props: {
  runtime: MobileRuntimeInstance
  hosts: MobileHost[]
  onBack(): void
  onDiagnostics(hostId: string): void
  onOpenNotifications(hostId: string): void
}) {
  const [preferences, setPreferences] = useState<MobilePreferences | null>(null)
  const [notificationPermission, setNotificationPermission] = useState('Not checked')
  const [remotePreferences, setRemotePreferences] = useState<Record<string, RemotePreference>>({})
  const [shortcutLabel, setShortcutLabel] = useState('')
  const [shortcutText, setShortcutText] = useState('')
  const [pendingCleanup, setPendingCleanup] = useState<string[]>([])
  const [error, setError] = useState('')

  const refreshLocal = useCallback(async () => {
    try { setPreferences(await props.runtime.preferences()) } catch { setError('Phone settings could not be loaded.') }
  }, [props.runtime])

  const loadRestore = useCallback(async (host: MobileHost) => {
    setRemotePreferences((current) => ({ ...current, [host.id]: { ...current[host.id], saving: true, error: undefined } }))
    try {
      const rpc = await props.runtime.getRpc(host.id)
      const response = await rpc.call<unknown>('quirky.mobile/preferences', {})
      if (!response || typeof response !== 'object' || Array.isArray(response) || !('autoRestoreFitMs' in response)) throw new Error('Desktop preference response is invalid')
      const value = restoreValue(response.autoRestoreFitMs)
      setRemotePreferences((current) => ({ ...current, [host.id]: { value } }))
    } catch {
      setRemotePreferences((current) => ({ ...current, [host.id]: { error: 'Reconnect to load this desktop setting.' } }))
    }
  }, [props.runtime])

  const hostIds = props.hosts.map((host) => host.id).join(',')
  useEffect(() => {
    void refreshLocal()
    void props.runtime.pendingCredentialCleanup().then(setPendingCleanup).catch(() => {})
    void props.runtime.native.notificationPermission(false).then((value) => setNotificationPermission(value)).catch(() => setNotificationPermission('unavailable'))
    for (const host of props.hosts) void loadRestore(host)
  }, [hostIds, loadRestore, props.runtime, refreshLocal])

  const updateLocal = async (patch: Partial<MobilePreferences>): Promise<boolean> => {
    try {
      const next = await props.runtime.updatePreferences(patch)
      setPreferences(next)
      setError('')
      await props.runtime.native.haptic().catch(() => {})
      return true
    } catch {
      setError('That phone setting could not be saved. Try again.')
      return false
    }
  }

  const updateRemote = async (hostId: string, value: number | null) => {
    setRemotePreferences((current) => ({ ...current, [hostId]: { ...current[hostId], saving: true, error: undefined } }))
    try {
      const rpc = await props.runtime.getRpc(hostId)
      const response = await rpc.call<unknown>('quirky.mobile/updatePreferences', { autoRestoreFitMs: value })
      if (!response || typeof response !== 'object' || Array.isArray(response) || !('autoRestoreFitMs' in response)) throw new Error('Desktop preference response is invalid')
      setRemotePreferences((current) => ({ ...current, [hostId]: { value: restoreValue(response.autoRestoreFitMs) } }))
      await props.runtime.native.haptic().catch(() => {})
    } catch {
      setRemotePreferences((current) => ({ ...current, [hostId]: { ...current[hostId], saving: false, error: 'The desktop did not save this restore delay.' } }))
    }
  }

  const addShortcut = async () => {
    if (!preferences || shortcutLabel.trim().length === 0 || shortcutText.length === 0) return
    const id = `quick_${Date.now().toString(36)}`
    if (await updateLocal({ shortcuts: [...preferences.shortcuts, { id, label: shortcutLabel.trim(), text: shortcutText }] })) {
      setShortcutLabel('')
      setShortcutText('')
    }
  }

  const removeShortcut = async (id: string) => {
    if (!preferences) return
    await updateLocal({ shortcuts: preferences.shortcuts.filter((shortcut) => shortcut.id !== id) })
  }

  const retryCleanup = async () => {
    try { setPendingCleanup(await props.runtime.retryCredentialCleanup()) } catch { setError('Secure credential cleanup could not be retried.') }
  }

  const checkNotificationPermission = async () => {
    try { setNotificationPermission(await props.runtime.native.notificationPermission(false)) } catch { setNotificationPermission('unavailable') }
  }

  const openNotificationSettings = async () => {
    try { await props.runtime.native.openSystemSettings() } catch { setError('Device Settings could not be opened.') }
  }

  if (!preferences) {
    return <View style={uiStyles.page}><ScrollView contentContainerStyle={uiStyles.scroll}><ScreenHeader title="Settings" onBack={props.onBack} /><Text style={uiStyles.body}>Loading phone settings…</Text>{!!error && <Notice tone="error">{error}</Notice>}</ScrollView></View>
  }

  return (
    <View style={uiStyles.page}>
      <ScrollView contentContainerStyle={uiStyles.scroll} keyboardShouldPersistTaps="handled">
        <ScreenHeader title="Settings" onBack={props.onBack} />
        <Text style={uiStyles.subtitle}>Phone preferences are stored locally. Desktop-owned restore settings are saved on each paired desktop.</Text>
        <Section title="Sessions">
          <View style={uiStyles.card}>
            <Text style={uiStyles.body}>Sessions open in the terminal. Interactive chat and voice input are not available in this client.</Text>
            <Text style={uiStyles.muted}>Session view: Terminal</Text>
          </View>
        </Section>
        <Section title="Terminal text size">
          <View style={uiStyles.row}>
            {SCALE_OPTIONS.map((scale) => <ActionButton key={scale} title={`${scale * 100}%`} secondary={preferences.terminalTextScale !== scale} onPress={() => void updateLocal({ terminalTextScale: scale })} />)}
          </View>
        </Section>
        <Section title="Autocomplete">
          <ActionButton title={preferences.autocomplete ? 'Autocomplete on' : 'Autocomplete off'} secondary={!preferences.autocomplete} onPress={() => void updateLocal({ autocomplete: !preferences.autocomplete })} />
        </Section>
        <Section title="Terminal links">
          <View style={uiStyles.row}>
            <ActionButton title="Open on phone" secondary={preferences.terminalLinkMode !== 'phone'} onPress={() => void updateLocal({ terminalLinkMode: 'phone' })} />
            <ActionButton title="Open on desktop" secondary={preferences.terminalLinkMode !== 'desktop'} onPress={() => void updateLocal({ terminalLinkMode: 'desktop' })} />
          </View>
          <Text style={uiStyles.muted}>Desktop links are requested through the paired client. The phone can open supported web links only.</Text>
        </Section>
        <Section title="Quick terminal shortcuts">
          {preferences.shortcuts.map((shortcut) => (
            <View key={shortcut.id} style={[uiStyles.card, uiStyles.row]}>
              <View style={{ flex: 1, gap: 4 }}><Text style={uiStyles.body}>{shortcut.label}</Text><Text numberOfLines={2} style={uiStyles.muted}>{shortcut.text}</Text></View>
              <ActionButton title="Remove" secondary onPress={() => void removeShortcut(shortcut.id)} />
            </View>
          ))}
          {preferences.shortcuts.length === 0 && <Text style={uiStyles.muted}>No custom shortcuts saved.</Text>}
          <FieldLabel title="Shortcut label"><TextInput value={shortcutLabel} onChangeText={setShortcutLabel} maxLength={32} style={uiStyles.input} placeholder="e.g. Interrupt" placeholderTextColor="#7f8da2" /></FieldLabel>
          <FieldLabel title="Text to send"><TextInput value={shortcutText} onChangeText={setShortcutText} maxLength={1024} multiline style={[uiStyles.input, { minHeight: 84, textAlignVertical: 'top' }]} placeholder="Exact terminal input" placeholderTextColor="#7f8da2" /></FieldLabel>
          <ActionButton title="Add shortcut" onPress={() => void addShortcut()} disabled={!shortcutLabel.trim() || !shortcutText || preferences.shortcuts.length >= 24} />
        </Section>
        <Section title="Automatic terminal restore">
          <Text style={uiStyles.muted}>This daemon-owned setting is stored on each desktop and applies only when supported by that desktop.</Text>
          {props.hosts.map((host) => {
            const remote = remotePreferences[host.id] ?? {}
            return (
              <View key={host.id} style={uiStyles.card}>
                <Text style={uiStyles.body}>{host.personalName ?? host.machineName ?? host.name}</Text>
                {remote.error ? <Notice tone="warning">{remote.error}</Notice> : <Text style={uiStyles.muted}>{remote.saving ? 'Loading desktop setting…' : `Current: ${RESTORE_OPTIONS.find((option) => option.value === remote.value)?.label ?? 'Unavailable'}`}</Text>}
                <View style={uiStyles.row}>
                  {RESTORE_OPTIONS.map((option) => <ActionButton key={String(option.value)} title={option.label} secondary={remote.value !== option.value} disabled={remote.saving || remote.value === undefined} onPress={() => void updateRemote(host.id, option.value)} />)}
                </View>
                <ActionButton title="Reload desktop setting" secondary disabled={remote.saving} onPress={() => void loadRestore(host)} />
              </View>
            )
          })}
          {props.hosts.length === 0 && <Text style={uiStyles.muted}>Pair a desktop to view its restore setting.</Text>}
        </Section>
        <Section title="Notifications">
          <Notice tone="warning">Remote push delivery is not available. Enabling device permission would not connect this phone to a Quirky push service.</Notice>
          <Text style={uiStyles.body}>Phone permission: {notificationPermission}</Text>
          <Text style={uiStyles.muted}>Saved notification preference: {preferences.notificationChoice}</Text>
          <Text style={uiStyles.muted}>Desktop notification subscriptions are viewed in a paired desktop’s notification panel. They are not background push delivery.</Text>
          {props.hosts.length === 0 ? (
            <Text style={uiStyles.muted}>Pair a desktop to open its notifications here.</Text>
          ) : props.hosts.map((host) => {
            const name = host.personalName ?? host.machineName ?? host.name
            return (
              <View key={host.id} style={uiStyles.card}>
                <Text style={uiStyles.body}>{name}</Text>
                <Text style={uiStyles.muted}>Open this desktop’s notifications panel. Remote push and background subscriptions are unavailable.</Text>
                <ActionButton title="Open notifications" secondary accessibilityLabel={`Open notifications for ${name}`} onPress={() => props.onOpenNotifications(host.id)} />
              </View>
            )
          })}
          <View style={uiStyles.row}>
            <ActionButton title="Check device permission" secondary onPress={() => void checkNotificationPermission()} />
            {(notificationPermission === 'denied' || notificationPermission === 'undetermined') && <ActionButton title="Open device Settings" secondary onPress={() => void openNotificationSettings()} />}
          </View>
        </Section>
        {props.hosts.length > 0 && <Section title="Troubleshooting">
          <Text style={uiStyles.muted}>Run live daemon checks and copy only redacted connection diagnostics. Reports are never submitted to an upstream service.</Text>
          {props.hosts.map((host) => <ActionButton key={host.id} title={`Diagnose ${host.personalName ?? host.machineName ?? host.name}`} secondary onPress={() => props.onDiagnostics(host.id)} />)}
        </Section>}
        <Section title="Secure credential cleanup">
          <Text style={uiStyles.body}>{pendingCleanup.length === 0 ? 'No pending secure credential deletion.' : `${pendingCleanup.length} secure credential deletion(s) need a retry.`}</Text>
          <ActionButton title="Retry cleanup" secondary disabled={pendingCleanup.length === 0} onPress={() => void retryCleanup()} />
        </Section>
        <Section title="About">
          <Text style={uiStyles.body}>Quirky mobile companion</Text>
          <Text style={uiStyles.muted}>No mobile store, signed update channel, or distribution service is configured. Update information must come from your Quirky desktop.</Text>
        </Section>
        {!!error && <Notice tone="error">{error}</Notice>}
      </ScrollView>
    </View>
  )
}
