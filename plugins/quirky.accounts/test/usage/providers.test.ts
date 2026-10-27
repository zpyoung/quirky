import { describe, expect, test } from 'bun:test'
import {
  mapAntigravityUsage,
  mapClaudeUsage,
  mapCodexUsage,
  mapCursorUsage,
  mapGeminiUsage,
  mapGrokUsage,
  mapKimiUsage,
  mapMiniMaxUsage,
  mapOpenCodeGoUsage,
  mapZcodeUsage
} from '../../src/usage/mappers'

const now = Date.parse('2026-10-27T12:00:00.000Z')
const resetSeconds = Math.floor((now + 3_600_000) / 1000)
const resetIso = new Date(now + 3_600_000).toISOString()

function percent(window: { usedPercent: number } | null | undefined): number | null {
  return window?.usedPercent ?? null
}

describe('provider usage mapping', () => {
  test('maps all ten providers to bounded windows and provider-specific metadata', () => {
    const claude = mapClaudeUsage({
      five_hour: { utilization: 104, resets_at: resetIso },
      seven_day: { used_percentage: 25, resets_at: resetSeconds },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 17,
          resets_at: resetIso,
          scope: { model: { display_name: 'Fable' } }
        }
      ]
    }, now)
    expect(percent(claude.session)).toBe(100)
    expect(claude.session?.windowMinutes).toBe(300)
    expect(claude.weekly?.resetsAt).toBe(now + 3_600_000)
    expect(percent(claude.fableWeekly)).toBe(17)

    const codex = mapCodexUsage({
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: resetSeconds },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: resetSeconds },
      planType: 'plus',
      rateLimitResetCredits: {
        availableCount: 1,
        totalEarnedCount: 3,
        credits: [{ status: 'available', expiresAt: resetSeconds, grantedAt: resetSeconds - 100 }]
      }
    }, now)
    expect(percent(codex.session)).toBe(31)
    expect(percent(codex.weekly)).toBe(12)
    expect(codex.planType).toBe('plus')
    expect(codex.rateLimitResetCredits?.availableCount).toBe(1)
    expect(codex.rateLimitResetCredits?.credits?.[0]?.expiresAt).toBe(now + 3_600_000)

    const gemini = mapGeminiUsage(
      [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.35, resetTime: resetIso }],
      now
    )
    expect(percent(gemini.session)).toBe(65)
    expect(gemini.buckets?.[0]).toMatchObject({ name: 'Pro', windowMinutes: 60 })
    expect(gemini.buckets?.[0]?.resetsAt).toBe(now + 3_600_000)

    const antigravity = mapAntigravityUsage(
      {
        status: 'SUCCESS',
        command: {
          name: 'usage',
          data: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [
                  { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.4, reset_time: resetIso },
                  { id: 'gemini-5h', name: '5 Hour Limit', window: '5h', remaining_fraction: 0.75, reset_time: resetIso }
                ]
              }
            ]
          }
        }
      },
      now
    )
    expect(percent(antigravity.weekly)).toBe(60)
    expect(percent(antigravity.session)).toBe(25)
    expect(antigravity.buckets?.[0]?.group).toBe('Gemini Models')

    const opencode = mapOpenCodeGoUsage({
      usage: {
        rolling: { percent: 24, resetsAt: resetIso },
        weekly: { percent: 45, resetsAt: resetIso },
        monthly: { percent: 11, resetsAt: resetIso }
      }
    }, now)
    expect(percent(opencode.session)).toBe(24)
    expect(percent(opencode.weekly)).toBe(45)
    expect(percent(opencode.monthly)).toBe(11)

    const kimi = mapKimiUsage({
      usage: { limit: '100', used: '35', resetTime: resetIso },
      limits: [{ window: { duration: 5, timeUnit: 'HOUR' }, detail: { limit: 20, used: 5, resetAt: resetIso } }]
    }, now)
    expect(percent(kimi.weekly)).toBe(35)
    expect(percent(kimi.session)).toBe(25)
    expect(kimi.session?.windowMinutes).toBe(300)

    const minimax = mapMiniMaxUsage({
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 72,
          start_time: now,
          end_time: now + 3_600_000,
          current_weekly_remaining_percent: 80,
          weekly_remains_time: 604_800_000
        }
      ]
    }, ['general'], now)
    expect(percent(minimax.session)).toBe(28)
    expect(percent(minimax.weekly)).toBe(20)

    const grok = mapGrokUsage({
      creditUsagePercent: 34,
      currentPeriod: { end: resetIso },
      monthlyLimit: { val: 100 },
      used: { val: 40 },
      subscriptionTier: 'super'
    }, now)
    expect(percent(grok.weekly)).toBe(34)
    expect(percent(grok.monthly)).toBe(40)
    expect(grok.planType).toBe('super')

    const cursor = mapCursorUsage({
      billingCycleStart: new Date(now).toISOString(),
      billingCycleEnd: resetIso,
      membershipType: 'pro',
      individualUsage: {
        plan: { enabled: true, autoPercentUsed: 42, apiPercentUsed: 18, totalPercentUsed: 44 },
        onDemand: { enabled: true, used: 2, limit: 10 }
      }
    }, now)
    expect(percent(cursor.monthly)).toBe(44)
    expect(cursor.monthly?.windowMinutes).toBe(60)
    expect(cursor.buckets?.map((bucket) => bucket.name)).toEqual(['Cursor Models', 'Other Models', 'On-demand'])
    expect(cursor.planType).toBe('pro')

    const zcode = mapZcodeUsage({
      success: true,
      code: 200,
      data: {
        level: 'GLM Coding Plan',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 100, currentValue: 27, nextResetTime: now + 3_600_000 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 50, nextResetTime: now + 30 * 86_400_000 }
        ]
      }
    }, now)
    expect(percent(zcode.weekly)).toBe(27)
    expect(percent(zcode.monthly)).toBe(50)
    expect(zcode.planType).toBe('GLM Coding Plan')
  })

  test('rejects malformed provider payloads instead of inventing zero usage', () => {
    expect(mapClaudeUsage({ five_hour: { utilization: Number.NaN } }, now).session).toBeNull()
    expect(mapGeminiUsage({ buckets: [{ modelId: 'pro', remainingFraction: Number.NaN, resetTime: 'bad' }] }, now).buckets).toEqual([])
    expect(mapAntigravityUsage({ status: 'SUCCESS' }, now).status).not.toBe('ok')
    expect(mapMiniMaxUsage({ model_remains: [] }, ['general'], now).status).not.toBe('ok')
  })
})
