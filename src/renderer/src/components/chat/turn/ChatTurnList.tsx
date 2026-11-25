import { memo } from 'react'
import type { ChatTurn } from '../chat-turns'
import { Turn } from './Turn'

/** The turns of a chat, oldest first. */
export const ChatTurnList = memo(function ChatTurnList({
  turns
}: {
  turns: readonly ChatTurn[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4" role="log" aria-label="Chat">
      {turns.map((turn, index) => (
        <Turn key={turn.key} turn={turn} index={index} />
      ))}
    </div>
  )
})
