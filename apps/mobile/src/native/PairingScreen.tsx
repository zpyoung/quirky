import { useEffect, useRef, useState } from 'react'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { MobileHost, MobileLogEntry } from '../contracts'
import type { MobileRuntimeInstance } from './runtime'
import { previewMobileOffer, type MobileOfferPreview } from './pairing'
import { ActionButton, Notice, ScreenHeader, uiStyles } from './ui'

export function PairingScreen(props: {
  runtime: MobileRuntimeInstance
  initialInput?: string
  onPaired(host: MobileHost): void
  onCancel(): void
}) {
  const [permission, requestPermission] = useCameraPermissions()
  const [input, setInput] = useState('')
  const [candidateInput, setCandidateInput] = useState<string | null>(null)
  const [preview, setPreview] = useState<MobileOfferPreview | null>(null)
  const [scanning, setScanning] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [pasteError, setPasteError] = useState('')
  const [logs, setLogs] = useState<MobileLogEntry[]>([])
  const mounted = useRef(true)
  const pairingInFlight = useRef(false)

  const review = (value: string) => {
    try {
      const nextPreview = previewMobileOffer(value)
      setCandidateInput(value)
      setPreview(nextPreview)
      setInput('')
      setPasteError('')
      setScanning(false)
    } catch {
      setCandidateInput(null)
      setPreview(null)
      setPasteError('Not a valid Quirky mobile pairing code. Copy the code or link shown on the desktop and try again.')
    }
  }

  useEffect(() => {
    mounted.current = true
    if (props.initialInput) review(props.initialInput)
    return () => {
      mounted.current = false
      if (pairingInFlight.current) props.runtime.cancelPairing()
    }
  }, [props.initialInput, props.runtime])

  const startScan = async () => {
    setPasteError('')
    try {
      if (!permission?.granted) {
        const result = await requestPermission()
        if (!result.granted) {
          setPasteError(result.canAskAgain
            ? 'Camera access was denied. You can paste the pairing code instead.'
            : 'Camera access is disabled. Paste the pairing code or open device Settings.')
          return
        }
      }
      setScanning(true)
    } catch {
      setPasteError('Camera access could not be checked. Paste the pairing code or open device Settings.')
    }
  }

  const pasteFromClipboard = async () => {
    try {
      const value = await props.runtime.native.clipboardRead()
      if (!value) {
        setPasteError('The clipboard does not contain a pairing code.')
        return
      }
      setInput(value.trim())
      setPasteError('')
    } catch {
      setPasteError('Could not read the clipboard. Paste the code into the field instead.')
    }
  }

  const beginPairing = async () => {
    if (!candidateInput || pairingInFlight.current) return
    pairingInFlight.current = true
    setPairing(true)
    setPasteError('')
    setLogs([])
    try {
      const host = await props.runtime.pair(candidateInput, (entry) => {
        if (!mounted.current) return
        setLogs((current) => [...current, entry].slice(-200))
      })
      if (!mounted.current) return
      pairingInFlight.current = false
      setPairing(false)
      props.onPaired(host)
    } catch (error) {
      if (!mounted.current) return
      pairingInFlight.current = false
      setPairing(false)
      setPasteError(error instanceof Error && /timed out/i.test(error.message)
        ? 'Pairing timed out. Review the redacted pairing log and try again.'
        : 'Pairing failed. No host was reported as paired; review the redacted log and retry.')
    }
  }

  const cancel = () => {
    if (pairingInFlight.current) {
      props.runtime.cancelPairing()
      pairingInFlight.current = false
      setPairing(false)
    }
    props.onCancel()
  }

  const openSettings = async () => {
    try { await props.runtime.native.openSystemSettings() } catch { setPasteError('Device Settings could not be opened.') }
  }

  return (
    <KeyboardAvoidingView style={uiStyles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={uiStyles.scroll} keyboardShouldPersistTaps="handled">
        <ScreenHeader title={pairing ? 'Pairing desktop' : 'Pair desktop'} onBack={pairing ? undefined : cancel} />
        {!pairing && !preview && (
          <>
            <Text style={uiStyles.title}>Connect your desktop</Text>
            <Text style={uiStyles.subtitle}>Open Quirky on your computer, show its mobile pairing QR code, then scan it or paste its pairing code.</Text>
            {scanning ? (
              <View style={styles.cameraFrame}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => {
                    if (!scanning) return
                    review(data)
                  }}
                />
                <View pointerEvents="none" style={styles.scanFrame} />
                <ActionButton title="Stop scanning" secondary onPress={() => setScanning(false)} />
              </View>
            ) : (
              <ActionButton title={permission?.granted ? 'Scan pairing QR code' : 'Allow camera and scan'} onPress={() => void startScan()} />
            )}
            {permission?.status === 'denied' && !permission.canAskAgain && <ActionButton title="Open camera settings" secondary onPress={() => void openSettings()} />}
            <View style={uiStyles.card}>
              <Text style={styles.cardTitle}>Or paste a pairing code</Text>
              <Text style={uiStyles.muted}>Paste the bare code or a quirky://pair link from the desktop.</Text>
              <TextInput
                accessibilityLabel="Pairing code"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                value={input}
                onChangeText={(value) => { setInput(value); setCandidateInput(null); setPreview(null); setPasteError('') }}
                placeholder="Paste pairing code"
                placeholderTextColor="#7f8da2"
                style={uiStyles.input}
                textContentType="oneTimeCode"
              />
              <View style={uiStyles.row}>
                <ActionButton title="Paste from clipboard" secondary onPress={() => void pasteFromClipboard()} />
                <ActionButton title="Review code" onPress={() => review(input)} disabled={!input.trim()} />
              </View>
            </View>
          </>
        )}
        {!pairing && preview && (
          <>
            <View style={uiStyles.card}>
              <Text style={uiStyles.title}>Pair with this desktop?</Text>
              <Text style={uiStyles.body}>This link requests a direct encrypted connection to:</Text>
              <Text accessibilityRole="header" style={styles.endpoint}>{preview.desktopAddress}</Text>
              <Text style={uiStyles.muted}>The desktop’s pinned public key will be checked before its credential is saved. No connection starts until you choose Pair.</Text>
              <View style={uiStyles.row}>
                <ActionButton title="Cancel" secondary onPress={() => { setPreview(null); setCandidateInput(null); setInput(''); if (props.initialInput) props.onCancel() }} />
                <ActionButton title="Pair desktop" onPress={() => void beginPairing()} disabled={!candidateInput} />
              </View>
              {!props.initialInput && <ActionButton title="Use a different code" secondary onPress={() => { setPreview(null); setCandidateInput(null) }} />}
            </View>
            {logs.some((entry) => entry.stage.endsWith('-failed')) && (
              <View style={uiStyles.card}>
                <Text style={styles.cardTitle}>Redacted pairing log</Text>
                {logs.slice(-200).map((entry, index) => <Text key={`${entry.at}-${index}`} style={uiStyles.muted}>{entry.stage}: {entry.message}</Text>)}
              </View>
            )}
          </>
        )}
        {pairing && (
          <>
            <Notice>Connecting directly to {preview?.desktopAddress ?? 'the desktop'} with encrypted v2. The pairing credential is not saved until the desktop identity and authentication proof are verified.</Notice>
            <View style={uiStyles.card}>
              <Text style={styles.cardTitle}>Pairing log</Text>
              {logs.map((entry, index) => <Text key={`${entry.at}-${index}`} style={uiStyles.muted}>{entry.stage}: {entry.message}</Text>)}
              {logs.length === 0 && <Text style={uiStyles.muted}>Validating the mobile offer…</Text>}
            </View>
            <ActionButton title="Cancel pairing" secondary onPress={cancel} />
          </>
        )}
        {!!pasteError && <Notice tone="error">{pasteError}</Notice>}
        {!pairing && <ActionButton title="Back to home" secondary onPress={cancel} />}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  cameraFrame: { height: 360, borderRadius: 18, overflow: 'hidden', justifyContent: 'flex-end', padding: 18, backgroundColor: '#141c2a' },
  scanFrame: { position: 'absolute', top: 78, left: 42, right: 42, bottom: 82, borderWidth: 2, borderRadius: 20, borderColor: '#76a9ff' },
  cardTitle: { color: '#f3f6fc', fontSize: 18, fontWeight: '700' },
  endpoint: { color: '#91bbff', fontSize: 18, fontWeight: '700' }
})
