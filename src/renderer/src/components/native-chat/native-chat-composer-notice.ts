// What the notice card above a native chat's composer shows: Quirky's own words, plus, apart from
// them, any error text Quirky did not write, so it can be read and copied as written.

import { translate } from '@/i18n/i18n'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import { isClipboardTextTooLargeError } from '../../../../shared/clipboard-text'

export type NativeChatComposerNoticeContent = {
  text: string
  /** Inline presentation of the sentence when it contains navigation. */
  content?: React.ReactNode
  /** Text from outside Quirky (a host or system error), shown apart and copyable. */
  errorText?: string
}

export type NativeChatComposerNotice = NativeChatComposerNoticeContent & {
  key: string
  action?: { label: string; onClick: () => void; disabled?: boolean }
  onDismiss?: () => void
} & ({ kind: 'error' | 'attachment' | 'device' } | { kind: 'host'; tone: 'warning' | 'muted' })

/** `headline` in Quirky's words, with the error as written beside it. `localErrorIsQuirkyWords`: an
 *  error raised in this window (not wrapped by main-process IPC) is already Quirky's sentence. */
export function nativeChatNoticeFromError(
  error: unknown,
  headline: string,
  options: { localErrorIsQuirkyWords?: boolean } = {}
): NativeChatComposerNoticeContent {
  const detail = error instanceof Error ? readIpcErrorDetail(error) : String(error ?? '').trim()
  if (!detail) {
    return { text: headline }
  }
  const wrapped = error instanceof Error && detail !== error.message.trim()
  return options.localErrorIsQuirkyWords && error instanceof Error && !wrapped
    ? { text: detail }
    : { text: headline, errorText: detail }
}

/** Says `headline` through a notice setter, with the error's own text apart when it has any. */
export function setNativeChatNoticeFromError(
  setNotice: (text: string | null, errorText?: string) => void,
  error: unknown,
  headline: string,
  options: { localErrorIsQuirkyWords?: boolean } = {}
): void {
  const notice = nativeChatNoticeFromError(error, headline, options)
  if (notice.errorText) {
    setNotice(notice.text, notice.errorText)
  } else {
    setNotice(notice.text)
  }
}

/** A failed paste: an error this window raised, or Quirky's own size limit coming back from the main
 *  process, is already Quirky's sentence; any other is kept apart under `headline`. */
export function setNativeChatPasteFailure(
  setNotice: (text: string | null, errorText?: string) => void,
  error: unknown,
  headline = translate('components.native-chat.composer.pasteFailed', 'Paste failed.')
): void {
  if (isClipboardTextTooLargeError(error)) {
    setNotice(readIpcErrorDetail(error) ?? headline)
    return
  }
  setNativeChatNoticeFromError(setNotice, error, headline, { localErrorIsQuirkyWords: true })
}
