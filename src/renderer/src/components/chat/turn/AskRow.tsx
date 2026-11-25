import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { agentSessionPromptQuestions } from '../../../../../shared/agent-session-question-answer'
import type { AgentSessionPromptResponse } from '../../../../../shared/agent-session-question-answer'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject
} from '../../../../../shared/agent-session-approval-subject'
import { NativeChatStructuredQuestionCard } from '../../native-chat/NativeChatStructuredQuestionCard'
import type { RenderItemOf } from '../chat-turns'
import { ChatMarkdown } from '../markdown'
import { useChatTurnEnv } from './chat-turn-env'

type AskItem = RenderItemOf<'approval'> | RenderItemOf<'question'>

function resolvedWords(item: AskItem): string {
  const { resolution } = item.body
  if (resolution.state === 'cancelled') {
    return 'Dismissed'
  }
  const chosen = item.body.options.find((option) => option.id === resolution.selectedOptionId)
  return chosen ? chosen.label : 'Answered'
}

function ApprovalControls({ item }: { item: RenderItemOf<'approval'> }): React.JSX.Element {
  const { respond, cancelAsk, markdown } = useChatTurnEnv()
  const [submitting, setSubmitting] = useState(false)
  const { body } = item
  const newer = isNewerApprovalSubject(body.subject)
  const choose = (response: AgentSessionPromptResponse): void => {
    setSubmitting(true)
    void respond(item, response).finally(() => setSubmitting(false))
  }
  const context = [body.description, body.decisionReason, body.blockedPath].filter(
    (part): part is string => typeof part === 'string' && part !== ''
  )
  return (
    <div className="flex flex-col gap-2" data-chat-ask="approval">
      <p className="text-sm font-medium">{body.displayName ?? body.title}</p>
      {context.map((line) => (
        <p key={line} className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {line}
        </p>
      ))}
      {isPlanApprovalSubject(body.subject) ? (
        <div className="max-h-64 overflow-auto text-sm scrollbar-sleek">
          <ChatMarkdown text={body.subject.text} onOpenLink={markdown.onOpenLink} />
        </div>
      ) : (
        body.detail && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1 font-mono text-chat-code scrollbar-sleek">
            {body.detail}
          </pre>
        )
      )}
      <div className="flex flex-wrap gap-2">
        {newer ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => cancelAsk(item)}
          >
            Cancel
          </Button>
        ) : (
          body.options.map((option, index) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={index === 0 ? 'default' : 'outline'}
              disabled={submitting}
              title={option.description}
              onClick={() => choose({ kind: 'option', optionId: option.id })}
            >
              {option.label}
            </Button>
          ))
        )}
      </div>
    </div>
  )
}

/** An approval or question in the turn: its answer controls while the person can answer it, a one-line record after. */
export function AskRow({ item }: { item: AskItem }): React.JSX.Element {
  const { answerableAskIds, respond, cancelAsk } = useChatTurnEnv()
  const [submitting, setSubmitting] = useState(false)
  const answerable = item.body.resolution.state === 'pending' && answerableAskIds.has(item.itemId)
  if (!answerable) {
    const title =
      item.body.kind === 'approval'
        ? (item.body.displayName ?? item.body.title)
        : item.body.question
    return (
      <div
        data-chat-ask="resolved"
        className="flex min-w-0 items-center gap-2 text-xs text-chat-foreground-faint"
      >
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0">
          {item.body.resolution.state === 'pending' ? 'Waiting' : resolvedWords(item)}
        </span>
      </div>
    )
  }
  if (item.body.kind === 'approval') {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-card-foreground">
        <ApprovalControls item={{ ...item, body: item.body }} />
      </div>
    )
  }
  const body = item.body
  return (
    <div
      className="rounded-lg border border-border bg-card text-card-foreground"
      data-chat-ask="question"
    >
      <NativeChatStructuredQuestionCard
        questions={agentSessionPromptQuestions(body)}
        isSubmitting={submitting}
        onAnswer={(response) => {
          setSubmitting(true)
          void respond({ ...item, body }, response).finally(() => setSubmitting(false))
        }}
        onCancel={() => cancelAsk({ ...item, body })}
      />
    </div>
  )
}
