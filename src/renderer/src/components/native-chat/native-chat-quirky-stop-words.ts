// The words for a reply Quirky's own stop cut off, by cause and machine. One function, so the chat's
// row wording can change in one place.

import { translate } from '@/i18n/i18n'
import type { AgentSessionQuirkyStopCause } from '../../../../shared/agent-session-quirky-stop'
import { joinSentences } from '../../../../shared/sentence-joining'

const STOPPED: Record<AgentSessionQuirkyStopCause, (machine: string) => string> = {
  update: (machine) =>
    translate(
      'components.native-chat.notices.quirkyStopUpdate',
      'Quirky on {{machine}} restarted for an update while this response was in progress.',
      { machine }
    ),
  quit: (machine) =>
    translate(
      'components.native-chat.notices.quirkyStopQuit',
      'Quirky on {{machine}} was closed while this response was in progress.',
      { machine }
    ),
  crash: (machine) =>
    translate(
      'components.native-chat.notices.quirkyStopCrash',
      'Quirky on {{machine}} stopped unexpectedly while this response was in progress.',
      { machine }
    )
}

// A remote graceful stop is a server stop or a shared desktop's quit; "stopped" is true of both.
const remoteQuit = (machine: string): string =>
  translate(
    'components.native-chat.notices.quirkyStopRemote',
    'Quirky on {{machine}} stopped while this response was in progress.',
    { machine }
  )

function stoppedSentence(
  cause: AgentSessionQuirkyStopCause,
  machine: string,
  remoteHost: boolean
): string {
  return cause === 'quit' && remoteHost ? remoteQuit(machine) : STOPPED[cause](machine)
}

/** The row's sentence. Where the host can continue a cut, Continue is the way on, so the row does
 *  not say it again; decided by the host, not the button, so the words never change on screen. */
export function nativeChatQuirkyStopRowText(
  cause: AgentSessionQuirkyStopCause,
  machine: string,
  options: { continueAvailable: boolean; remoteHost: boolean }
): string {
  const stopped = stoppedSentence(cause, machine, options.remoteHost)
  return options.continueAvailable
    ? stopped
    : joinSentences([
        stopped,
        translate(
          'components.native-chat.notices.quirkyStopCanContinue',
          'You can continue in this conversation.'
        )
      ])
}
