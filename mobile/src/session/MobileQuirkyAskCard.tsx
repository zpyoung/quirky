import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  askDraftsToPartial,
  buildAskSubmission,
  initialAskDrafts,
  type AskDrafts,
  type AskQuestionDraft
} from '../ask/ask-answer-drafts'
import type { MobileAsk } from '../ask/ask-registry-state'
import { askAnswerRun, askCancelRun, askUpdatePartialRun } from '../ask/mobile-ask-operations'
import type { RpcClient } from '../transport/rpc-client'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { MobileQuirkyAskQuestionField } from './MobileQuirkyAskQuestionField'

const DRAFT_SYNC_DELAY_MS = 600

type Props = {
  ask: MobileAsk
  client: RpcClient
  connected: boolean
  /** Other live asks waiting behind this one. */
  queuedCount: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not reach the host.'
}

/**
 * A question an agent raised through `quirky ask`, answerable from the phone. Keyed by ask id by
 * its parent, so each ask starts from the host's stored draft.
 */
export function MobileQuirkyAskCard({
  ask,
  client,
  connected,
  queuedCount
}: Props): React.JSX.Element {
  const { spec, askId } = ask
  const [drafts, setDrafts] = useState<AskDrafts>(() => initialAskDrafts(spec, ask.partial))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const draftsTouched = useRef(false)

  useEffect(() => {
    if (!draftsTouched.current || !connected) {
      return
    }
    const timer = setTimeout(() => {
      if (!draftsTouched.current) {
        return
      }
      askUpdatePartialRun
        .request(client, { askId, partial: askDraftsToPartial(drafts) })
        .catch(() => {})
    }, DRAFT_SYNC_DELAY_MS)
    return () => clearTimeout(timer)
  }, [askId, client, connected, drafts])

  const changeDraft = (questionId: string, draft: AskQuestionDraft): void => {
    draftsTouched.current = true
    setDrafts((previous) => ({ ...previous, [questionId]: draft }))
    setFieldErrors((previous) => {
      if (!(questionId in previous)) {
        return previous
      }
      const { [questionId]: _cleared, ...rest } = previous
      return rest
    })
    setFormError(null)
  }

  const settle = async (send: () => Promise<string | null>): Promise<void> => {
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    draftsTouched.current = false
    try {
      setFormError(await send())
    } catch (error) {
      setFormError(errorMessage(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const submit = (): Promise<void> =>
    settle(async () => {
      const submission = buildAskSubmission(spec, drafts)
      if (!submission.ok) {
        setFieldErrors(submission.errors)
        return submission.formError
      }
      setFieldErrors({})
      const receipt = askAnswerRun.interpret(
        await askAnswerRun.request(client, {
          askId,
          answers: submission.answers,
          skipped: submission.skipped
        })
      )
      return receipt.committed ? null : 'This question was already answered or closed.'
    })

  const cancel = (): Promise<void> =>
    settle(async () => {
      askCancelRun.interpret(await askCancelRun.request(client, { askId }))
      return null
    })

  const disabled = busy || !connected

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Agent question</Text>
        {queuedCount > 0 ? <Text style={styles.queued}>+{queuedCount} waiting</Text> : null}
      </View>
      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
        {spec.questions.map((question) => (
          <MobileQuirkyAskQuestionField
            key={question.id}
            question={question}
            draft={drafts[question.id] ?? { selected: [], freeText: '', text: '', confirm: null }}
            error={fieldErrors[question.id]}
            disabled={disabled}
            onChange={(draft) => changeDraft(question.id, draft)}
          />
        ))}
      </ScrollView>
      {formError ? <Text style={styles.formError}>{formError}</Text> : null}
      {!connected ? <Text style={styles.offline}>Reconnecting to the host...</Text> : null}
      <View style={styles.footer}>
        <Pressable style={styles.cancel} onPress={cancel} disabled={disabled} hitSlop={8}>
          <Text style={styles.cancelText}>Decline</Text>
        </Pressable>
        <Pressable
          style={[styles.submit, disabled && styles.submitDisabled]}
          onPress={submit}
          disabled={disabled}
          accessibilityRole="button"
        >
          <Text style={[styles.submitText, disabled && styles.submitTextDisabled]}>Submit</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    maxHeight: '60%',
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md
  },
  title: { color: colors.accent, fontSize: typography.metaSize, fontWeight: '700' },
  queued: { color: colors.textMuted, fontSize: typography.metaSize },
  body: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, flexGrow: 0 },
  formError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.md
  },
  offline: {
    color: colors.statusAmber,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.md
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    gap: spacing.sm
  },
  cancel: { paddingVertical: spacing.sm, paddingHorizontal: spacing.sm },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  submit: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary
  },
  submitDisabled: { backgroundColor: colors.bgRaised },
  submitText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '700' },
  submitTextDisabled: { color: colors.textMuted }
})
