import { describe, expect, test } from 'bun:test'
import type { PluginCaller, PluginStore } from '@quirky/protocol'
import manifest from '../quirky-plugin.json'
import { renderOrchestrationSkill, skillPathForAgent } from '../src/skill'
import { canChangePolicy } from '../src/setup'
import { readNestedWorkerMaxDepth } from '../src/store'

const commandNames = new Set(manifest.contributes['cli-command'].map((entry) => entry.words))

describe('orchestration setup policy and skill', () => {
  test('generated skill describes the supervised loop with commands and flags present in this plugin manifest', () => {
    const skill = renderOrchestrationSkill()
    expect(skill).toMatch(/^---\nname: orchestration\ndescription: This skill should be used when/m)
    expect(skill).toContain('plain handoff with no worker supervision')
    expect(skill).toContain('core built-in status command')
    expect(skill).toContain('page.nextCursor')
    expect(skill).toContain('--cursor <next-cursor>')
    expect(skill).toContain('quirky status --json')
    expect(skill).toContain('worker_done')
    expect(skill).toContain('three empty waits')
    expect(skill).toContain('worker-list --terminal-state reclaimable')
    expect(skill).toContain('Do not stop, abandon, release, or reuse a worker from missing or unverifiable evidence')
    expect(skill).not.toMatch(/coordinator-start|coordinator-stop|--spec-json|orca orchestration/)

    const flagsByCommand = new Map(
      manifest.contributes['cli-command'].map((entry) => [entry.words, new Set(Object.keys(entry.flags ?? {}))])
    )
    for (const [, command, args] of skill.matchAll(/^quirky orchestration ([a-z][a-z-]*)(.*)$/gm)) {
      expect(commandNames.has(command), `undeclared orchestration CLI command ${command}`).toBe(true)
      const accepted = flagsByCommand.get(command)!
      for (const [, flag] of args.matchAll(/--([a-z][a-z-]*)/g)) {
        if (['json', 'yes', 'retry-request', 'pairing-code', 'environment'].includes(flag)) continue
        expect(accepted.has(flag), `--${flag} is not declared for orchestration ${command}`).toBe(true)
      }
    }
  })

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

  test('worker-list declares current task labels, lineage, and assignment evidence as required', () => {
    const workerList = manifest.contributes.method.find((entry) => entry.id === 'workerList')!
    const row = workerList.result.properties.workers.items
    expect(row.properties.currentAssignment.type).toBe('boolean')
    expect(row.required).toEqual(expect.arrayContaining([
      'taskTitle',
      'displayName',
      'coordinatorSessionId',
      'parentSessionId',
      'currentAssignment'
    ]))
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


  test('corrupt persisted nesting depth is normalized to the safe default', () => {
    let normalized = false
    const store = {
      get: () => ({ nested_worker_max_depth: Number.NaN }),
      run: (sql: string) => {
        normalized = sql.includes('UPDATE orchestration_policy')
        return { changes: 1, lastInsertRowid: 0 }
      },
      readOnly: false
    } as unknown as PluginStore
    expect(readNestedWorkerMaxDepth(store)).toBe(1)
    expect(normalized).toBe(true)
  })
})
