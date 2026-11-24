/**
 * Whether a managed Claude launch gets Quirky's AskUserQuestion suppression flags.
 *
 * Three states, not two: `'pending'` (no version read yet) must not be collapsed into `null`
 * (a version was read and it did not clear the floor). They agree on a fresh launch — neither
 * injects — but diverge on resume, where `null` strips flags a previous launch baked in and
 * `'pending'` must leave the captured command exactly as it is.
 */
export type ClaudeSuppressionVerdict = readonly string[] | null | 'pending'

type LocalVerdictReader = () => ClaudeSuppressionVerdict

let readLocalVerdict: LocalVerdictReader | null = null

/**
 * Registers the process-local source of the suppression verdict, so launch composition can stay
 * synchronous while the version probe that decides it is asynchronous.
 *
 * Each process registers once at startup — main from its own gate cache, the renderer from the
 * verdict main pushes to it. A process that registers nothing (the CLI, a unit test) resolves
 * every launch as `'pending'`, which is byte-for-byte today's unsuppressed behavior.
 */
export function setLocalClaudeSuppressionVerdictReader(reader: LocalVerdictReader | null): void {
  readLocalVerdict = reader
}

/**
 * Resolves the verdict that applies to one launch. An explicitly supplied value always wins, so a
 * caller that knows its own host is never overridden by the ambient local reader.
 *
 * A remote launch resolves to `'pending'` rather than to the local verdict: the local binary's
 * version says nothing about the one that will run on the far host.
 */
export function resolveClaudeSuppressionVerdict(args: {
  explicit?: readonly string[] | null
  isRemote?: boolean
}): ClaudeSuppressionVerdict {
  if (args.explicit !== undefined) {
    return args.explicit
  }
  if (args.isRemote) {
    return 'pending'
  }
  // not `?? 'pending'`: a reader that answers null has decided, and that must still strip
  return readLocalVerdict ? readLocalVerdict() : 'pending'
}
