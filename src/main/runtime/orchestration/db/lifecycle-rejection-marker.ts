export function addLifecycleRejectionMarker(
  payload: string | null,
  code: string,
  reason: string,
  details?: { originalReason?: string; originalBody?: string }
): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = payload ? JSON.parse(payload) : {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // Authority reconciliation only reaches this path with object payloads.
  }
  return JSON.stringify({
    ...parsed,
    _quirkyLifecycleRejection: {
      code,
      reason,
      ...(details?.originalReason === undefined ? {} : { originalReason: details.originalReason }),
      ...(details?.originalBody === undefined ? {} : { originalBody: details.originalBody })
    }
  })
}

export function readLifecycleRejectionMarker(
  payload: string | null
): { code: string; reason: string } | null {
  try {
    const value: unknown = JSON.parse(payload ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const marker = '_quirkyLifecycleRejection' in value ? value._quirkyLifecycleRejection : null
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      return null
    }
    const code = 'code' in marker ? marker.code : undefined
    const reason = 'reason' in marker ? marker.reason : undefined
    return typeof code === 'string' && typeof reason === 'string' ? { code, reason } : null
  } catch {
    return null
  }
}

export function hasLifecycleRejectionMarker(payload: string | null): boolean {
  return readLifecycleRejectionMarker(payload) !== null
}
