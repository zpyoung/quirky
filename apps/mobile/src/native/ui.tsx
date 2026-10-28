import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

export function ActionButton(props: {
  title: string
  onPress(): void
  disabled?: boolean
  secondary?: boolean
  destructive?: boolean
  accessibilityLabel?: string
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.secondary && styles.secondaryButton,
        props.destructive && styles.destructiveButton,
        props.disabled && styles.disabledButton,
        pressed && !props.disabled && styles.pressedButton
      ]}
    >
      <Text style={[styles.buttonText, props.secondary && styles.secondaryText, props.destructive && styles.destructiveText]}>{props.title}</Text>
    </Pressable>
  )
}

export function ScreenHeader(props: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      {props.onBack ? <ActionButton title="Back" secondary onPress={props.onBack} /> : <View style={styles.headerSpacer} />}
      <Text accessibilityRole="header" style={styles.headerTitle}>{props.title}</Text>
      {props.right ?? <View style={styles.headerSpacer} />}
    </View>
  )
}

export function Section(props: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>{props.title}</Text>
      {props.children}
    </View>
  )
}

export function Notice(props: { children: ReactNode; tone?: 'info' | 'warning' | 'error' }) {
  const tone = props.tone ?? 'info'
  return <View style={[styles.notice, tone === 'warning' && styles.warning, tone === 'error' && styles.error]}><Text style={styles.noticeText}>{props.children}</Text></View>
}

export function FieldLabel(props: { title: string; children: ReactNode }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{props.title}</Text>{props.children}</View>
}

export const uiStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0c111b' },
  scroll: { flexGrow: 1, padding: 20, gap: 18, width: '100%', maxWidth: 720, alignSelf: 'center' },
  title: { color: '#f3f6fc', fontSize: 25, fontWeight: '700' },
  subtitle: { color: '#a8b5c8', fontSize: 15, lineHeight: 22 },
  body: { color: '#e2e9f3', fontSize: 15, lineHeight: 22 },
  muted: { color: '#9aa8bb', fontSize: 13, lineHeight: 19 },
  card: { backgroundColor: '#151e2c', borderColor: '#2d3b4f', borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 },
  input: { minHeight: 46, borderWidth: 1, borderColor: '#45556c', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: '#f3f6fc', backgroundColor: '#111927', fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#2d3b4f', marginVertical: 6 }
})

const styles = StyleSheet.create({
  button: { minHeight: 44, minWidth: 88, justifyContent: 'center', alignItems: 'center', borderRadius: 11, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#4c89e8' },
  secondaryButton: { backgroundColor: '#1d293a', borderWidth: 1, borderColor: '#3a4a60' },
  destructiveButton: { backgroundColor: '#8c3040' },
  disabledButton: { opacity: 0.48 },
  pressedButton: { opacity: 0.78 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  secondaryText: { color: '#d8e4f4' },
  destructiveText: { color: '#fff' },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerTitle: { flex: 1, color: '#f3f6fc', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  headerSpacer: { width: 74 },
  section: { gap: 10 },
  sectionTitle: { color: '#c9d4e4', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  notice: { borderRadius: 12, padding: 13, borderWidth: 1, borderColor: '#375071', backgroundColor: '#14233a' },
  warning: { borderColor: '#7a6130', backgroundColor: '#302814' },
  error: { borderColor: '#8a3b48', backgroundColor: '#321920' },
  noticeText: { color: '#e0e9f6', lineHeight: 20, fontSize: 14 },
  field: { gap: 7 },
  fieldLabel: { color: '#b9c5d6', fontSize: 14, fontWeight: '600' }
})
