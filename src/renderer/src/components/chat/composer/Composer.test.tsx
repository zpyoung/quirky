// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { Composer } from './Composer'
import type { ComposerProps, ComposerQueue, ComposerSettings } from './composer-types'
import type { ComposerImage } from './use-composer-attachments'

const mocks = vi.hoisted(() => {
  const images: ComposerImage[] = []
  return {
    attachments: {
      images,
      removeImage: () => {},
      pickAttachments: () => {},
      takePaste: () => false,
      flushPendingAttachments: () => {}
    }
  }
})

vi.mock('./use-composer-attachments', () => ({ useComposerAttachments: () => mocks.attachments }))
vi.mock('./Mentions', () => ({ useFileSearch: () => ({ items: [], unavailable: false }) }))
vi.mock('./QueuedList', () => ({ QueuedList: () => <div data-testid="queue" /> }))
vi.mock('./SettingsChip', () => ({ SettingsChip: () => <div data-testid="settings" /> }))

const SCOPE = 'agent-session:composer-test'

const queue: ComposerQueue = {
  cards: [{ messageId: 'q1', position: 1, text: 'later', state: 'waiting', hold: 'turn' }],
  queueCapable: true,
  clearCapable: true,
  pause: null,
  resume: vi.fn(),
  clear: vi.fn(),
  queuePending: null,
  pending: () => null,
  steer: vi.fn(),
  remove: vi.fn(),
  editCapable: true,
  editor: undefined,
  edit: vi.fn(),
  steerNewest: () => false
}
const settings: ComposerSettings = {
  surface: {
    getSnapshot: () => [],
    setOption: vi.fn(),
    invokeAction: vi.fn(),
    subscribe: () => () => {}
  },
  setOption: vi.fn()
}

function setup(overrides: Partial<ComposerProps> = {}, draft = 'hello') {
  if (draft !== '') {
    updateNativeChatComposerDraft(SCOPE, { text: draft }, 'immediate')
  }
  const onSubmit = vi.fn()
  const view = render(
    <Composer mode="chat" draftScopeKey={SCOPE} onSubmit={onSubmit} {...overrides} />
  )
  const content = view.container.querySelector('.cm-content')
  if (!(content instanceof HTMLElement)) {
    throw new Error('the editor did not mount')
  }
  return { onSubmit, content, ...view }
}

function press(target: HTMLElement, init: KeyboardEventInit & { keyCode?: number }) {
  const { keyCode, ...rest } = init
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...rest })
  if (keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: keyCode })
  }
  act(() => {
    target.dispatchEvent(event)
  })
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 80)))

beforeEach(() => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
})

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

describe('Composer modes', () => {
  it('shows the queue and settings chip in chat mode', () => {
    setup({ queue, settings })
    expect(screen.getByTestId('queue')).toBeTruthy()
    expect(screen.getByTestId('settings')).toBeTruthy()
  })

  it('hides the queue, settings and plan controls in terminal mode', () => {
    setup({ mode: 'terminal', queue, settings, planModeAvailable: true })
    expect(screen.queryByTestId('queue')).toBeNull()
    expect(screen.queryByTestId('settings')).toBeNull()
  })
})

describe('Composer sending', () => {
  it('sends the draft on Enter and clears it once the caller takes it', async () => {
    const { onSubmit, content } = setup()
    press(content, { key: 'Enter', keyCode: 13 })
    await settle()
    expect(onSubmit).toHaveBeenCalledWith('hello', [])
    expect(readNativeChatComposerDraft(SCOPE).text).toBe('')
  })

  it('keeps the draft when the caller refuses the message', async () => {
    const { onSubmit, content } = setup()
    onSubmit.mockReturnValue(false)
    press(content, { key: 'Enter', keyCode: 13 })
    await settle()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(readNativeChatComposerDraft(SCOPE).text).toBe('hello')
  })

  it('passes a steer intent when the steer chord sends a draft in chat', async () => {
    const { onSubmit, content } = setup({ queue, working: true })
    press(content, { key: 'Enter', keyCode: 13, metaKey: true })
    await settle()
    expect(onSubmit).toHaveBeenCalledWith('hello', [], { intent: 'steer' })
  })

  it('treats the steer chord as a plain send in terminal mode', async () => {
    const { onSubmit, content } = setup({ mode: 'terminal' })
    press(content, { key: 'Enter', keyCode: 13, metaKey: true })
    await settle()
    expect(onSubmit).toHaveBeenCalledWith('hello', [])
  })

  it('does not send on Shift+Enter', async () => {
    const { onSubmit, content } = setup()
    press(content, { key: 'Enter', keyCode: 13, shiftKey: true })
    await settle()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not send while an IME composition is live, and sends once it has ended', async () => {
    const { onSubmit, content } = setup()
    act(() => {
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    press(content, { key: 'Enter', keyCode: 229, isComposing: true })
    await settle()
    expect(onSubmit).not.toHaveBeenCalled()

    act(() => {
      content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      content.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    })
    await settle()
    press(content, { key: 'Enter', keyCode: 13 })
    await settle()
    expect(onSubmit).toHaveBeenCalledWith('hello', [])
  })
})

describe('Composer in a quarantined terminal dock', () => {
  it('holds sends and says why', async () => {
    const { onSubmit, content } = setup({
      mode: 'terminal',
      quarantined: true,
      quarantineReason: 'Paused while the terminal reattaches.'
    })
    expect(screen.getByRole('status').textContent).toBe('Paused while the terminal reattaches.')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    press(content, { key: 'Enter', keyCode: 13 })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settle()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft(SCOPE).text).toBe('hello')
  })
})

describe('Composer focus', () => {
  it('takes focus back when the window regains it with nothing focused', () => {
    const { content } = setup({ mode: 'terminal', autoFocus: true })
    expect(content.contains(document.activeElement)).toBe(true)
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    expect(content.contains(document.activeElement)).toBe(false)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(content.contains(document.activeElement)).toBe(true)
  })
})
