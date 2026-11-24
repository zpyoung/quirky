import { startSpan } from '../observability/tracer'

const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const MAX_OBSERVED_COUNT = 1_000_000
// Roots grow with the repo count, so an uncapped id list makes one log line
// grow with the batch.
const MAX_LOGGED_DELETE_ROOT_IDS = 12

function safeLabel(value: string | undefined, fallback: string): string {
  return value && SAFE_LABEL.test(value) ? value : fallback
}

function boundedNumber(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), MAX_OBSERVED_COUNT) : 0
}

function platformLabel(): string {
  return ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'other'
}

/**
 * One summary line per delete batch. Root *ids* are safe to log where labels
 * and paths are not — a repo or plugin id is already a hash — matching
 * discovery's own logging rule.
 */
export function recordSkillDeleteOperation(input: {
  operationId: string
  hostKind: 'native-host' | 'wsl'
  skills: readonly { status: string }[]
  rootIds: readonly string[]
}): void {
  const counts = new Map<string, number>()
  for (const skill of input.skills) {
    counts.set(skill.status, (counts.get(skill.status) ?? 0) + 1)
  }
  const span = startSpan('skill.delete', {
    attributes: {
      phase: 'delete',
      platform: platformLabel(),
      host: safeLabel(input.hostKind, 'unknown'),
      skillCount: boundedNumber(input.skills.length),
      ...Object.fromEntries(
        [...counts].map(([status, count]) => [
          `${safeLabel(status, 'unknown')}Count`,
          boundedNumber(count)
        ])
      ),
      rootIds: input.rootIds.slice(0, MAX_LOGGED_DELETE_ROOT_IDS).join(',')
    }
  })
  span.end()
}
