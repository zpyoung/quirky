import { useEffect, useState, type CSSProperties } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { MenuEntry } from '@quirky/ui'

export const CHAT_WIDTHS = ['narrow', 'comfortable', 'wide', 'full'] as const
export const CHAT_ALIGNMENTS = ['left', 'center', 'right'] as const
export type ChatWidth = (typeof CHAT_WIDTHS)[number]
export type ChatAlignment = (typeof CHAT_ALIGNMENTS)[number]

/** How wide the chat's transcript and composer run and which side of the view they hug. */
export type ChatLayout = { width: ChatWidth; align: ChatAlignment }

export const WIDTH_SETTING = 'chat-width'
export const ALIGN_SETTING = 'chat-align'
export const DEFAULT_CHAT_LAYOUT: ChatLayout = { width: 'comfortable', align: 'center' }

/** The cap of each bounded width, in length units, padding included. */
export const CHAT_WIDTH_UNITS: Record<Exclude<ChatWidth, 'full'>, number> = { narrow: 560, comfortable: 720, wide: 960 }

const PLUGIN_ID = 'quirky.session'
const WIDTH_LABELS: Record<ChatWidth, string> = { narrow: 'Narrow', comfortable: 'Comfortable', wide: 'Wide', full: 'Full width' }
const ALIGN_LABELS: Record<ChatAlignment, string> = { left: 'Left', center: 'Center', right: 'Right' }

const asWidth = (value: unknown): ChatWidth => (CHAT_WIDTHS.includes(value as ChatWidth) ? (value as ChatWidth) : DEFAULT_CHAT_LAYOUT.width)
const asAlignment = (value: unknown): ChatAlignment =>
  CHAT_ALIGNMENTS.includes(value as ChatAlignment) ? (value as ChatAlignment) : DEFAULT_CHAT_LAYOUT.align

function readSetting(context: UiPluginContext, name: string): unknown {
  try {
    return context.getSetting(name)
  } catch {
    return undefined
  }
}

/** The stored layout, with defaults for anything missing or unknown. */
export function readChatLayout(context: UiPluginContext): ChatLayout {
  return { width: asWidth(readSetting(context, WIDTH_SETTING)), align: asAlignment(readSetting(context, ALIGN_SETTING)) }
}

/** The chat layout, following `setting.changed` so a change from Settings or the CLI applies without a reload. */
export function useChatLayout(context: UiPluginContext): ChatLayout {
  const [layout, setLayout] = useState(() => readChatLayout(context))
  useEffect(() => {
    setLayout(readChatLayout(context))
    return context.subscribe((event) => {
      if (event.type !== 'setting.changed') return
      if (event.id === `setting:${PLUGIN_ID}/${WIDTH_SETTING}`) setLayout((current) => ({ ...current, width: asWidth(event.value) }))
      else if (event.id === `setting:${PLUGIN_ID}/${ALIGN_SETTING}`) setLayout((current) => ({ ...current, align: asAlignment(event.value) }))
    })
  }, [context])
  return layout
}

/** Stores one layout setting; the view follows through the `setting.changed` broadcast. */
export function setChatLayoutSetting(context: UiPluginContext, name: typeof WIDTH_SETTING | typeof ALIGN_SETTING, value: string): void {
  void context.call('setting.set', { id: `setting:${PLUGIN_ID}/${name}`, value }).catch((error: unknown) => {
    context.toast('Setting failed', error instanceof Error ? error.message : String(error), { kind: 'error' })
  })
}

/**
 * Inline margins and padding that place a block inside its container per `layout`. The transcript
 * column and the composer both use it, so their content edges line up. Margins come from the
 * container's width rather than `auto` so `endClearance` can keep the end edge clear of an overlay
 * without shifting a centered block off the transcript's axis; a container narrower than the cap
 * collapses both margins, so nothing scrolls sideways.
 */
export function chatFrame(layout: ChatLayout, endClearance = '0px'): CSSProperties {
  const padding = { paddingInline: 'var(--ui-space-16)' }
  if (layout.width === 'full') return { marginInlineStart: '0px', marginInlineEnd: endClearance, ...padding }
  const free = `(100% - ${CHAT_WIDTH_UNITS[layout.width]} * var(--ui-length-unit))`
  const start = layout.align === 'left' ? '0px' : layout.align === 'center' ? `max(0px, ${free} / 2)` : `max(0px, ${free})`
  const end = layout.align === 'right' ? endClearance : layout.align === 'center' ? `max(${endClearance}, ${free} / 2)` : `max(${endClearance}, ${free})`
  return { marginInlineStart: start, marginInlineEnd: end, ...padding }
}

/** Menu rows that show the current width and alignment and store a pick, the same settings Settings shows. */
export function chatLayoutEntries(context: UiPluginContext, layout: ChatLayout): MenuEntry[] {
  return [
    { kind: 'note', id: 'width-note', label: 'Width' },
    ...CHAT_WIDTHS.map((width) => ({
      id: `width-${width}`,
      label: WIDTH_LABELS[width],
      checked: layout.width === width,
      onAction: () => setChatLayoutSetting(context, WIDTH_SETTING, width)
    })),
    { kind: 'note', id: 'align-note', label: 'Alignment' },
    ...CHAT_ALIGNMENTS.map((align) => ({
      id: `align-${align}`,
      label: ALIGN_LABELS[align],
      checked: layout.align === align,
      onAction: () => setChatLayoutSetting(context, ALIGN_SETTING, align)
    }))
  ]
}
