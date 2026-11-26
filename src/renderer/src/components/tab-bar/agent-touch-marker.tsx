import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bot } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  AGENT_TOUCH_WINDOW_MS,
  getAgentActivitySnapshot,
  latestTouchFor,
  subscribeAgentActivity
} from '@/lib/agent-activity-trail-store'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const FADE_OUT_MS = 300

type AgentTouchMarkerProps = {
  /** Every id the tab is known by; an agent may name it by its unified or its entity id. */
  tabIds: readonly string[]
}

/** A small badge on a tab an agent opened or focused, fading out once the touch window ends. */
export function AgentTouchMarker({ tabIds }: AgentTouchMarkerProps): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(subscribeAgentActivity, getAgentActivitySnapshot)
  // a stale clock only ever errs toward "still active"; the timers below refresh it at each boundary
  const [now, setNow] = useState(() => Date.now())
  const touch = latestTouchFor(snapshot, tabIds)
  const fadeStartsAt = touch ? touch.at + AGENT_TOUCH_WINDOW_MS : null

  useEffect(() => {
    if (fadeStartsAt === null) {
      return
    }
    const current = Date.now()
    const timers = [fadeStartsAt, fadeStartsAt + FADE_OUT_MS]
      .filter((at) => at > current)
      .map((at) => setTimeout(() => setNow(Date.now()), at - current))
    return () => timers.forEach(clearTimeout)
  }, [fadeStartsAt])

  if (!touch || fadeStartsAt === null || now >= fadeStartsAt + FADE_OUT_MS) {
    return null
  }
  const label = translate(
    'components.tabBar.agentTouchMarker.label',
    'Opened or focused by {{caller}}',
    {
      caller: touch.caller.label
    }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          data-testid="agent-touch-marker"
          className={`pointer-events-auto absolute right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity duration-300 motion-reduce:transition-none ${
            now >= fadeStartsAt ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <Bot className="size-2.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
