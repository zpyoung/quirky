import type { SshTarget } from '../../shared/ssh-types'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import type { QuirkydLaunchDetach } from '../managed-server/install/quirkyd-remote-launch'

/** The host an quirkyd transport reaches; only `id` and `label` mean the same for every kind. */
export type QuirkydHostTarget = SshTarget

/** The host connection quirkyd deploy, activation, serving and lifecycle code runs over. */
export type QuirkydHostTransport = RemoteInstallTransport & {
  /** Keys per-host state (remote context, wake dedupe) to the target it reaches. */
  getTarget(): QuirkydHostTarget
  /** How a launch leaves the exec's session; absent (SSH) means `nohup`. */
  readonly quirkydLaunchDetach?: QuirkydLaunchDetach
  /** Host facts only the client can read, passed to quirkyd at launch; absent (SSH) adds none. */
  readonly quirkydLaunchEnv?: () => Promise<readonly QuirkydLaunchEnvEntry[]>
}

export type QuirkydLaunchEnvEntry = readonly [name: string, value: string]
