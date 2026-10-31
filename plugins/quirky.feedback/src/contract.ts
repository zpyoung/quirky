export type CaptureKind = 'element' | 'terminal-pane' | 'browser-pane'

/** What was on screen when a comment was added. It is captured once and never re-resolved. */
export type Capture = {
  kind: CaptureKind
  /** The owning plugin's ID, or `quirky` for the host's own UI. */
  owner: string
  elementPath: string
  selector: string
  role: string | null
  accessibleName: string | null
  /** Always null on a terminal or browser pane. */
  visibleText: string | null
  /** Always null on a terminal or browser pane. */
  nearbyText: string[] | null
  /** Always null on a terminal or browser pane. */
  attributes: Record<string, string> | null
  rect: { x: number; y: number; width: number; height: number }
  computedStyles: Record<string, string>
  component: string | null
  source: string | null
  sourceCaller: string | null
  build: { version: string; commit: string; channel: string }
}

export type CommentIntent = 'change' | 'question'

export type Comment = {
  id: string
  createdAt: number
  intent: CommentIntent
  comment: string
  capture: Capture
}

export const MAX_COMMENTS = 50
export const MAX_COMMENT_LENGTH = 2000

/** Starts the message of the `conflict` error `quirky.feedback/add` raises when the tray is full. */
export const FEEDBACK_FULL = 'feedback_full'
