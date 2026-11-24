import {
  beginWorktreeCreate,
  type WorktreeCreateInFlightHandle
} from './worktree-create-concurrency'
import {
  createWorktreeCreateTimingRecorder,
  type WorktreeCreateTimingRecorder
} from './worktree-create-timing'

/** Lets a runtime create start its timing once it is known to be a Git create. */
export type RuntimeWorkspaceCreateEvents = {
  begin(): WorktreeCreateTimingRecorder
}

/** The timing recorder for one create plus the in-flight slot it holds until `end`. */
export type WorkspaceCreateSession = {
  readonly timing: WorktreeCreateTimingRecorder
  end(): void
}

export function beginWorkspaceCreateSession(): WorkspaceCreateSession {
  const inFlight: WorktreeCreateInFlightHandle = beginWorktreeCreate()
  return {
    timing: createWorktreeCreateTimingRecorder(undefined, inFlight),
    end: () => {
      inFlight.end()
    }
  }
}

/** Runs a runtime create and releases its in-flight slot before returning. */
export async function withRuntimeWorkspaceCreate<T>(
  perform: (events: RuntimeWorkspaceCreateEvents) => Promise<T>
): Promise<T> {
  const held: { session: WorkspaceCreateSession | null } = { session: null }
  try {
    return await perform({
      begin() {
        held.session = beginWorkspaceCreateSession()
        return held.session.timing
      }
    })
  } finally {
    held.session?.end()
  }
}
