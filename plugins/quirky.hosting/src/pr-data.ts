export type IdentityValue = { host: string; owner: string; repo: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function providerReason(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.data)) return undefined
  return typeof error.data.reason === 'string' ? error.data.reason : undefined
}


export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function parseBranch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const branch = value.replace(/^refs\/heads\//, '').trim()
  if (branch.length === 0 || branch.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(branch)) return undefined
  return branch
}

export function parseOid(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value) ? value.toLowerCase() : undefined
}

export function parseIdentity(value: unknown): IdentityValue | undefined {
  if (!isRecord(value)) return undefined
  const host = nonEmptyString(value.host)?.toLowerCase()
  const owner = nonEmptyString(value.owner)
  const repo = nonEmptyString(value.repo)
  if (!host || !owner || !repo || /[\u0000-\u001f\u007f/]/u.test(owner) || /[\u0000-\u001f\u007f/]/u.test(repo)) return undefined
  return { host, owner, repo }
}

export function sameIdentity(left: IdentityValue, right: IdentityValue): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase() &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
}


