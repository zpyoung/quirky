import { NODE_RUNTIME_PIN } from './node-runtime-pin'
import type { QuirkydPreflightRuntimeIdentity } from './quirkyd-profile-preflight'

/** What a Node slot's candidate must report: the pinned runtime, never a host Node. */
export const QUIRKYD_NODE_RUNTIME_IDENTITY: QuirkydPreflightRuntimeIdentity = {
  runtime: 'node',
  runtimeVersion: NODE_RUNTIME_PIN.version
}
