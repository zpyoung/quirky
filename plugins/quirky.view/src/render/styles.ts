import type { CSSProperties } from 'react'

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad'

export const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--ui-text)',
  info: 'var(--ui-accent)',
  good: 'var(--ui-working)',
  warn: 'var(--ui-needs-you)',
  bad: 'var(--ui-failing)'
}

export const COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-12)', minWidth: 0 }

export const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--ui-space-8)', minWidth: 0 }

export const MUTED: CSSProperties = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' }

export const MONO: CSSProperties = { fontFamily: 'var(--ui-font-mono)', fontSize: 'var(--ui-font-mono)' }

export const LIST: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-6)'
}

export const PANEL: CSSProperties = {
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-surface)',
  padding: 'var(--ui-space-8) var(--ui-space-12)',
  minWidth: 0
}
