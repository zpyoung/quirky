// Where a card sits in its queue, for a writer placing cards ahead of the others
// (`journal-unsent-send-hold.ts`). The queue sends in position order.

import type Database from '../../sqlite/sync-database'

/** A card to move, named by its id or, for one handed off, by the submission that consumed it. */
export type QueuedMessagePositionMove =
  | { messageId: string; position: number }
  | { consumedAs: string; position: number }

/** Returns how many rows moved. */
export function moveQueuedMessages(
  db: Database.Database,
  sessionId: string,
  moves: readonly QueuedMessagePositionMove[]
): number {
  let moved = 0
  for (const move of moves) {
    const [column, key] =
      'messageId' in move ? ['message_id', move.messageId] : ['consumed_as', move.consumedAs]
    moved += Number(
      db
        .prepare(
          `UPDATE queued_messages SET position = ?
           WHERE session_id = ? AND ${column} = ? AND position <> ?`
        )
        .run(move.position, sessionId, key, move.position).changes ?? 0
    )
  }
  return moved
}

/** The moves that put `messageId` at `toIndex` among `unsettled` (cards in send order), clamped to
 *  the queue. The cards trade the positions they already hold, so a tombstone's or another
 *  card's position never collides. Empty when the card is already there or is not in the queue. */
export function queuedMessageReorderMoves(
  unsettled: readonly { messageId: string; position: number }[],
  messageId: string,
  toIndex: number
): QueuedMessagePositionMove[] {
  const target = unsettled.find((card) => card.messageId === messageId)
  if (!target) {
    return []
  }
  const order = unsettled.filter((card) => card.messageId !== messageId)
  order.splice(Math.min(Math.max(toIndex, 0), order.length), 0, target)
  const slots = unsettled.map((card) => card.position)
  return order.flatMap((card, index) => {
    const position = slots[index]
    return position === undefined || position === card.position
      ? []
      : [{ messageId: card.messageId, position }]
  })
}
