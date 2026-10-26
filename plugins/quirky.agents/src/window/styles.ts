import type { CSSProperties } from 'react'

/** Inline styles over the window's theme variables, because plugins do not ship stylesheets. */
export const s = {
  page: { flex: 1, minHeight: 0, overflowY: 'auto', color: 'var(--text)' },
  column: { maxWidth: 860, margin: '0 auto', padding: '24px 20px 48px', display: 'flex', flexDirection: 'column', gap: 24 },
  title: { margin: 0, fontSize: 20 },
  sectionTitle: { margin: 0, fontSize: 14 },
  hint: { margin: '2px 0 0', color: 'var(--muted)', fontSize: 12 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  headRow: { display: 'flex', alignItems: 'center', gap: 8 },
  spacer: { marginLeft: 'auto' },
  choices: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  segments: { display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  segment: { border: 'none', borderRadius: 0, background: 'transparent' },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  row: { padding: '10px 0', borderTop: '1px solid var(--border)' },
  rowMain: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  rowText: { flex: 1, minWidth: 180 },
  rowTitle: { display: 'flex', alignItems: 'center', gap: 8 },
  command: { display: 'block', marginTop: 2, color: 'var(--muted)', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', overflowWrap: 'anywhere' },
  tag: { padding: '0 6px', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--muted)', fontSize: 11, lineHeight: '16px' },
  detail: { display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0 2px 0' },
  inline: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { color: 'var(--muted)', fontSize: 12 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 8 },
  mono: { fontFamily: 'ui-monospace, Menlo, monospace' },
  link: { color: 'var(--accent)', textDecoration: 'none', fontSize: 12 },
  switchTrack: { position: 'relative', width: 30, height: 16, padding: 0, borderRadius: 8, flex: 'none' },
  switchThumb: { position: 'absolute', top: 1, width: 12, height: 12, borderRadius: 6, background: '#fff' }
} satisfies Record<string, CSSProperties>
