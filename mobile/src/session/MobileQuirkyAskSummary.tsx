import { Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import type { AskStatus } from '../../../src/shared/fork-ask-question-tool/ask-answer-envelope'
import type { MobileAsk } from '../ask/ask-registry-state'
import { colors, spacing, typography } from '../theme/mobile-theme'

const STATUS_LABELS: Record<AskStatus, string> = {
  registered: 'Waiting',
  pending: 'Waiting',
  answered: 'Answered',
  partial: 'Partly answered',
  declined: 'Declined',
  timed_out: 'Timed out',
  unavailable: 'Unavailable'
}

/** What is left of an ask once it settles: a one-line outcome the user can dismiss. */
export function MobileQuirkyAskSummary({
  ask,
  onDismiss
}: {
  ask: MobileAsk
  onDismiss: () => void
}): React.JSX.Element {
  const answered = ask.status === 'answered'
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={[styles.status, answered && styles.statusAnswered]}>
          {STATUS_LABELS[ask.status]}
        </Text>
        {ask.result?.summary ? (
          <Text style={styles.summary} numberOfLines={3}>
            {ask.result.summary}
          </Text>
        ) : null}
      </View>
      <Pressable onPress={onDismiss} accessibilityLabel="Dismiss answered question" hitSlop={8}>
        <X size={16} color={colors.textMuted} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  text: { flex: 1, gap: 2 },
  status: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '700' },
  statusAnswered: { color: colors.statusGreen },
  summary: { color: colors.textSecondary, fontSize: typography.metaSize }
})
