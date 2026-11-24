import type { PreflightStatus } from '../../../../preload/api-types'

export type GhStatus = 'checking' | 'connected' | 'not-installed' | 'not-authenticated'
// Why: parallel to GhStatus — GitLab uses glab and the same three failure
// modes (probe in-flight / installed-but-unauth / missing entirely).
export type GlabStatus = GhStatus
export type PreflightRefreshProvider = 'gh' | 'glab'

export type PreflightIntegrationStatuses = {
  ghStatus: GhStatus
  glabStatus: GlabStatus
}

function ghStatusFromPreflight(status: PreflightStatus['gh']): GhStatus {
  if (!status.installed) {
    return 'not-installed'
  }
  return status.authenticated ? 'connected' : 'not-authenticated'
}

function glabStatusFromPreflight(status: PreflightStatus['glab']): GlabStatus {
  if (!status?.installed) {
    return 'not-installed'
  }
  return status.authenticated ? 'connected' : 'not-authenticated'
}

function maybeChecking<T extends string>(
  provider: PreflightRefreshProvider,
  refreshingProviders: ReadonlySet<PreflightRefreshProvider>,
  status: T
): T | 'checking' {
  return refreshingProviders.has(provider) ? 'checking' : status
}

export function getPreflightIntegrationStatuses(
  preflightStatus: PreflightStatus | null,
  refreshingProviders: ReadonlySet<PreflightRefreshProvider>
): PreflightIntegrationStatuses {
  if (!preflightStatus) {
    return { ghStatus: 'checking', glabStatus: 'checking' }
  }

  return {
    ghStatus: maybeChecking('gh', refreshingProviders, ghStatusFromPreflight(preflightStatus.gh)),
    glabStatus: maybeChecking(
      'glab',
      refreshingProviders,
      glabStatusFromPreflight(preflightStatus.glab)
    )
  }
}
