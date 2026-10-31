import type { CSSProperties } from 'react'

/** Layout-only values; shared UI components own control and surface appearance. */
export const s = {
  page: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', color: 'var(--ui-text)' },
  column: { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-16)', padding: 'var(--ui-space-16)', minWidth: 0 },
  intro: { margin: 0, color: 'var(--ui-muted)', fontSize: 'var(--ui-font-body)', overflowWrap: 'anywhere' },
  section: { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)', minWidth: 0 },
  sectionHint: { margin: 0, color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere' },
  headActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-8)' },
  choices: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-6)' },
  list: { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', listStyle: 'none', margin: 0, padding: 0, minWidth: 0 },
  rowTitle: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-8)', minWidth: 0, overflowWrap: 'anywhere' },
  command: { display: 'block', fontFamily: 'var(--ui-font-mono)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
  rowActions: { display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 'var(--ui-space-8)', minWidth: 0, maxWidth: '100%' },
  detail: { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-12)', padding: 'var(--ui-space-8)' },
  inline: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-8)' },
  fieldRow: { display: 'flex', alignItems: 'flex-end', gap: 'var(--ui-space-8)', minWidth: 0 },
  fieldControl: { flex: '1 1 auto', minWidth: 0 },
  mono: { fontFamily: 'var(--ui-font-mono)' },
  link: { color: 'var(--ui-accent)', textDecoration: 'none', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere' },
} satisfies Record<string, CSSProperties>
