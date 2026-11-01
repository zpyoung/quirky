import type { CSSProperties } from 'react'

export const MAX_Z_INDEX = '2147483647'

const panel: CSSProperties = {
  position: 'fixed',
  pointerEvents: 'auto',
  boxSizing: 'border-box',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)',
  background: 'var(--ui-surface)',
  boxShadow: '0 var(--ui-space-8) var(--ui-space-24) var(--ui-shadow)',
  color: 'var(--ui-text)',
  fontSize: 'var(--ui-font-body)',
  lineHeight: 1.4
}

export const banner: CSSProperties = {
  ...panel,
  position: 'relative',
  zIndex: MAX_Z_INDEX,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  justifyContent: 'center',
  gap: 'var(--ui-space-12)',
  maxWidth: 'calc(100vw - var(--ui-space-24))',
  margin: 'var(--ui-space-12) auto 0',
  padding: 'var(--ui-space-6) var(--ui-space-12)',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere'
}

export const tray: CSSProperties = {
  ...panel,
  right: 'var(--ui-space-12)',
  bottom: 'calc(var(--ui-row-single) + var(--ui-space-12))',
  width: 'min(calc(var(--ui-row-double) * 12), calc(100vw - var(--ui-space-24)))',
  maxHeight: '60vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
}
export const trayBar: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--ui-space-8)', padding: 'var(--ui-space-6) var(--ui-space-8)' }
export const trayHead: CSSProperties = { padding: 'var(--ui-space-8)', borderBottom: 'var(--ui-border-width) solid var(--ui-border)' }
export const trayBody: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-6)', padding: 'var(--ui-space-8)', overflow: 'auto' }
export const notice: CSSProperties = { margin: 0, color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere' }

export const row: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'start',
  gap: 'var(--ui-space-4) var(--ui-space-8)',
  padding: 'var(--ui-space-8)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-selected)'
}
export const rowMain: CSSProperties = {
  display: 'grid',
  gap: 'var(--ui-space-2)',
  padding: 0,
  border: 0,
  background: 'var(--ui-transparent)',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer'
}
export const rowComment: CSSProperties = { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }
export const rowMeta: CSSProperties = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' }
export const rowStale: CSSProperties = { color: 'var(--ui-needs-you)' }
export const rowHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-6)' }

export const card: CSSProperties = {
  ...panel,
  left: 'var(--ui-space-12)',
  bottom: 'var(--ui-space-12)',
  width: 'min(calc(var(--ui-row-double) * 11), calc(100vw - var(--ui-space-24)))',
  maxHeight: 'calc(100vh - var(--ui-space-24))',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-12)'
}
export const cardBody: CSSProperties = { display: 'grid', gap: 'var(--ui-space-8)', minHeight: 0, overflow: 'auto' }
export const cardTitle: CSSProperties = { margin: 0, fontSize: 'var(--ui-font-body)', fontWeight: 600, overflowWrap: 'anywhere' }
export const cardActions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 'var(--ui-space-6)' }
export const intentGroup: CSSProperties = { display: 'flex', gap: 'var(--ui-space-6)' }
export const warning: CSSProperties = { margin: 0, color: 'var(--ui-needs-you)', fontSize: 'var(--ui-font-label)' }

/** Centres a dot on a rect's top-left corner, keeping the whole dot inside the window. */
export const dotAt = (rect: { left: number; top: number }): CSSProperties => ({
  left: `calc(clamp(var(--ui-icon-size) / 2, ${rect.left}px, 100vw - var(--ui-icon-size) / 2))`,
  top: `calc(clamp(var(--ui-icon-size) / 2, ${rect.top}px, 100vh - var(--ui-icon-size) / 2))`
})

export const dot: CSSProperties = {
  position: 'fixed',
  display: 'grid',
  placeItems: 'center',
  width: 'var(--ui-icon-size)',
  height: 'var(--ui-icon-size)',
  borderRadius: 'calc(var(--ui-icon-size) / 2)',
  background: 'var(--ui-accent)',
  color: 'var(--ui-rail)',
  fontSize: 'var(--ui-font-label)',
  fontWeight: 600,
  transform: 'translate(-50%, -50%)',
  pointerEvents: 'none'
}

export const chip: CSSProperties = {
  ...panel,
  display: 'flex',
  gap: 'var(--ui-space-6)',
  padding: 'var(--ui-space-6)'
}
