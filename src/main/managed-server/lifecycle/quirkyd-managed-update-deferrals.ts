/** The last update each managed server deferred in this session, so status can report it. */
import type { QuirkydManagedDeferral } from '../../../shared/quirkyd-managed-runtime'
import { compareAppVersions } from '../../../shared/app-version'

type RecordedDeferral = QuirkydManagedDeferral & { deferredAt: string }

const deferrals = new Map<string, RecordedDeferral>()

export function recordManagedQuirkydUpdateDeferral(
  environmentId: string,
  deferral: QuirkydManagedDeferral,
  now = new Date()
): void {
  deferrals.set(environmentId, { ...deferral, deferredAt: now.toISOString() })
}

export function clearManagedQuirkydUpdateDeferral(environmentId: string): void {
  deferrals.delete(environmentId)
}

export function readManagedQuirkydUpdateDeferral(environmentId: string): RecordedDeferral | null {
  return deferrals.get(environmentId) ?? null
}

/**
 * The deferral, unless the host already runs its candidate or a newer release: another desktop's
 * update can land it after this one deferred, and nothing here would otherwise forget it.
 */
export function currentManagedQuirkydUpdateDeferral(
  environmentId: string,
  activeVersion: string | null
): RecordedDeferral | null {
  const deferral = readManagedQuirkydUpdateDeferral(environmentId)
  if (
    deferral &&
    activeVersion &&
    (activeVersion === deferral.candidateVersion ||
      compareAppVersions(activeVersion, deferral.candidateVersion) > 0)
  ) {
    clearManagedQuirkydUpdateDeferral(environmentId)
    return null
  }
  return deferral
}
