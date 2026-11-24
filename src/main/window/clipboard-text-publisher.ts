import { clipboard } from 'electron'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'
import { writeClipboardTextAndVerify } from './clipboard-text-write-verify'

export type ClipboardTextWriteKind = 'terminal' | 'ordinary'

export function publishClipboardText(
  text: unknown,
  kind: ClipboardTextWriteKind = 'terminal'
): Promise<void> {
  if (typeof text !== 'string') {
    return Promise.reject(new Error('Clipboard text must be a string'))
  }
  if (text.length > CLIPBOARD_TEXT_WRITE_MAX_BYTES) {
    return Promise.reject(new Error(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR))
  }
  return assertClipboardTextWriteWithinLimitWithYield(text).then((safeText) => {
    if (kind === 'terminal') {
      writeClipboardTextAndVerify(safeText)
    } else {
      clipboard.writeText(safeText)
    }
  })
}
