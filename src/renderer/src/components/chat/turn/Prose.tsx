import { ChatMarkdown } from '../markdown'
import { useChatTurnEnv } from './chat-turn-env'

/** An agent's reply on the shared markdown renderer; links and file chips open through the chat. */
export function Prose({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): React.JSX.Element {
  const { markdown } = useChatTurnEnv()
  return (
    <div className="min-w-0 text-sm text-chat-foreground [overflow-wrap:anywhere]">
      <ChatMarkdown
        text={text}
        streaming={streaming}
        onOpenLink={markdown.onOpenLink}
        {...(markdown.assets ? { assets: markdown.assets } : {})}
      />
    </div>
  )
}
