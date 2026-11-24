/**
 * The downgrade rule every quirkyd activation on a shared host applies: a build may not start over
 * state a newer Quirky's quirkyd may already have migrated.
 */
import { compareAppVersions } from '../../shared/app-version'
import type { QuirkydActivationRecord } from '../managed-server/activation/quirkyd-activation-record'

export type QuirkydHostVersionRefusal = 'host-newer'

export function refuseQuirkydHostDowngrade(
  record: QuirkydActivationRecord,
  candidateVersion: string,
  appVersion: string
): QuirkydHostVersionRefusal | null {
  // Restarting the very build that was stopped cannot downgrade anything.
  if (record.active === null && record.previous === candidateVersion) {
    return null
  }
  // Why an unnamed version is admitted: every Stop before the field existed omits it, so refusing
  // would strand those hosts for good; only a provably newer host is refused.
  if (!record.activeAppVersion) {
    return null
  }
  return compareAppVersions(record.activeAppVersion, appVersion) > 0 ? 'host-newer' : null
}
