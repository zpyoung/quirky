import { describe, expect, it } from 'vitest'
import type { PreflightStatus } from '../../../../preload/api-types'
import { getPreflightIntegrationStatuses } from './integrations-pane-status'

const connectedPreflight: PreflightStatus = {
  git: { installed: true },
  gh: { installed: true, authenticated: true },
  glab: { installed: true, authenticated: true }
}

describe('getPreflightIntegrationStatuses', () => {
  it('shows checking before preflight status arrives', () => {
    expect(getPreflightIntegrationStatuses(null, new Set()).ghStatus).toBe('checking')
  })

  it('derives connected status labels and account details from preflight state', () => {
    expect(getPreflightIntegrationStatuses(connectedPreflight, new Set())).toMatchObject({
      ghStatus: 'connected',
      glabStatus: 'connected'
    })
  })

  it('keeps a manually refreshed provider in checking state until its request settles', () => {
    expect(getPreflightIntegrationStatuses(connectedPreflight, new Set(['glab']))).toMatchObject({
      ghStatus: 'connected',
      glabStatus: 'checking'
    })
  })
})
