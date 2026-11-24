import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  dismissRetainedHandoffBrief,
  getRetainedHandoffBrief,
  resendRetainedHandoffBrief
} from '@/lib/fork-session-handoff/launch-session-handoff'

function deliveryToastId(tabId: string): string {
  return `fork-session-handoff-delivery:${tabId}`
}

export function notifyHandoffDelivery(
  tabId: string | null,
  deliveryOutcome: Promise<'delivered' | 'not-delivered' | 'unobservable'>
): void {
  void deliveryOutcome.then((outcome) => {
    if (outcome === 'delivered') {
      toast.success(
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.deliverySucceeded',
          'The handoff brief was sent.'
        )
      )
      return
    }
    if (!tabId) {
      toast.error(
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.deliveryUnconfirmedNoResend',
          'The new session opened, but brief delivery could not be confirmed and resend is unavailable.'
        )
      )
      return
    }
    if (outcome === 'not-delivered' && !getRetainedHandoffBrief(tabId)) {
      toast.success(
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.deliveryAutomaticRetrySucceeded',
          'The initial delivery failed, then Quirky resent the brief.'
        )
      )
      return
    }
    showDeliveryRecoveryToast(tabId, outcome === 'unobservable')
  })
}

function showDeliveryRecoveryToast(tabId: string, doubleSendRisk: boolean): void {
  const id = deliveryToastId(tabId)
  toast.warning(
    doubleSendRisk
      ? translate(
          'components.agentSessionContinuation.forkSessionHandoff.deliveryUnconfirmed',
          'Brief delivery could not be confirmed.'
        )
      : translate(
          'components.agentSessionContinuation.forkSessionHandoff.deliveryFailedRetry',
          'Brief delivery and the automatic retry failed.'
        ),
    {
      id,
      description: (
        <HandoffDeliveryRecoveryAction tabId={tabId} toastId={id} doubleSendRisk={doubleSendRisk} />
      ),
      dismissible: true,
      duration: Infinity,
      onDismiss: () => {
        dismissRetainedHandoffBrief(tabId)
      }
    }
  )
}

export function HandoffDeliveryRecoveryAction({
  tabId,
  toastId,
  doubleSendRisk
}: {
  tabId: string
  toastId: string
  doubleSendRisk: boolean
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)

  const resend = async (): Promise<void> => {
    setSending(true)
    const outcome = await resendRetainedHandoffBrief(tabId)
    setSending(false)
    if (outcome === 'resent') {
      toast.dismiss(toastId)
      toast.success(
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.resendSucceeded',
          'The handoff brief was resent.'
        )
      )
      return
    }
    toast.error(
      translate(
        'components.agentSessionContinuation.forkSessionHandoff.resendFailed',
        'The handoff brief could not be resent.'
      )
    )
  }

  if (confirming) {
    return (
      <div className="space-y-2">
        <p>
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.resendMayDuplicate',
            'The brief may already have arrived. Sending again can create a duplicate turn.'
          )}
        </p>
        <div className="flex gap-1.5">
          <Button type="button" size="xs" disabled={sending} onClick={() => void resend()}>
            {sending
              ? translate(
                  'components.agentSessionContinuation.forkSessionHandoff.resending',
                  'Resending…'
                )
              : translate(
                  'components.agentSessionContinuation.forkSessionHandoff.sendAgain',
                  'Send again'
                )}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setConfirming(false)}>
            {translate('components.native-chat.question.cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p>
        {doubleSendRisk
          ? translate(
              'components.agentSessionContinuation.forkSessionHandoff.resendManualOnly',
              'Resend is manual because the target Agent does not expose delivery evidence.'
            )
          : translate(
              'components.agentSessionContinuation.forkSessionHandoff.resendAvailable',
              'The brief is retained for another manual attempt.'
            )}
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={sending}
        onClick={() => (doubleSendRisk ? setConfirming(true) : void resend())}
      >
        {translate(
          'components.agentSessionContinuation.forkSessionHandoff.resendBrief',
          'Resend brief'
        )}
      </Button>
    </div>
  )
}
