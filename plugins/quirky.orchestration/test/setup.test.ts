import { describe, expect, test } from 'bun:test'
import type { PluginCaller } from '@quirky/protocol'
import { renderOrchestrationSkill, skillPathForAgent } from '../src/skill'
import { canChangePolicy } from '../src/setup'

describe('orchestration setup policy and skill', () => {

  test('skill targets match native global directories for detected agent IDs', () => {
    const home = '/private/test-home'
    const env = { HOME: home }
    expect(skillPathForAgent('claude', env)).toBe(`${home}/.claude/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('codex', env)).toBe(`${home}/.agents/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('cursor', env)).toBe(`${home}/.cursor/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('opencode', env)).toBe(`${home}/.config/opencode/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('gemini', env)).toBe(`${home}/.gemini/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('amp', env)).toBe(`${home}/.config/agents/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('antigravity', env)).toBe(`${home}/.gemini/antigravity/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('droid', env)).toBe(`${home}/.factory/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('goose', env)).toBe(`${home}/.config/goose/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('roo', env)).toBe(`${home}/.roo/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('qwen-code', env)).toBe(`${home}/.qwen/skills/orchestration/SKILL.md`)
    expect(skillPathForAgent('unknown-agent', env)).toBeNull()
    expect(skillPathForAgent('toString', env)).toBeNull()
  })


  test('agent target config overrides are respected without changing the repository cwd', () => {
    expect(skillPathForAgent('claude', { HOME: '/home/a', CLAUDE_CONFIG_DIR: '/private/claude' }))
      .toBe('/private/claude/skills/orchestration/SKILL.md')
    expect(skillPathForAgent('codex', { HOME: '/home/a', CODEX_HOME: '/private/codex' }))
      .toBe('/home/a/.agents/skills/orchestration/SKILL.md')
    expect(skillPathForAgent('opencode', { HOME: '/home/a', XDG_CONFIG_HOME: '/private/config' }))
      .toBe('/private/config/opencode/skills/orchestration/SKILL.md')
  })

  test('policy changes require an unbound non-paired caller, not a caller-supplied role', () => {
    expect(canChangePolicy({ role: 'cli' })).toBe(true)
    expect(canChangePolicy({ role: 'ui' })).toBe(true)
    expect(canChangePolicy({ role: 'ui', sessionId: 'session-a' })).toBe(false)
    expect(canChangePolicy({ role: 'ui', sessionAuthority: {} } as PluginCaller)).toBe(false)
    expect(canChangePolicy({ role: 'cli', deviceId: 'paired-device' })).toBe(false)
    expect(canChangePolicy({ role: 'ui', deviceId: 'paired-device' })).toBe(false)
    expect(canChangePolicy({ role: 'mobile', deviceId: 'paired-device' })).toBe(false)
    expect(canChangePolicy({ role: 'plugin', pluginId: 'quirky.test' })).toBe(false)
  })


})
