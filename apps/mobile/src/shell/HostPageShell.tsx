import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useEffect, useRef, useState } from 'react'
import type { HostPageShellProps, MobileBundleManifestResult, MobileBundleReadResult, MobileConnectionState, MobilePageInit, MobileRpc, MobileRoute } from '../contracts'
import { sha256 } from '@quirky/protocol/paired-client'
import { QuirkyPageOriginView, parseMobileWebShellLoadState, type QuirkyPageOriginViewHandle, type MobileWebShellFailureReason } from '../../modules/quirky-page-origin'
import { getMobilePageGenerationStore } from './expo-generation-store'
import { createBridgeHost, type PageBridgeHost } from './bridge-host'
import { downloadBundle, type BundleProgress, type StoredGeneration } from './generation'
import { safeExternalUrl, resolveBundleRoute } from './shell-security'

type ShellStatus =
  | { kind: 'loading'; message: string; progress?: BundleProgress }
  | { kind: 'ready'; mountId: string; init: MobilePageInit; generation: StoredGeneration; staleMessage?: string }
  | { kind: 'error'; message: string }

let mountSequence = 0

function createMountId(): string {
  const bytes = new Uint8Array(16)
  try {
    globalThis.crypto?.getRandomValues(bytes)
  } catch {}
  if (bytes.some((value) => value !== 0)) return `mount-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`
  return `mount-${Date.now().toString(36)}-${(++mountSequence).toString(36)}-${Math.random().toString(36).slice(2)}`
}

function connectionMessage(state: MobileConnectionState): string {
  if (state.phase === 'auth-failed') return 'Pairing is invalid. Re-pair this desktop to continue.'
  if (state.phase === 'credential-missing') return 'The saved desktop credential is missing. Re-pair this desktop to continue.'
  if (state.phase === 'credential-unavailable') return 'Secure credential storage is unavailable. Retry when it is unlocked.'
  return `Desktop is ${state.phase}. Connect to the desktop to enable changes.`
}
function failureMessage(reason: MobileWebShellFailureReason): string {
  switch (reason) {
    case 'isolation-unavailable': return "This device's WebView cannot isolate the page safely."
    case 'generation-unreadable': return 'The verified page generation could not be opened.'
    case 'document-load-failed': return 'The verified page could not be loaded.'
    case 'render-process-gone': return 'The page renderer stopped responding.'
  }
}

export function HostPageShell({ runtime, hostId, route, onNavigate }: HostPageShellProps) {
  const insets = useSafeAreaInsets()
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<ShellStatus>({ kind: 'loading', message: 'Opening the desktop page…' })
  const [pageLoading, setPageLoading] = useState(false)
  const routeKey = JSON.stringify(route)
  const bridgeHostRef = useRef<PageBridgeHost | undefined>(undefined)
  const originViewRef = useRef<QuirkyPageOriginViewHandle | null>(null)

  useEffect(() => {
    let active = true
    let currentRpc: MobileRpc | undefined
    let bridgeHost: PageBridgeHost | undefined
    let refreshRequest = 0
    let unsubscribeRuntime: (() => void) | undefined
    const mountId = createMountId()
    const currentRoute = JSON.parse(routeKey) as MobileRoute

    setStatus({ kind: 'loading', message: 'Checking the verified page cache…' })
    setPageLoading(false)

    const refreshRpc = async () => {
      if (!active || AppState.currentState !== 'active') return
      const request = ++refreshRequest
      try {
        const next = await runtime.getRpc(hostId)
        if (!active || request !== refreshRequest || next === currentRpc) return
        currentRpc = next
        bridgeHost?.setRpc(next)
      } catch {
        // The current authenticated client publishes the authoritative unavailable state.
      }
    }

    unsubscribeRuntime = runtime.subscribe(() => { void refreshRpc() })

    const open = async () => {
      try {
        const [hosts, preferences, generationStore] = await Promise.all([
          runtime.hosts(),
          runtime.preferences(),
          getMobilePageGenerationStore()
        ])
        if (!active) return
        const host = hosts.find((candidate) => candidate.id === hostId)
        if (!host) throw new Error('This desktop is no longer paired. Return home and choose another desktop.')
        const initialRpc = await runtime.getRpc(hostId)
        if (!currentRpc) currentRpc = initialRpc
        let generation: StoredGeneration | null = null
        let staleMessage: string | undefined

        if (currentRpc.state.phase === 'connected') {
          setStatus({ kind: 'loading', message: 'Checking the latest desktop page…' })
          try {
            const manifest = await currentRpc.call<MobileBundleManifestResult>('quirky.mobile/bundleManifest', {})
            if (!active) return
            setStatus({ kind: 'loading', message: 'Downloading the latest desktop page…' })
            generation = await downloadBundle(
              hostId,
              manifest,
              (buildId, path, offset) => (currentRpc as MobileRpc).call<MobileBundleReadResult>('quirky.mobile/bundleChunk', { buildId, path, offset }),
              generationStore,
              sha256,
              (progress) => { if (active) setStatus({ kind: 'loading', message: 'Downloading the latest desktop page…', progress }) }
            )
          } catch (error) {
            const cached = await generationStore.getActive(hostId)
            if (!cached) throw error
            generation = cached
            staleMessage = 'The page update failed. Showing the last verified version.'
          }
        } else {
          generation = await generationStore.getActive(hostId)
          if (!generation) throw new Error(`No verified page is cached. ${connectionMessage(currentRpc.state)}`)
          staleMessage = connectionMessage(currentRpc.state)
        }

        if (!active || !generation || !currentRpc) return
        const pageRoute = resolveBundleRoute(generation.manifest, currentRoute)
        const init: MobilePageInit = {
          v: 1,
          sessionId: mountId,
          host,
          route: currentRoute,
          grants: [...pageRoute.grants],
          preferences,
          connectionState: currentRpc.state,
          safeArea: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left }
        }
        bridgeHost = createBridgeHost({
          init,
          rpc: currentRpc,
          storage: runtime.storage,
          native: runtime.native,
          sendToPage: (data) => {
            const view = originViewRef.current
            if (!view) return Promise.reject(new Error('native page view is not mounted'))
            return view.postBridgeMessage(data)
          },
          onNavigate: (next) => { if (active) onNavigate(next) },
          rememberWorkspace: (id, worktreeId) => runtime.rememberWorkspace(id, worktreeId)
        })
        bridgeHostRef.current = bridgeHost
        if (!active) {
          bridgeHost.close()
          return
        }
        setStatus({ kind: 'ready', mountId, init, generation, staleMessage })
      } catch (error) {
        if (!active) return
        setStatus({ kind: 'error', message: error instanceof Error ? error.message : 'The desktop page could not be opened.' })
      }
    }

    void open()
    return () => {
      active = false
      refreshRequest++
      unsubscribeRuntime?.()
      if (bridgeHostRef.current === bridgeHost) bridgeHostRef.current = undefined
      bridgeHost?.close()
    }
  }, [attempt, hostId, insets.bottom, insets.left, insets.right, insets.top, onNavigate, routeKey, runtime])

  if (status.kind === 'ready') {
    return (
      <View style={styles.container}>
        {status.staleMessage ? (
          <View accessibilityRole="alert" style={styles.staleBanner}>
            <Text style={styles.staleText}>{status.staleMessage}</Text>
          </View>
        ) : null}
        <View style={styles.pageHost}>
          <QuirkyPageOriginView
            key={status.mountId}
            ref={originViewRef}
            style={styles.page}
            generationDirectory={status.generation.directory}
            sessionId={status.mountId}
            bridgeEnabled
            onBridgeMessage={(event) => bridgeHostRef.current?.receive(event.nativeEvent.json)}
            onLoadState={(event) => {
              const loadState = parseMobileWebShellLoadState(event.nativeEvent)
              if (!loadState) return
              if (loadState.state === 'loading') {
                setPageLoading(true)
                return
              }
              if (loadState.state === 'ready') {
                setPageLoading(false)
                return
              }
              setPageLoading(false)
              bridgeHostRef.current?.close()
              bridgeHostRef.current = undefined
              setStatus({ kind: 'error', message: failureMessage(loadState.reason) })
            }}
            onExternalNavigation={(event) => {
              const url = safeExternalUrl(event.nativeEvent.url)
              if (url && status.init.grants.includes('externalLink')) void runtime.native.openExternal(url).catch(() => {})
            }}
          />
          {pageLoading ? (
            <View pointerEvents="none" style={styles.pageLoading}>
              <ActivityIndicator color="#f1f5f9" />
              <Text style={styles.pageLoadingText}>Opening the verified page…</Text>
            </View>
          ) : null}
        </View>
      </View>
    )
  }

  if (status.kind === 'loading') {
    const progress = status.progress
    return (
      <View style={styles.messageScreen}>
        <Text accessibilityRole="header" style={styles.title}>Desktop page</Text>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{status.message}</Text>
        {progress ? (
          <Text style={styles.progress}>
            {formatBytes(progress.receivedBytes)} of {formatBytes(progress.totalBytes)}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={() => onNavigate({ kind: 'home' })} style={styles.secondaryButton}>
            <Text style={styles.secondaryLabel}>Back</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.messageScreen}>
      <Text accessibilityRole="header" style={styles.title}>Desktop page unavailable</Text>
      <Text accessibilityRole="alert" style={styles.message}>{status.message}</Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)} style={styles.primaryButton}>
          <Text style={styles.primaryLabel}>Retry</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => onNavigate({ kind: 'home' })} style={styles.secondaryButton}>
          <Text style={styles.secondaryLabel}>Back</Text>
        </Pressable>
      </View>
    </View>
  )
}


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(1)} ${units[unit]}`
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#10131a' },
  page: { flex: 1 },
  pageHost: { flex: 1, position: 'relative' },
  pageLoading: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: 'rgba(16, 19, 26, 0.9)' },
  pageLoadingText: { color: '#cbd5e1', fontSize: 14 },
  messageScreen: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 20, backgroundColor: '#10131a' },
  title: { color: '#f1f5f9', fontSize: 22, fontWeight: '700', marginBottom: 12 },
  message: { color: '#cbd5e1', fontSize: 15, lineHeight: 22 },
  progress: { color: '#94a3b8', fontSize: 13, marginTop: 12 },
  staleBanner: { backgroundColor: '#713f12', paddingHorizontal: 12, paddingVertical: 8 },
  staleText: { color: '#fef3c7', fontSize: 13 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 24 },
  primaryButton: { minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#2563eb', paddingHorizontal: 16 },
  primaryLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  secondaryButton: { minHeight: 44, minWidth: 72, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#263244', paddingHorizontal: 16 },
  secondaryLabel: { color: '#f1f5f9', fontSize: 15, fontWeight: '600' }
})
