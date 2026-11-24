import type { SshTarget } from '../../shared/ssh-types'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import type { OrcadLaunchDetach } from '../managed-server/install/orcad-remote-launch'

/** The host an orcad transport reaches; only `id` and `label` mean the same for every kind. */
export type OrcadHostTarget = SshTarget

/** The host connection orcad deploy, activation, serving and lifecycle code runs over. */
export type OrcadHostTransport = RemoteInstallTransport & {
  /** Keys per-host state (remote context, wake dedupe) to the target it reaches. */
  getTarget(): OrcadHostTarget
  /** How a launch leaves the exec's session; absent (SSH) means `nohup`. */
  readonly orcadLaunchDetach?: OrcadLaunchDetach
  /** Host facts only the client can read, passed to orcad at launch; absent (SSH) adds none. */
  readonly orcadLaunchEnv?: () => Promise<readonly OrcadLaunchEnvEntry[]>
}

export type OrcadLaunchEnvEntry = readonly [name: string, value: string]
