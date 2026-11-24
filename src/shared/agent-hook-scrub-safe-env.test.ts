import { describe, expect, it } from 'vitest'
import {
  applyScrubSafeAgentEnvAliases,
  QUIRKY_SCRUB_SAFE_LAUNCH_ENV,
  QUIRKY_SCRUB_SAFE_PANE_ENV
} from './agent-hook-scrub-safe-env'

/** The rule DeepSeek Harness's shell executor applies, measured against dsh 0.1.5-rc.1. */
function isScrubbedName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/.test(name)
}

describe('applyScrubSafeAgentEnvAliases', () => {
  it('mirrors pane identity onto names a credential scrub keeps', () => {
    const env: Record<string, string> = {
      QUIRKY_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111',
      QUIRKY_AGENT_LAUNCH_TOKEN: 'launch-abc'
    }
    applyScrubSafeAgentEnvAliases(env)
    expect(env[QUIRKY_SCRUB_SAFE_PANE_ENV]).toBe(env.QUIRKY_PANE_KEY)
    expect(env[QUIRKY_SCRUB_SAFE_LAUNCH_ENV]).toBe(env.QUIRKY_AGENT_LAUNCH_TOKEN)
  })

  it('picks alias names the scrub does not take', () => {
    // The whole point: if an alias were itself scrubbed it would carry nothing.
    expect(isScrubbedName(QUIRKY_SCRUB_SAFE_PANE_ENV)).toBe(false)
    expect(isScrubbedName(QUIRKY_SCRUB_SAFE_LAUNCH_ENV)).toBe(false)
    expect(isScrubbedName('QUIRKY_PANE_KEY')).toBe(true)
    expect(isScrubbedName('QUIRKY_AGENT_LAUNCH_TOKEN')).toBe(true)
  })

  it('leaves the canonical names untouched', () => {
    const env: Record<string, string> = {
      QUIRKY_PANE_KEY: 'pane',
      QUIRKY_AGENT_LAUNCH_TOKEN: 'tok'
    }
    applyScrubSafeAgentEnvAliases(env)
    expect(env.QUIRKY_PANE_KEY).toBe('pane')
    expect(env.QUIRKY_AGENT_LAUNCH_TOKEN).toBe('tok')
  })

  it('drops a stale alias when its source is gone', () => {
    // Why this matters: an alias inherited from a parent pane would attribute this pane's
    // hooks to the wrong row — worse than reporting no status at all.
    const env: Record<string, string> = {
      [QUIRKY_SCRUB_SAFE_PANE_ENV]: 'inherited-pane',
      [QUIRKY_SCRUB_SAFE_LAUNCH_ENV]: 'inherited-launch'
    }
    applyScrubSafeAgentEnvAliases(env)
    expect(env[QUIRKY_SCRUB_SAFE_PANE_ENV]).toBeUndefined()
    expect(env[QUIRKY_SCRUB_SAFE_LAUNCH_ENV]).toBeUndefined()
  })

  it('treats an empty source as absent', () => {
    const env: Record<string, string> = {
      QUIRKY_PANE_KEY: '',
      [QUIRKY_SCRUB_SAFE_PANE_ENV]: 'stale'
    }
    applyScrubSafeAgentEnvAliases(env)
    expect(env[QUIRKY_SCRUB_SAFE_PANE_ENV]).toBeUndefined()
  })
})
