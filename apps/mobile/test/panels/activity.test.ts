import { describe, expect, test } from 'bun:test'
import {
  applyNotificationBatch,
  createNotificationFeedState,
  notificationCheckpoint,
  parseNotificationCheckpoint,
  projectAccountState,
  selectProviderAccount
} from '../../src/panels/activity/model'

describe('mobile activity panel projections', () => {
  test('account projection contains only public metadata and usage for the selected account', () => {
    const snapshot = projectAccountState({
      accounts: [{
        id: 'claude-work', provider: 'claude', label: 'Work', email: 'dev@example.test', organization: 'Studio',
        createdAt: 1, updatedAt: 2, lastAuthenticatedAt: 3, needsSignIn: false, active: true,
        credential: 'never-render-this'
      }],
      active: { claude: 'claude-work', codex: null },
      systemDefault: {
        claude: { label: 'Default Claude', email: null, hasAuth: true, authKind: 'oauth' },
        codex: { label: 'Default Codex', email: null, hasAuth: false, authKind: 'none' }
      }
    }, {
      providers: [{
        provider: 'claude', accountId: 'claude-work', status: 'ok', error: null, updatedAt: 3,
        session: { usedPercent: 41, windowMinutes: 300, resetsAt: 1000, resetDescription: null },
        weekly: { usedPercent: 65, windowMinutes: 10080, resetsAt: 2000, resetDescription: null },
        usageMetadata: { credentialSource: 'never-render-this-too' }
      }],
      inactive: {}, updatedAt: 3
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.rows.find((row) => row.provider === 'claude' && row.id === 'claude-work')).toMatchObject({
      label: 'Work', active: true, fiveHour: { usedPercent: 41 }, sevenDay: { usedPercent: 65 }
    })
    expect(snapshot?.rows.find((row) => row.provider === 'codex' && row.isSystemDefault)).toMatchObject({ active: true })
    expect(JSON.stringify(snapshot)).not.toContain('never-render-this')
  })

  test('failed account selection retains the last authoritative active selection', async () => {
    const current = projectAccountState({
      accounts: [], active: { claude: null, codex: null },
      systemDefault: {
        claude: { label: 'Claude', email: null, hasAuth: true, authKind: 'oauth' },
        codex: { label: 'Codex', email: null, hasAuth: true, authKind: 'oauth' }
      }
    }, null)
    if (!current) throw new Error('test account fixture did not project')

    const result = await selectProviderAccount(
      async () => { throw new Error('host unavailable') }, current, 'claude', 'managed-id'
    )

    expect(result.snapshot).toBe(current)
    expect(result.error).toBe('host unavailable')
    expect(result.snapshot.rows.find((row) => row.provider === 'claude' && row.isSystemDefault)?.active).toBe(true)
  })

  test('notification replay trusts server filtering and de-duplicates after persisted reconnect', () => {
    const first = applyNotificationBatch(createNotificationFeedState(), {
      epoch: 'host-epoch', cursor: 2, reset: false, truncated: false, presenceAvailable: true,
      notifications: [
        { id: 'test-event', seq: 1, at: 10, title: 'Test', body: 'Test bypasses away filtering', desktopAway: false },
        { id: 'unknown-event', seq: 2, at: 11, title: 'Unknown', body: 'Keep while presence is unknown', desktopAway: null }
      ]
    })
    const reconnected = parseNotificationCheckpoint(notificationCheckpoint(first))
    if (!reconnected) throw new Error('notification checkpoint did not restore')
    const replay = applyNotificationBatch(reconnected, {
      epoch: 'host-epoch', cursor: 4, reset: false, truncated: false, presenceAvailable: true,
      notifications: [
        { id: 'unknown-event', seq: 2, at: 11, title: 'Unknown', body: 'Replay duplicate', desktopAway: null },
        { id: 'new-event', seq: 4, at: 12, title: 'New', body: 'New notification', desktopAway: true }
      ]
    })

    expect(first.cursor).toBe(2)
    expect(first.notifications.map((item) => item.id)).toEqual(['test-event', 'unknown-event'])
    expect(replay.cursor).toBe(4)
    expect(replay.notifications.map((item) => item.id)).toEqual(['new-event', 'test-event', 'unknown-event'])
  })

})
