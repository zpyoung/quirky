import { describe, expect, test } from 'bun:test'
import type { ContributionInfo } from '@quirky/protocol'
import { AUTO_PICK_ORDER, buildCatalog } from '../../src/core/catalog'

function agent(plugin: string, name: string, data: Record<string, unknown> = {}): ContributionInfo {
  return {
    id: `agent:${plugin}/${name}`,
    kind: 'agent',
    name,
    plugin,
    override: false,
    status: 'effective',
    data: { label: name, detect: name, prompt: 'argv', ...data }
  }
}

const ids = (contributions: ContributionInfo[]) => buildCatalog(contributions).agents.map((entry) => entry.id)

describe('buildCatalog', () => {
  test('the auto-pick order is Orca\'s 45 agents', () => {
    expect(AUTO_PICK_ORDER).toHaveLength(45)
    expect(new Set(AUTO_PICK_ORDER).size).toBe(45)
    expect(AUTO_PICK_ORDER.slice(0, 4)).toEqual(['claude', 'claude-agent-teams', 'openclaude', 'codex'])
    expect(AUTO_PICK_ORDER.at(-1)).toBe('jcode')
  })

  test('built-in agents come out in auto-pick order whatever order they went in', () => {
    const input = ['gemini', 'codex', 'claude', 'jcode', 'aider'].map((name) => agent('quirky.agents', name))
    expect(ids(input)).toEqual(['claude', 'codex', 'gemini', 'aider', 'jcode'])
  })

  test('other plugins\' agents follow the built-ins, by plugin ID then agent ID', () => {
    const input = [
      agent('zed.agents', 'alpha'),
      agent('acme.agents', 'zulu'),
      agent('quirky.agents', 'codex'),
      agent('acme.agents', 'bot'),
      agent('quirky.agents', 'claude')
    ]
    const catalog = buildCatalog(input)
    expect(catalog.agents.map((entry) => `${entry.plugin}/${entry.id}`)).toEqual([
      'quirky.agents/claude',
      'quirky.agents/codex',
      'acme.agents/bot',
      'acme.agents/zulu',
      'zed.agents/alpha'
    ])
    expect(catalog.problems).toEqual([])
  })

  test('a built-in agent outside the auto-pick order sorts after the listed built-ins and before other plugins', () => {
    const input = [agent('acme.agents', 'bot'), agent('quirky.extra', 'extra'), agent('quirky.agents', 'jcode')]
    expect(ids(input)).toEqual(['jcode', 'extra', 'bot'])
  })

  test('SC-2: a plugin\'s agent is validated and carries its plugin ID', () => {
    const catalog = buildCatalog([agent('acme.agents', 'acme-bot', { prompt: 'flag-prompt', yolo: '--yes' })])
    expect(catalog.agents).toHaveLength(1)
    expect(catalog.agents[0]).toMatchObject({ id: 'acme-bot', plugin: 'acme.agents', prompt: 'flag-prompt', yolo: '--yes', launch: 'acme-bot' })
  })

  test('SC-3: an override is a complete entry from the overriding plugin and keeps working', () => {
    const override: ContributionInfo = {
      ...agent('acme.override', 'codex', { launch: 'codex --profile acme' }),
      id: 'agent:quirky.agents/codex',
      override: true
    }
    const catalog = buildCatalog([agent('quirky.agents', 'claude'), override])
    const codex = catalog.agents.find((entry) => entry.id === 'codex')!
    expect(codex).toMatchObject({ plugin: 'acme.override', launch: 'codex --profile acme' })
    expect(catalog.problems).toEqual([])
  })

  test('SC-3: an override with only some fields is invalid, because it does not merge with the base', () => {
    const partial: ContributionInfo = {
      ...agent('acme.override', 'codex'),
      id: 'agent:quirky.agents/codex',
      override: true,
      data: { launch: 'codex --profile acme' }
    }
    const catalog = buildCatalog([partial])
    expect(catalog.agents).toEqual([])
    expect(catalog.problems).toEqual([{ plugin: 'acme.override', id: 'codex', status: 'invalid', error: 'detect command is required' }])
  })

  test('SC-4: an invalid entry is left out and reported with its error, and the rest load', () => {
    const catalog = buildCatalog([
      agent('quirky.agents', 'claude'),
      { ...agent('acme.bad', 'broken'), data: { label: 'Broken', prompt: 'argv' } },
      agent('quirky.agents', 'codex')
    ])
    expect(catalog.agents.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(catalog.problems).toEqual([{ plugin: 'acme.bad', id: 'broken', status: 'invalid', error: 'detect command is required' }])
  })

  test('SC-4: a duplicate name loses to the built-in, naming the winner and pointing at overrides', () => {
    const catalog = buildCatalog([agent('acme.dupe', 'claude'), agent('quirky.agents', 'claude')])
    expect(catalog.agents.map((entry) => entry.plugin)).toEqual(['quirky.agents'])
    expect(catalog.problems).toHaveLength(1)
    const [problem] = catalog.problems
    expect(problem).toMatchObject({ plugin: 'acme.dupe', id: 'claude', status: 'conflict' })
    expect(problem!.error).toContain('quirky.agents')
    expect(problem!.error).toContain('use overrides to replace a built-in agent')
  })

  test('SC-4: among non-built-in plugins the lower plugin ID wins', () => {
    const catalog = buildCatalog([agent('zed.agents', 'bot'), agent('acme.agents', 'bot'), agent('mid.agents', 'bot')])
    expect(catalog.agents.map((entry) => entry.plugin)).toEqual(['acme.agents'])
    expect(catalog.problems.map((problem) => [problem.plugin, problem.status]).sort()).toEqual([
      ['mid.agents', 'conflict'],
      ['zed.agents', 'conflict']
    ])
    expect(catalog.problems.every((problem) => problem.error.includes('acme.agents'))).toBe(true)
  })

  test('between two built-in plugins the lower plugin ID wins', () => {
    const catalog = buildCatalog([agent('quirky.b', 'bot'), agent('quirky.a', 'bot')])
    expect(catalog.agents.map((entry) => entry.plugin)).toEqual(['quirky.a'])
    expect(catalog.problems).toMatchObject([{ plugin: 'quirky.b', id: 'bot', status: 'conflict' }])
  })

  test('an invalid duplicate is reported as invalid and does not displace a valid entry', () => {
    const invalid = { ...agent('acme.dupe', 'claude'), data: { label: 'Claude' } }
    const catalog = buildCatalog([agent('quirky.agents', 'claude'), invalid])
    expect(catalog.agents.map((entry) => entry.plugin)).toEqual(['quirky.agents'])
    expect(catalog.problems).toMatchObject([{ plugin: 'acme.dupe', id: 'claude', status: 'invalid' }])
  })

  test('only effective agent contributions are read', () => {
    const other: ContributionInfo = { ...agent('acme.agents', 'bot'), kind: 'panel' }
    const overridden: ContributionInfo = { ...agent('acme.agents', 'old'), status: 'overridden' }
    expect(ids([other, overridden, agent('acme.agents', 'new')])).toEqual(['new'])
  })

  test('an empty contribution list gives an empty catalog', () => {
    expect(buildCatalog([])).toEqual({ agents: [], problems: [] })
  })
})
