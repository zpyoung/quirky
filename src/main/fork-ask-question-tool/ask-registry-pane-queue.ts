/**
 * Per-pane FIFO of pending ask ids (tech.md C2): only the head is surfaced to a card; a second
 * ask registered on the same pane queues until the head resolves.
 */
export class AskPaneQueue {
  private readonly queues = new Map<string, string[]>()

  /** Enqueues `askId` behind any pending asks already on `paneKey`; true means it is (or becomes) the head. */
  enqueue(paneKey: string, askId: string): boolean {
    const queue = this.queues.get(paneKey) ?? []
    queue.push(askId)
    this.queues.set(paneKey, queue)
    return queue[0] === askId
  }

  /** Every pending ask id on the pane, head first. */
  all(paneKey: string): string[] {
    return [...(this.queues.get(paneKey) ?? [])]
  }

  head(paneKey: string): string | undefined {
    return this.queues.get(paneKey)?.[0]
  }

  /** Removes a resolved ask from its pane's queue; returns the id promoted to head, or null when no promotion happened. */
  remove(paneKey: string, askId: string): string | null {
    const queue = this.queues.get(paneKey)
    if (!queue) {
      return null
    }
    const index = queue.indexOf(askId)
    if (index === -1) {
      return null
    }
    queue.splice(index, 1)
    if (queue.length === 0) {
      this.queues.delete(paneKey)
      return null
    }
    return index === 0 ? queue[0] : null
  }
}
