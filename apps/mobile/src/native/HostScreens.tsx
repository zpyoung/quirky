import { useEffect, useState } from 'react'
import { Alert, ScrollView, Text, TextInput, View } from 'react-native'
import type { MobileConnectionState, MobileHost, MobileLogEntry, MobileRoute } from '../contracts'
import type { MobileRuntimeInstance } from './runtime'
import { describeDirectPath } from './network'
import { ActionButton, FieldLabel, Notice, ScreenHeader, Section, uiStyles } from './ui'

export function hostDisplayName(host: MobileHost): string {
  return host.personalName ?? host.machineName ?? host.name
}

export function connectionVerdict(state: MobileConnectionState): string {
  switch (state.phase) {
    case 'connected': return 'Connected · Direct'
    case 'connecting': return 'Connecting securely…'
    case 'reconnecting': return 'Reconnecting…'
    case 'unreachable': return 'Can’t reach desktop'
    case 'auth-failed': return 'Pairing invalid · re-pair with desktop'
    case 'credential-missing': return 'Pairing credential missing · re-pair'
    case 'credential-unavailable': return 'Pairing temporarily unavailable · unlock secure storage'
    case 'disconnected': return 'Disconnected'
  }
}

export function HomeScreen(props: {
  hosts: MobileHost[]
  stateFor(hostId: string): MobileConnectionState
  onPair(): void
  onSettings(): void
  onHost(hostId: string): void
  onOpenRoute(hostId: string, route: MobileRoute): void
}) {
  return (
    <View style={uiStyles.page}>
      <ScrollView contentContainerStyle={uiStyles.scroll}>
        <ScreenHeader title="Quirky" right={<ActionButton title="Settings" secondary onPress={props.onSettings} />} />
        {props.hosts.length === 0 ? (
          <View style={[uiStyles.card, { alignItems: 'flex-start' }]}>
            <Text style={uiStyles.title}>Connect your desktop</Text>
            <Text style={uiStyles.subtitle}>Pair directly with a Quirky desktop using its mobile QR code or pairing link.</Text>
            <ActionButton title="Pair Desktop" onPress={props.onPair} />
          </View>
        ) : (
          <>
            <Text style={uiStyles.title}>Your desktops</Text>
            <Text style={uiStyles.subtitle}>Direct encrypted connections · no relay or Quirky cloud account</Text>
            <Section title="Desktops">
              {props.hosts.map((host) => {
                const state = props.stateFor(host.id)
                return (
                  <View key={host.id} style={uiStyles.card}>
                    <Text accessibilityRole="header" style={styles.hostName}>{hostDisplayName(host)}</Text>
                    <Text style={uiStyles.body}>{host.platform ? `${host.platform} desktop` : 'Paired desktop'}</Text>
                    <Text style={[uiStyles.body, state.phase === 'connected' ? styles.connected : styles.status]}>{connectionVerdict(state)}</Text>
                    <Text style={uiStyles.muted}>{describeDirectPath(host.endpoint)} · {host.endpoint}</Text>
                    <View style={uiStyles.row}>
                      <ActionButton title="Open workspaces" onPress={() => props.onOpenRoute(host.id, { kind: 'workspaces' })} />
                      <ActionButton title="Host actions" secondary onPress={() => props.onHost(host.id)} accessibilityLabel={`Actions for ${hostDisplayName(host)}`} />
                    </View>
                    <View style={uiStyles.row}>
                      <ActionButton title="Tasks" secondary onPress={() => props.onOpenRoute(host.id, { kind: 'tasks' })} />
                      <ActionButton title="Accounts" secondary onPress={() => props.onOpenRoute(host.id, { kind: 'accounts' })} />
                      <ActionButton title="Notifications" secondary onPress={() => props.onOpenRoute(host.id, { kind: 'notifications' })} />
                    </View>
                    {host.lastWorktree && <ActionButton title="Resume last workspace" secondary onPress={() => props.onOpenRoute(host.id, { kind: 'session', worktreeId: host.lastWorktree! })} />}
                  </View>
                )
              })}
            </Section>
            <ActionButton title="Pair another desktop" secondary onPress={props.onPair} />
          </>
        )}
      </ScrollView>
    </View>
  )
}

export function HostActionsScreen(props: {
  runtime: MobileRuntimeInstance
  host: MobileHost
  state: MobileConnectionState
  onBack(): void
  onEdit(): void
  onDiagnostics(): void
  onOpenRoute(route: MobileRoute): void
  onRemoved(): void
  onCleanupPending(): void
  onPair(): void
}) {
  const [error, setError] = useState('')
  const reconnect = async () => {
    setError('')
    try { await props.runtime.reconnect(props.host.id) } catch {
      setError('Could not reconnect. Check the desktop address and review diagnostics.')
    }
  }
  const remove = () => Alert.alert(
    'Remove desktop',
    `Remove “${hostDisplayName(props.host)}”? Its secure credential will be deleted, or a visible cleanup retry will be kept if secure storage is locked.`,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void props.runtime.removeHost(props.host.id).then((result) => {
            if (result.cleanupPending) props.onCleanupPending()
            else props.onRemoved()
          }).catch(() => setError('The host could not be removed. Retry after secure storage is available.'))
        }
      }
    ]
  )
  return (
    <View style={uiStyles.page}>
      <ScrollView contentContainerStyle={uiStyles.scroll}>
        <ScreenHeader title="Desktop" onBack={props.onBack} />
        <Text accessibilityRole="header" style={uiStyles.title}>{hostDisplayName(props.host)}</Text>
        <Text style={uiStyles.body}>{props.host.platform ?? 'Desktop'} · {connectionVerdict(props.state)}</Text>
        <Text style={uiStyles.muted}>{describeDirectPath(props.host.endpoint)} · {props.host.endpoint}</Text>
        {props.state.phase === 'credential-unavailable' && <Notice tone="warning">Secure storage is temporarily unavailable. Unlock the phone and retry; the credential is never moved into ordinary metadata.</Notice>}
        {props.state.phase === 'credential-missing' && <Notice tone="error">The secure credential is missing. Pair this desktop again; legacy authentication will not be attempted.</Notice>}
        <Section title="Connection">
          {props.state.phase === 'connected'
            ? <ActionButton title="Disconnect" secondary onPress={() => props.runtime.disconnect(props.host.id)} />
            : props.state.phase === 'auth-failed' || props.state.phase === 'credential-missing'
              ? <ActionButton title="Pair this desktop again" onPress={props.onPair} />
              : <ActionButton title="Reconnect" onPress={() => void reconnect()} />}
          <ActionButton title="Network diagnostics" secondary onPress={props.onDiagnostics} />
          <ActionButton title="Open workspaces" secondary onPress={() => props.onOpenRoute({ kind: 'workspaces' })} />
        </Section>
        <Section title="Desktop panels">
          <View style={uiStyles.row}>
            <ActionButton title="Tasks" secondary onPress={() => props.onOpenRoute({ kind: 'tasks' })} />
            <ActionButton title="Accounts" secondary onPress={() => props.onOpenRoute({ kind: 'accounts' })} />
            <ActionButton title="Notifications" secondary onPress={() => props.onOpenRoute({ kind: 'notifications' })} />
          </View>
        </Section>
        <Section title="Host details">
          <ActionButton title="Edit name or address" secondary onPress={props.onEdit} />
          <ActionButton title="Remove desktop" destructive onPress={remove} />
        </Section>
        {!!error && <Notice tone="warning">{error}</Notice>}
      </ScrollView>
    </View>
  )
}

export function EditHostScreen(props: { runtime: MobileRuntimeInstance; host: MobileHost; onBack(): void; onSaved(): void }) {
  const [personalName, setPersonalName] = useState(props.host.personalName ?? '')
  const [endpoint, setEndpoint] = useState(props.host.endpoint)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await props.runtime.editHost(props.host.id, { personalName, endpoint })
      await props.runtime.native.haptic().catch(() => {})
      props.onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Desktop details could not be saved.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <View style={uiStyles.page}>
      <ScrollView contentContainerStyle={uiStyles.scroll} keyboardShouldPersistTaps="handled">
        <ScreenHeader title="Edit desktop" onBack={props.onBack} />
        <Text style={uiStyles.subtitle}>A personal name stays yours if the desktop machine name changes. Use a ws:// or wss:// address; entering a new host without a port keeps the current port.</Text>
        <FieldLabel title="Personal name"><TextInput value={personalName} onChangeText={setPersonalName} maxLength={64} style={uiStyles.input} placeholder={props.host.machineName ?? props.host.name} placeholderTextColor="#7f8da2" /></FieldLabel>
        <FieldLabel title="Desktop address"><TextInput value={endpoint} onChangeText={setEndpoint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={uiStyles.input} /></FieldLabel>
        <Text style={uiStyles.muted}>Connects directly to {endpoint || 'the configured desktop address'}.</Text>
        <ActionButton title={saving ? 'Saving…' : 'Save'} onPress={() => void save()} disabled={saving || endpoint.trim().length === 0} />
        {!!error && <Notice tone="error">{error}</Notice>}
      </ScrollView>
    </View>
  )
}

export function DiagnosticsScreen(props: {
  runtime: MobileRuntimeInstance
  host: MobileHost
  state: MobileConnectionState
  onBack(): void
  onOpenWorkspaces(): void
}) {
  const [running, setRunning] = useState(false)
  const [daemonCheck, setDaemonCheck] = useState<'not-run' | 'passed' | 'failed'>('not-run')
  const [identity, setIdentity] = useState<{ machineName: string; platform: string } | null>(null)
  const [logs, setLogs] = useState<MobileLogEntry[]>([])
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const refreshLogs = async () => {
    try { setLogs(await props.runtime.logs(props.host.id)) } catch { setLogs([]) }
  }
  const runChecks = async () => {
    setRunning(true)
    setError('')
    setDaemonCheck('not-run')
    setIdentity(null)
    try {
      const rpc = await props.runtime.reconnect(props.host.id)
      await rpc.call<unknown>('status.get', {})
      setDaemonCheck('passed')
      const info = await rpc.call<unknown>('quirky.mobile/info', {})
      if (info && typeof info === 'object' && !Array.isArray(info) && 'machineName' in info && typeof info.machineName === 'string' && 'platform' in info && typeof info.platform === 'string') {
        setIdentity({ machineName: info.machineName, platform: info.platform })
      }
    } catch {
      setDaemonCheck('failed')
      setError('A live daemon check failed. The details below are redacted; retry after checking the desktop address and network.')
    } finally {
      setRunning(false)
      await refreshLogs()
    }
  }

  useEffect(() => {
    void refreshLogs()
    void runChecks()
  }, [props.host.id])

  const copyReport = async () => {
    const report = [
      'Quirky mobile diagnostics (redacted)',
      `Desktop: ${hostDisplayName(props.host)}`,
      `Endpoint: ${props.host.endpoint}`,
      `Pinned identity: ${props.host.id}`,
      `Connection: ${props.state.phase} (${props.state.attempts} attempts)`,
      `Daemon check: ${daemonCheck}`,
      identity ? `Authenticated desktop: ${identity.machineName} (${identity.platform})` : 'Authenticated desktop: unavailable',
      ...logs.slice(-200).map((entry) => `${new Date(entry.at).toISOString()} ${entry.stage}: ${entry.message}`)
    ].join('\n')
    try {
      await props.runtime.native.clipboardWrite(report)
      setCopied(true)
    } catch {
      setError('Redacted diagnostics could not be copied.')
    }
  }

  return (
    <View style={uiStyles.page}>
      <ScrollView contentContainerStyle={uiStyles.scroll}>
        <ScreenHeader title="Network diagnostics" onBack={props.onBack} />
        <Text accessibilityRole="header" style={uiStyles.title}>{hostDisplayName(props.host)}</Text>
        <Text style={uiStyles.body}>{describeDirectPath(props.host.endpoint)} · {props.host.endpoint}</Text>
        <Text style={uiStyles.body}>Connection: {connectionVerdict(props.state)} ({props.state.attempts} attempts)</Text>
        <Section title="Live checks">
          <Text style={uiStyles.body}>Authenticated daemon status: {daemonCheck === 'passed' ? 'passed' : daemonCheck === 'failed' ? 'failed' : 'not run'}</Text>
          <Text style={uiStyles.body}>{identity ? `Desktop identity: ${identity.machineName} · ${identity.platform}` : 'Desktop identity: not available'}</Text>
          <View style={uiStyles.row}>
            <ActionButton title={running ? 'Checking…' : 'Run checks again'} onPress={() => void runChecks()} disabled={running} />
            <ActionButton title="Open workspaces" secondary onPress={props.onOpenWorkspaces} />
          </View>
        </Section>
        <Section title="Redacted log · last 200 entries">
          {logs.length === 0 ? <Text style={uiStyles.muted}>No connection log entries yet.</Text> : logs.slice(-200).map((entry, index) => (
            <Text key={`${entry.at}-${index}`} style={uiStyles.muted}>{new Date(entry.at).toLocaleTimeString()} · {entry.stage}: {entry.message}</Text>
          ))}
        </Section>
        <View style={uiStyles.row}>
          <ActionButton title={copied ? 'Copied' : 'Copy redacted diagnostics'} secondary onPress={() => void copyReport()} />
          <ActionButton title="Refresh log" secondary onPress={() => void refreshLogs()} />
        </View>
        <Text style={uiStyles.muted}>Reports contain no pairing token, private key, terminal input, or remote submission.</Text>
        {!!error && <Notice tone="warning">{error}</Notice>}
      </ScrollView>
    </View>
  )
}

const styles = {
  hostName: { color: '#f4f7fc', fontSize: 20, fontWeight: '700' as const },
  connected: { color: '#81d8a0', fontWeight: '700' as const },
  status: { color: '#edc872', fontWeight: '600' as const }
}
