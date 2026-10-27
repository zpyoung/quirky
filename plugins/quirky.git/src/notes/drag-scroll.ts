const EDGE_PX = 24
const MIN_STEP_PX = 4
const MAX_STEP_PX = 32
const ACCELERATION = 0.6
/** The frame length the step sizes are quoted for. */
export const REFERENCE_FRAME_MS = 1000 / 60
/** A window that was in the background resumes with a huge frame delta; capping it keeps the view from jumping. */
const MAX_FRAME_DELTA_MS = 50

/**
 * How far to scroll this frame while a drag is held near the top or bottom edge of the scroller:
 * negative scrolls up, positive down, 0 when the pointer is clear of both 24 px edge zones. The
 * pull grows with the overshoot from 4 to 32 px per 60 Hz frame and scales with the real frame
 * time, so displays of any refresh rate scroll at the same speed.
 */
export function dragScrollStep(args: { top: number; bottom: number; clientY: number; frameDeltaMs: number }): number {
  const topEdge = args.top + EDGE_PX
  const bottomEdge = args.bottom - EDGE_PX
  const overshoot = args.clientY < topEdge ? args.clientY - topEdge : args.clientY > bottomEdge ? args.clientY - bottomEdge : 0
  if (overshoot === 0) return 0
  const speed = Math.min(MAX_STEP_PX, MIN_STEP_PX + Math.abs(overshoot) * ACCELERATION)
  return Math.sign(overshoot) * speed * (Math.min(MAX_FRAME_DELTA_MS, args.frameDeltaMs) / REFERENCE_FRAME_MS)
}
