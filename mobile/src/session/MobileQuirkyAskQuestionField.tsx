import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { AskQuestion } from '../../../src/shared/fork-ask-question-tool/ask-question-schema'
import type { AskQuestionDraft } from '../ask/ask-answer-drafts'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type Props = {
  question: AskQuestion
  draft: AskQuestionDraft
  error: string | undefined
  disabled: boolean
  onChange: (draft: AskQuestionDraft) => void
}

export function MobileQuirkyAskQuestionField({
  question,
  draft,
  error,
  disabled,
  onChange
}: Props): React.JSX.Element {
  return (
    <View style={styles.field}>
      {question.header ? <Text style={styles.header}>{question.header}</Text> : null}
      <Text style={styles.question}>{question.question}</Text>
      {!question.required ? <Text style={styles.optional}>Optional</Text> : null}
      <QuestionInput question={question} draft={draft} disabled={disabled} onChange={onChange} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

function QuestionInput({
  question,
  draft,
  disabled,
  onChange
}: Omit<Props, 'error'>): React.JSX.Element {
  switch (question.type) {
    case 'select':
    case 'multiselect': {
      const multi = question.type === 'multiselect'
      return (
        <View>
          {question.options.map((option) => {
            const selected = draft.selected.includes(option.value)
            return (
              <Pressable
                key={option.value}
                style={[styles.option, selected && styles.optionSelected]}
                disabled={disabled}
                accessibilityRole={multi ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: selected, disabled }}
                onPress={() =>
                  onChange({
                    ...draft,
                    selected: multi
                      ? selected
                        ? draft.selected.filter((value) => value !== option.value)
                        : [...draft.selected, option.value]
                      : selected
                        ? []
                        : [option.value]
                  })
                }
              >
                <View
                  style={[
                    styles.check,
                    multi ? styles.checkSquare : styles.checkCircle,
                    selected && styles.checkOn
                  ]}
                >
                  {selected ? <Check size={12} color={colors.bgBase} strokeWidth={3} /> : null}
                </View>
                <View style={styles.optionBody}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {option.description ? (
                    <Text style={styles.optionDescription} numberOfLines={3}>
                      {option.description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            )
          })}
          <TextInput
            style={styles.input}
            value={draft.freeText}
            editable={!disabled}
            onChangeText={(freeText) => onChange({ ...draft, freeText })}
            placeholder={multi ? 'Other answer (optional)' : 'Other answer or a note (optional)'}
            placeholderTextColor={colors.textMuted}
            multiline
          />
        </View>
      )
    }
    case 'text':
      return (
        <TextInput
          style={[styles.input, question.multiline && styles.inputMultiline]}
          value={draft.text}
          editable={!disabled}
          onChangeText={(text) => onChange({ ...draft, text })}
          placeholder="Type your answer"
          placeholderTextColor={colors.textMuted}
          multiline={question.multiline === true}
          autoCapitalize={question.format ? 'none' : 'sentences'}
          autoCorrect={question.format === undefined}
          keyboardType={
            question.format === 'email'
              ? 'email-address'
              : question.format === 'url'
                ? 'url'
                : 'default'
          }
        />
      )
    case 'number':
      return (
        <TextInput
          style={styles.input}
          value={draft.text}
          editable={!disabled}
          onChangeText={(text) => onChange({ ...draft, text })}
          placeholder={question.integer ? 'Whole number' : 'Number'}
          placeholderTextColor={colors.textMuted}
          keyboardType="numbers-and-punctuation"
          autoCorrect={false}
        />
      )
    case 'date':
      return (
        <TextInput
          style={styles.input}
          value={draft.text}
          editable={!disabled}
          onChangeText={(text) => onChange({ ...draft, text })}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.textMuted}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={10}
        />
      )
    case 'confirm':
      return (
        <View style={styles.confirmRow}>
          {([true, false] as const).map((value) => {
            const selected = draft.confirm === value
            return (
              <Pressable
                key={String(value)}
                style={[styles.confirmButton, selected && styles.optionSelected]}
                disabled={disabled}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled }}
                onPress={() => onChange({ ...draft, confirm: selected ? null : value })}
              >
                <Text style={styles.optionLabel}>{value ? 'Yes' : 'No'}</Text>
              </Pressable>
            )
          })}
        </View>
      )
  }
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  header: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 2
  },
  question: {
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    fontWeight: '600',
    marginBottom: spacing.xs
  },
  optional: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginBottom: spacing.xs
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    marginBottom: spacing.xs
  },
  optionSelected: { borderColor: colors.statusGreen },
  check: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkCircle: { borderRadius: 9 },
  checkSquare: { borderRadius: 4 },
  checkOn: { backgroundColor: colors.statusGreen, borderColor: colors.statusGreen },
  optionBody: { flex: 1, gap: 2 },
  optionLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  optionDescription: { color: colors.textSecondary, fontSize: typography.metaSize },
  input: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    padding: spacing.sm,
    minHeight: 44
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  confirmRow: { flexDirection: 'row', gap: spacing.sm },
  confirmButton: {
    flex: 1,
    alignItems: 'center',
    padding: spacing.sm,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  error: { color: colors.statusRed, fontSize: typography.metaSize, marginTop: spacing.xs }
})
