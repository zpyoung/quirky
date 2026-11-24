import { posix as pathPosix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSkillDiscoverySources, type SkillScanRoot } from '../skill-discovery-sources'
import { CODEX_PLUGIN_CACHE_ROOT_ID, pluginNameForSkill } from './skill-plugin-name-resolution'

const HOME = '/home/alice'

function root(id: string): SkillScanRoot {
  const found = buildSkillDiscoverySources({
    homeDir: HOME,
    cwd: '/workspace/quirky',
    repos: [],
    pathApi: pathPosix
  }).find((candidate) => candidate.id === id)
  if (!found) {
    throw new Error(`missing scan root ${id}`)
  }
  return found
}

describe('pluginNameForSkill', () => {
  const codexCache = root(CODEX_PLUGIN_CACHE_ROOT_ID)

  it('names the plugin from a shared Codex cache path', () => {
    expect(
      pluginNameForSkill(
        codexCache,
        `${codexCache.path}/openai-curated-remote/plugin-management/0.1.0/skills/manage/SKILL.md`,
        pathPosix
      )
    ).toBe('plugin-management')
  })

  it('prefers the root plugin name over path arithmetic', () => {
    expect(
      pluginNameForSkill(
        { ...codexCache, id: 'claude-plugin-abc', pluginName: 'quirk' },
        `${codexCache.path}/marketplace/other/0.1.0/skills/render/SKILL.md`,
        pathPosix
      )
    ).toBe('quirk')
  })

  it('returns null for a plugin root that names neither', () => {
    expect(
      pluginNameForSkill(
        { ...codexCache, id: 'claude-plugin-abc' },
        `${codexCache.path}/marketplace/other/0.1.0/skills/render/SKILL.md`,
        pathPosix
      )
    ).toBeNull()
  })

  it('returns null outside plugin scopes', () => {
    expect(
      pluginNameForSkill(root('home-claude'), `${HOME}/.claude/skills/render/SKILL.md`, pathPosix)
    ).toBeNull()
  })

  it('returns null when the cache path stops short of a plugin directory', () => {
    expect(
      pluginNameForSkill(codexCache, `${codexCache.path}/marketplace/SKILL.md`, pathPosix)
    ).toBeNull()
  })
})
