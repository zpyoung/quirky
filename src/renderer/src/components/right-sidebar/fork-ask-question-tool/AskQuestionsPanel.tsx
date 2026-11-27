import { useEffect } from 'react'
import { MessageCircleQuestionMark } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { AskCard } from '@/components/fork-ask-question-tool/AskCard'
import { useAskPaneDock } from '@/components/fork-ask-question-tool/use-ask-pane-dock'
import { useFocusedPaneKey } from '../fork-session-info/focused-session-info'

function NoQuestionsState(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-12 text-center">
      <div className="mb-3 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MessageCircleQuestionMark className="size-4" />
      </div>
      <h2 className="text-sm font-medium text-foreground">
        {translate('components.fork-ask-question-tool.askPanel.empty', 'No questions')}
      </h2>
      <p className="mt-1 max-w-52 text-xs leading-relaxed text-muted-foreground">
        {translate(
          'components.fork-ask-question-tool.askPanel.emptyDescription',
          'A question waiting on your answer appears here.'
        )}
      </p>
    </div>
  )
}

/**
 * The focused session's outstanding question. Follows whichever pane is focused rather than
 * binding to one, so the panel shows the same session the rest of the sidebar describes.
 */
export default function AskQuestionsPanel(): React.JSX.Element {
  const paneKey = useFocusedPaneKey()
  const { model, isSubmitting, submitError, onSubmit, onCancel, onDraftChange } =
    useAskPaneDock(paneKey)

  const setAskPanelShownAskId = useAppStore((state) => state.setAskPanelShownAskId)
  const shownAskId = model?.askId ?? null
  useEffect(() => {
    setAskPanelShownAskId(shownAskId)
    return () => setAskPanelShownAskId(null)
  }, [shownAskId, setAskPanelShownAskId])

  if (!model) {
    return <NoQuestionsState />
  }

  // No wrapper: the card is already the flex child that has to shrink, and nesting a second
  // identical flex column would give its footer somewhere to overflow to.
  return (
    <AskCard
      key={model.askId}
      model={model}
      onSubmit={onSubmit}
      onCancel={onCancel}
      isSubmitting={isSubmitting}
      submitError={submitError}
      onDraftChange={onDraftChange}
    />
  )
}
