import { QuirkydBindAddressError } from './quirkyd-bind-address'
import { QuirkydBundledRuntimeError } from './quirkyd-bundled-runtime'
import { QuirkydInstanceLockError } from './quirkyd-data-root-privacy'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import { QUIRKYD_EXIT_CONFIGURATION } from './quirkyd-configuration-exit'

export const QUIRKYD_EXIT_FAILED = 1

/** Configuration faults cannot be repaired by a supervisor restart. */
export function resolveQuirkydExitCode(error: unknown): number {
  return error instanceof QuirkydInstanceLockError ||
    error instanceof QuirkydBindAddressError ||
    error instanceof QuirkydBundledRuntimeError ||
    error instanceof ProfileStateAccessError
    ? QUIRKYD_EXIT_CONFIGURATION
    : QUIRKYD_EXIT_FAILED
}
