import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, BackHandler, Platform, ScrollView, StatusBar, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ExpoLinking from 'expo-linking'
import type { MobileHost, MobileRoute } from '../contracts'
import { HostPageShell } from '../shell/HostPageShell'
import { createExpoRuntime } from './expo-platform'
import { DiagnosticsScreen, EditHostScreen, HomeScreen, HostActionsScreen } from './HostScreens'
import { PairingScreen } from './PairingScreen'
import { SettingsScreen } from './SettingsScreen'
import { ActionButton, Notice, ScreenHeader, uiStyles } from './ui'

type Screen = 'home' | 'pair' | 'onboarding' | 'settings' | 'host' | 'edit-host' | 'diagnostics' | 'shell'

function isPairingLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'quirky:' && parsed.hostname === 'pair'
  } catch {
    return false
  }
}

export function NativeApp() {
  const [runtime] = useState(() => createExpoRuntime())
  const [screen, setScreen] = useState<Screen>('home')
  const [hosts, setHosts] = useState<MobileHost[]>([])
  const [selectedHostId, setSelectedHostId] = useState('')
  const [route, setRoute] = useState<MobileRoute>({ kind: 'workspaces' })
  const [initialPairingLink, setInitialPairingLink] = useState<string | undefined>()
  const [onboardingStep, setOnboardingStep] = useState(0)
  const [error, setError] = useState('')
  const screenRef = useRef(screen)
  screenRef.current = screen

  const refresh = useCallback(async () => {
    try {
      const [nextHosts, nextPreferences] = await Promise.all([runtime.hosts(), runtime.preferences()])
      setHosts(nextHosts)
      if (nextHosts.length > 0 && !nextPreferences.onboardingCompleted && screenRef.current === 'home') {
        setOnboardingStep(0)
        setScreen('onboarding')
      }
    } catch {
      setError('Phone data could not be read. Retry after checking available device storage.')
    }
  }, [runtime])

  const showPairingLink = useCallback((url: string) => {
    if (!isPairingLink(url) || screenRef.current === 'onboarding') return
    setInitialPairingLink(url)
    setScreen('pair')
    setError('')
  }, [])

  useEffect(() => {
    let mounted = true
    const unsubscribe = runtime.subscribe(() => { if (mounted) void refresh() })
    runtime.setForeground(true)
    void refresh()
    const appState = AppState.addEventListener('change', (state) => runtime.setForeground(state === 'active'))
    const links = ExpoLinking.addEventListener('url', ({ url }) => showPairingLink(url))
    void ExpoLinking.getInitialURL().then((url) => { if (mounted && url) showPairingLink(url) }).catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
      appState.remove()
      links.remove()
      runtime.dispose()
    }
  }, [refresh, runtime, showPairingLink])

  useEffect(() => {
    if (screen !== 'onboarding') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => subscription.remove()
  }, [screen])
  useEffect(() => {
    if (screen !== 'pair') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      runtime.cancelPairing()
      setInitialPairingLink(undefined)
      setScreen('home')
      void refresh()
      return true
    })
    return () => subscription.remove()
  }, [runtime, screen])

  const host = hosts.find((item) => item.id === selectedHostId)
  const onPair = () => {
    setInitialPairingLink(undefined)
    setScreen('pair')
    setError('')
  }
  const afterPair = async (pairedHost: MobileHost) => {
    setInitialPairingLink(undefined)
    setSelectedHostId(pairedHost.id)
    const nextHosts = await runtime.hosts().catch(() => [])
    setHosts(nextHosts)
    const nextPreferences = await runtime.preferences().catch(() => null)
    if (!nextPreferences?.onboardingCompleted) {
      setOnboardingStep(0)
      setScreen('onboarding')
    } else {
      setScreen('home')
    }
  }
  const cancelPairing = () => {
    runtime.cancelPairing()
    setInitialPairingLink(undefined)
    setScreen('home')
    void refresh()
  }
  const openWorkspaces = (hostId: string, nextRoute: MobileRoute = { kind: 'workspaces' }) => {
    setSelectedHostId(hostId)
    setRoute(nextRoute)
    if (nextRoute.kind === 'session') void runtime.rememberWorkspace(hostId, nextRoute.worktreeId).catch(() => {})
    setScreen('shell')
  }
  const onNavigate = (nextRoute: MobileRoute | { kind: 'home' }) => {
    if (nextRoute.kind === 'home') {
      setScreen('home')
      return
    }
    setRoute(nextRoute)
    if (nextRoute.kind === 'session') void runtime.rememberWorkspace(selectedHostId, nextRoute.worktreeId).catch(() => {})
  }
  const finishOnboarding = async () => {
    try {
      await runtime.updatePreferences({ sessionView: 'terminal', notificationChoice: 'disabled', onboardingCompleted: true })
      setScreen('home')
      setError('')
    } catch {
      setError('Onboarding could not be saved. Your choices are still on this screen; retry Finish.')
    }
  }
  const stateFor = (hostId: string) => runtime.connectionState(hostId)

  let content: ReactNode
  if (screen === 'pair') {
    content = <PairingScreen runtime={runtime} initialInput={initialPairingLink} onPaired={(pairedHost) => { void afterPair(pairedHost) }} onCancel={cancelPairing} />
  } else if (screen === 'onboarding') {
    content = (
      <View style={uiStyles.page}>
        <ScrollView contentContainerStyle={uiStyles.scroll}>
          <ScreenHeader title={`First-run setup · ${onboardingStep + 1} of 2`} />
          {onboardingStep === 0 ? (
            <>
              <Text style={uiStyles.title}>How should sessions open?</Text>
              <View style={uiStyles.card}>
                <Text style={uiStyles.body}>Sessions open in the terminal. Interactive chat and voice input are not included in this phone client.</Text>
                <Text style={uiStyles.muted}>Terminal is the only supported session view and is saved as your phone default.</Text>
              </View>
              <ActionButton title="Continue" onPress={() => setOnboardingStep(1)} />
            </>
          ) : (
            <>
              <Text style={uiStyles.title}>Notifications</Text>
              <Notice tone="warning">Remote push delivery is not available. Quirky will not request notification permission or claim that agent notifications are delivered.</Notice>
              <Text style={uiStyles.body}>Finish setup to keep the phone notification preference disabled. You can review device permission in Settings, but permission alone does not enable remote push.</Text>
              <ActionButton title="Finish without notifications" onPress={() => void finishOnboarding()} />
            </>
          )}
          {!!error && <Notice tone="error">{error}</Notice>}
        </ScrollView>
      </View>
    )
  } else if (screen === 'settings') {
    content = <SettingsScreen runtime={runtime} hosts={hosts} onBack={() => setScreen('home')} onDiagnostics={(hostId) => { setSelectedHostId(hostId); setScreen('diagnostics') }} />
  } else if (screen === 'host' && host) {
    content = <HostActionsScreen
      runtime={runtime}
      host={host}
      state={stateFor(host.id)}
      onBack={() => setScreen('home')}
      onEdit={() => setScreen('edit-host')}
      onDiagnostics={() => setScreen('diagnostics')}
      onOpenWorkspaces={() => openWorkspaces(host.id)}
      onRemoved={() => { setScreen('home'); void refresh() }}
      onCleanupPending={() => { setScreen('home'); setError('Secure credential removal is pending. Retry cleanup from Settings.'); void refresh() }}
      onPair={onPair}
    />
  } else if (screen === 'edit-host' && host) {
    content = <EditHostScreen runtime={runtime} host={host} onBack={() => setScreen('host')} onSaved={() => { setScreen('host'); void refresh() }} />
  } else if (screen === 'diagnostics' && host) {
    content = <DiagnosticsScreen runtime={runtime} host={host} state={stateFor(host.id)} onBack={() => setScreen('host')} onOpenWorkspaces={() => openWorkspaces(host.id)} />
  } else if (screen === 'shell' && host && Platform.OS === 'web') {
    content = (
      <View style={uiStyles.page}>
        <ScreenHeader title={hostDisplay(host)} onBack={() => setScreen('host')} />
        <View style={{ padding: 20, gap: 14 }}>
          <Notice tone="warning">The isolated page shell uses the native iOS and Android origin module. It is not mounted in a browser export.</Notice>
          <ActionButton title="Return to home" onPress={() => setScreen('home')} />
        </View>
      </View>
    )
  } else if (screen === 'shell' && host) {
    content = (
      <View style={uiStyles.page}>
        <ScreenHeader title={hostDisplay(host)} onBack={() => setScreen('host')} right={<ActionButton title="Home" secondary onPress={() => setScreen('home')} />} />
        <HostPageShell runtime={runtime} hostId={host.id} route={route} onNavigate={onNavigate} />
      </View>
    )
  } else {
    content = <HomeScreen
      hosts={hosts}
      stateFor={stateFor}
      onPair={onPair}
      onSettings={() => setScreen('settings')}
      onHost={(hostId) => { setSelectedHostId(hostId); setScreen('host') }}
      onOpenWorkspaces={openWorkspaces}
    />
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar barStyle="light-content" />
      {content}
      {!!error && screen !== 'onboarding' && screen !== 'pair' && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{error}</Text>
          <ActionButton title="Dismiss" secondary onPress={() => setError('')} />
        </View>
      )}
    </SafeAreaView>
  )
}

function hostDisplay(host: MobileHost): string {
  return host.personalName ?? host.machineName ?? host.name
}


const styles = {
  safeArea: { flex: 1, backgroundColor: '#0c111b' },
  toast: { position: 'absolute' as const, left: 12, right: 12, bottom: 16, backgroundColor: '#321920', borderColor: '#8a3b48', borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  toastText: { color: '#f4dadd', fontSize: 14 }
}
