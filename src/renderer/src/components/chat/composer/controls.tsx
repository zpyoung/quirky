import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function AttachButton({
  disabled,
  reason,
  onAttach
}: {
  disabled: boolean
  reason?: string
  onAttach: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Attach files"
      title={reason ?? 'Attach files or images'}
      disabled={disabled}
      onClick={onAttach}
    >
      <Paperclip />
    </Button>
  )
}

export function StopButton({ onStop }: { onStop: () => void }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="destructive"
      size="icon-xs"
      aria-label="Stop"
      title="Stop (Esc)"
      onClick={onStop}
    >
      <Square />
    </Button>
  )
}

export function SendButton({
  disabled,
  title,
  onSend
}: {
  disabled: boolean
  title: string
  onSend: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="icon-xs"
      aria-label="Send"
      title={title}
      disabled={disabled}
      onClick={onSend}
    >
      <ArrowUp />
    </Button>
  )
}
