export type ParsedLifecycleRejection = {
  code: string
  reason: string
  originalBody?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function parseLifecycleRejectionPayload(
  payload: Record<string, unknown>
): ParsedLifecycleRejection | null {
  const marker = payload._quirkyLifecycleRejection
  if (!isRecord(marker)) {
    return null
  }
  const rejection = marker
  const reason =
    typeof rejection.originalReason === 'string'
      ? rejection.originalReason
      : typeof rejection.reason === 'string'
        ? rejection.reason
        : null
  if (typeof rejection.code !== 'string' || !rejection.code.trim() || reason === null) {
    return null
  }
  return {
    code: rejection.code,
    reason,
    ...(typeof rejection.originalBody === 'string' ? { originalBody: rejection.originalBody } : {})
  }
}
