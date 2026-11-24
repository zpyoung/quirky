import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { resolveQuirkydDeploymentTargetFacts } from '../../ssh/quirkyd-deployment-target'
import { QuirkydHostUnsupportedError } from '../../quirkyd/quirkyd-host-unavailable'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { pinnedRuntimeTargetForHost } from '../../ssh/pinned-runtime-host-target'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/**
 * The runtime target managed quirkyd deploys on a host, picked by glibc: the host's own target, or
 * its compat runtime below the default's glibc floor.
 */
export async function resolveQuirkydRuntimeTarget(options: {
  conn: QuirkydHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<NodeRuntimeTarget> {
  const facts = await resolveQuirkydDeploymentTargetFacts(options)
  const target = pinnedRuntimeTargetForHost(facts)
  if (!target) {
    const glibc = facts.glibc ? `${facts.glibc.major}.${facts.glibc.minor}` : 'unknown'
    throw new QuirkydHostUnsupportedError(
      `No Quirky runtime supports ${facts.target} with glibc ${glibc}.`
    )
  }
  return target
}
