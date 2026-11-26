import { translate } from '@/i18n/i18n'
import { useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import type { StructuredPromptItem } from '../../native-chat/use-structured-agent-session'
import type { AgentSessionPromptResponse } from '../../../../../shared/agent-session-question-answer'
import type { AgentSessionPromptResult } from '../../../../../shared/agent-session-wire'
import { ChatMarkdown } from '../markdown'
import { openPanelLink, type PanelLinkOpener } from './panel-link-opening'
import {
  planAnswerTarget,
  planStatusWords,
  planVersionMarker,
  planVersionsNewestFirst,
  type PlanAnswerTarget,
  type PlanRenderItem
} from './plan-versions'
import './panels.css'

const PRESENT_AGAIN = 'Please present the plan again.'

export type PlanPanelProps = {
  items: AgentJournalRenderItem[]
  prompts: StructuredPromptItem[]
  respond: (
    item: StructuredPromptItem,
    response: AgentSessionPromptResponse
  ) => Promise<AgentSessionPromptResult | null>
  /** A version number to show; the panel follows it whenever it changes. */
  openVersion?: number
  onClose(): void
  /** Sends a chat message. Without it Keep planning takes no feedback text. */
  onSendMessage?: (text: string) => Promise<unknown> | void
  onOpenLink?: PanelLinkOpener
}

const BADGE_VARIANT = {
  waiting: 'default',
  revised: 'outline',
  approved: 'secondary',
  'not-answered': 'outline'
} as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type AnswerControlsProps = {
  target: PlanAnswerTarget
  respond: PlanPanelProps['respond']
  onSendMessage: PlanPanelProps['onSendMessage']
}

/** Approve and Keep planning for the one waiting plan; feedback text rides as a chat message. */
function PlanAnswerControls({ target, respond, onSendMessage }: AnswerControlsProps) {
  const [feedback, setFeedback] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const answer = async (optionId: string, followUp?: string) => {
    setBusy(true)
    setProblem(null)
    try {
      const result = await respond(target.prompt, { kind: 'option', optionId })
      if (result === null) {
        throw new Error('This host did not take the answer.')
      }
      if (followUp) {
        await onSendMessage?.(followUp)
      }
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const keepOptionId = target.keepOptionId
  const askingForFeedback = feedback !== null && keepOptionId !== null
  return (
    <div className="native-chat-panel-plan-answers" data-plan-answers>
      {problem !== null && (
        <p role="alert" className="native-chat-panel-problem">
          {problem}
        </p>
      )}
      {askingForFeedback ? (
        <>
          <Textarea
            aria-label={translate(
              'components.chat.panels.planFeedbackLabel',
              'What should Claude change?'
            )}
            placeholder={translate(
              'components.chat.panels.planFeedbackPlaceholder',
              'What should Claude change?'
            )}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className="native-chat-panel-row">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void answer(keepOptionId, feedback.trim())}
            >
              {translate('components.chat.panels.planSendToClaude', 'Send to Claude')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setFeedback(null)}>
              {translate('components.chat.panels.planFeedbackCancel', 'Cancel')}
            </Button>
          </div>
        </>
      ) : (
        <div className="native-chat-panel-row">
          {target.approveOptionId !== null && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void answer(target.approveOptionId ?? '')}
            >
              {translate('components.chat.panels.planApprove', 'Approve')}
            </Button>
          )}
          {keepOptionId !== null && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                onSendMessage === undefined ? void answer(keepOptionId) : setFeedback('')
              }
            >
              {translate('components.chat.panels.planKeepPlanning', 'Keep planning')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function PlanBody({
  plan,
  onSendMessage,
  onOpenLink,
  newest
}: {
  plan: PlanRenderItem
  onSendMessage: PlanPanelProps['onSendMessage']
  onOpenLink: PanelLinkOpener
  newest: boolean
}) {
  const { body } = plan
  const restarted = newest && body.status === 'not-answered' && body.reason === 'restarted'
  return (
    <div className="native-chat-panel-plan-body">
      {restarted && (
        <p className="native-chat-panel-note">
          {translate(
            'components.chat.panels.planRestarted',
            'Quirky restarted before you answered. The agent is no longer waiting on this plan.'
          )}
          {onSendMessage !== undefined && (
            <Button size="xs" variant="outline" onClick={() => void onSendMessage(PRESENT_AGAIN)}>
              {translate(
                'components.chat.panels.planPresentAgain',
                'Ask it to present the plan again'
              )}
            </Button>
          )}
        </p>
      )}
      {body.empty === true ? (
        <p className="native-chat-panel-muted">
          {translate('components.chat.panels.planEmpty', 'The agent sent an empty plan.')}
        </p>
      ) : (
        <ChatMarkdown text={body.text} onOpenLink={onOpenLink} />
      )}
      {body.filePath !== undefined && (
        <p className="native-chat-panel-muted">
          {translate('components.chat.panels.planFile', 'Plan file:')}{' '}
          <span className="native-chat-panel-mono">{body.filePath}</span>
        </p>
      )}
    </div>
  )
}

/**
 * Every plan version the agent proposed, newest first, with the selected version's text. Only the
 * waiting version whose approval is still pending can be answered, so older versions are read-only.
 */
export function PlanPanel({
  items,
  prompts,
  respond,
  openVersion,
  onClose,
  onSendMessage,
  onOpenLink = openPanelLink
}: PlanPanelProps) {
  const versions = planVersionsNewestFirst(items)
  const [picked, setPicked] = useState<number | null>(null)
  const [seenOpenVersion, setSeenOpenVersion] = useState(openVersion)
  if (seenOpenVersion !== openVersion) {
    setSeenOpenVersion(openVersion)
    setPicked(null)
  }
  const wanted = picked ?? openVersion
  const selected = versions.find((plan) => plan.body.version === wanted) ?? versions[0]
  const target = selected ? planAnswerTarget(selected, prompts) : null

  return (
    <section
      className="native-chat-panel-panel"
      aria-label={translate('components.chat.panels.planPanelLabel', 'Plan')}
      data-plan-panel
    >
      <header className="native-chat-panel-panel-header">
        <h3 className="native-chat-panel-panel-title">
          {translate('components.chat.panels.planTitle', 'Plan')}
        </h3>
        {selected && (
          <span className="native-chat-panel-muted">{planVersionMarker(selected.body)}</span>
        )}
        <Button
          className="ml-auto"
          size="icon-xs"
          variant="ghost"
          aria-label={translate('components.chat.panels.planClose', 'Close plan')}
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {selected === undefined ? (
        <p className="native-chat-panel-muted native-chat-panel-pad">
          {translate('components.chat.panels.planNone', 'No plan yet.')}
        </p>
      ) : (
        <>
          <ul
            className="native-chat-panel-version-list"
            aria-label={translate('components.chat.panels.planVersions', 'Plan versions')}
          >
            {versions.map((plan) => (
              <li key={plan.body.version}>
                <button
                  type="button"
                  className="native-chat-panel-version"
                  data-selected={plan.body.version === selected.body.version || undefined}
                  aria-current={plan.body.version === selected.body.version || undefined}
                  onClick={() => setPicked(plan.body.version)}
                >
                  <span>{`v${plan.body.version}`}</span>
                  <Badge variant={BADGE_VARIANT[plan.body.status]}>
                    {planStatusWords(plan.body.status)}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
          <PlanBody
            plan={selected}
            newest={selected === versions[0]}
            onSendMessage={onSendMessage}
            onOpenLink={onOpenLink}
          />
          {target !== null && (
            <PlanAnswerControls
              key={target.prompt.itemId}
              target={target}
              respond={respond}
              onSendMessage={onSendMessage}
            />
          )}
        </>
      )}
    </section>
  )
}
