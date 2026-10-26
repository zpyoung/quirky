import type { DisplayStatus } from './status'

export function StatusDot({ status }: { status: DisplayStatus | null }) {
  if (!status) return <span className="dot dot-none" aria-hidden />
  return <span className={`dot dot-${status}`} title={status} role="img" aria-label={status} />
}
