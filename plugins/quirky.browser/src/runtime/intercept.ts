export const MAX_HELD_REQUESTS = 1_000

export type HeldRequest = {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  resourceType: string
  pending: true
}

/** Tracks only requests still held by Chrome on one page binding. */
export class InterceptLedger {
  suspended = false
  private readonly requests = new Map<string, HeldRequest>()
  private readonly networkRequests = new Map<string, string>()

  hold(request: Omit<HeldRequest, 'pending'> & { networkId?: string }): boolean {
    if (this.suspended || this.requests.size >= MAX_HELD_REQUESTS || this.requests.has(request.id)) return false
    const { networkId, ...record } = request
    this.requests.set(record.id, { ...record, pending: true })
    if (networkId) this.networkRequests.set(networkId, record.id)
    return true
  }

  forget(networkId: string): void {
    const id = this.networkRequests.get(networkId)
    if (id === undefined) return
    this.networkRequests.delete(networkId)
    this.requests.delete(id)
  }

  list(): HeldRequest[] {
    return [...this.requests.values()]
  }

  take(): string[] {
    const ids = [...this.requests.keys()]
    this.requests.clear()
    this.networkRequests.clear()
    return ids
  }
}

export type FetchDomainCommand =
  | { method: 'Fetch.enable'; params: { patterns?: Array<{ urlPattern: string; requestStage: 'Request' }>; handleAuthRequests?: true } }
  | { method: 'Fetch.disable'; params: Record<string, never> }

/** Preserves authentication interception whenever Watch or stored credentials need it. */
export function fetchDomainCommand(settings: { routes: string[]; credentials?: unknown }, watched: boolean): FetchDomainCommand {
  if (settings.routes.length === 0 && !settings.credentials && !watched) return { method: 'Fetch.disable', params: {} }
  return {
    method: 'Fetch.enable',
    params: {
      ...(settings.routes.length > 0 ? { patterns: settings.routes.map((urlPattern) => ({ urlPattern: urlPattern.replaceAll('**', '*'), requestStage: 'Request' as const })) } : {}),
      ...(settings.credentials || watched ? { handleAuthRequests: true as const } : {})
    }
  }
}
