import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** Copies the chat's Quirky session ID from the host: `quirky_session_id:<root>`, which `/clear` keeps. */
export function NativeChatCopyQuirkySessionIdMenuItem({
  resolveQuirkySessionId
}: {
  resolveQuirkySessionId: () => Promise<string | null>
}): React.JSX.Element {
  const copyQuirkySessionId = async (): Promise<void> => {
    try {
      const quirkySessionId = await resolveQuirkySessionId()
      if (!quirkySessionId) {
        throw new Error('no Quirky session ID')
      }
      await window.api.ui.writeClipboardText(quirkySessionId)
      toast.success(
        translate(
          'components.native-chat.contextMenu.quirkySessionIdCopied',
          'Quirky session ID copied'
        )
      )
    } catch {
      toast.error(
        translate(
          'components.native-chat.contextMenu.quirkySessionIdCopyFailed',
          'Unable to copy Quirky session ID'
        )
      )
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem onSelect={() => void copyQuirkySessionId()}>
          <Copy />
          {translate(
            'components.native-chat.contextMenu.copyQuirkySessionId',
            'Copy Quirky Session ID'
          )}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {translate(
          'components.native-chat.contextMenu.quirkySessionIdTooltip',
          "Quirky's ID for this chat, separate from the agent CLI's own session ID. Agents use it to refer to each other through Quirky."
        )}
      </TooltipContent>
    </Tooltip>
  )
}
