export type CopyFeedback = { session: string; kind: 'id' | 'resume-command' }

type Listener = (feedback: CopyFeedback) => void
const listeners = new Set<Listener>()

export function publishCopyFeedback(feedback: CopyFeedback): void {
  for (const listener of listeners) listener(feedback)
}

export function subscribeCopyFeedback(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
