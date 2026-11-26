import type { Locator, Page } from '@stablyai/playwright-test'

/** The structured chat view of the active chat tab. */
export function chatView(page: Page): Locator {
  return page.locator('[data-native-chat-root="true"]')
}

/** The chat's CodeMirror composer, which exposes its content element as a textbox. */
export function chatComposer(chat: Locator): Locator {
  return chat.getByRole('textbox')
}

export function chatSendButton(chat: Locator): Locator {
  return chat.getByRole('button', { name: 'Send', exact: true })
}

export function chatStopButton(chat: Locator): Locator {
  return chat.getByRole('button', { name: 'Stop', exact: true })
}
