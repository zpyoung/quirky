import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { PluginContext, Session } from '@quirky/protocol'
import { pickItems } from '../src/pickers.ts'
import type { PickerItem } from '../src/types.ts'

const roots: string[] = []
let originalEnvironment: Record<string, string | undefined> = {}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-dock-pickers-'))
  roots.push(root)
  return root
}

function writeFixture(root: string, path: string, text = ''): string {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

function context(root: string): PluginContext {
  return { home: join(root, '.quirky'), dataDir: join(root, 'plugin-data') } as unknown as PluginContext
}

function session(cwd: string, agent = 'claude'): Session {
  return { id: 'session-1', cwd, agent } as Session
}

function item(items: PickerItem[], kind: PickerItem['kind'], insert: string): PickerItem | undefined {
  return items.find((candidate) => candidate.kind === kind && candidate.insert === insert)
}

beforeEach(() => {
  originalEnvironment = {
    HOME: process.env.HOME,
    GROK_HOME: process.env.GROK_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OMP_CODING_AGENT_DIR: process.env.OMP_CODING_AGENT_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
    OMP_PROFILE: process.env.OMP_PROFILE,
    PI_PROFILE: process.env.PI_PROFILE,
    PI_CONFIG_FILES: process.env.PI_CONFIG_FILES
  }
  process.env.HOME = sandbox()
  delete process.env.GROK_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.XDG_CONFIG_HOME
  delete process.env.OMP_CODING_AGENT_DIR
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_CONFIG_DIR
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  delete process.env.PI_CONFIG_FILES
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnvironment = {}
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pickItems', () => {
  test('discovers local Claude commands and skills with their supported slash invocation', async () => {
    const root = sandbox()
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    process.env.HOME = home

    writeFixture(home, '.claude/commands/review.md', '---\ndescription: Review the current change\n---\nRead the diff.')
    writeFixture(home, '.claude/skills/review/SKILL.md', '---\nname: review\ndescription: Review this workspace\n---\nInstructions.')
    writeFixture(cwd, '.claude/skills/local-check/SKILL.md', '---\nname: local-check\n---\nCheck local files.')

    const result = await pickItems(context(root), session(cwd), 'slash', '')

    expect(item(result.items, 'command', '/review ')).toMatchObject({
      id: expect.any(String),
      label: 'review',
      insert: '/review ',
      kind: 'command',
    })
    expect(item(result.items, 'skill', '/review ')).toMatchObject({
      id: expect.any(String),
      label: 'review',
      insert: '/review ',
      kind: 'skill',
      detail: 'Review this workspace'
    })
    expect(item(result.items, 'skill', '/local-check ')).toMatchObject({
      label: 'local-check',
      kind: 'skill'
    })
    const launchHome = join(root, 'launched-home')
    writeFixture(launchHome, '.claude/skills/launched-review/SKILL.md', '---\nname: launched-review\ndescription: Launched review\n---\nInstructions.')
    const launchedSession = {
      ...session(cwd),
      launch: { command: 'claude', args: '', env: { HOME: launchHome } }
    } as Session
    const launched = await pickItems(context(root), launchedSession, 'slash', 'launched-review')
    expect(item(launched.items, 'skill', '/launched-review ')).toBeDefined()
    const filtered = await pickItems(context(root), session(cwd), 'slash', '/rev')
    expect(filtered.items.map((candidate) => candidate.kind)).toEqual(['command', 'skill'])
    expect(filtered.truncated).toBe(false)
    expect(result.truncated).toBe(false)
  })

  test('uses verified Codex commands and the agent-skills invocation', async () => {
    const root = sandbox()
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    process.env.HOME = home
    mkdirSync(home, { recursive: true })
    writeFixture(cwd, '.agents/skills/workspace-review/SKILL.md', '---\nname: workspace-review\ndescription: Inspect a patch\n---\nReview instructions.')
    writeFixture(cwd, '.claude/commands/not-codex.md', '---\ndescription: Claude only\n---\n')

    const result = await pickItems(context(root), session(cwd, 'codex'), 'slash', 'review')

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'review', insert: '/review ', kind: 'command' }),
      expect.objectContaining({ label: 'workspace-review', insert: '$workspace-review ', kind: 'skill', detail: 'Inspect a patch' })
    ]))
    expect(result.truncated).toBe(false)
    const emptyWorkspace = join(root, 'no-skills')
    mkdirSync(emptyWorkspace, { recursive: true })
    const empty = await pickItems(context(root), session(emptyWorkspace, 'codex'), 'slash', '')
    expect(empty.items.some((candidate) => candidate.kind === 'skill' && candidate.insert === '$workspace-review ')).toBe(false)
    expect(item(empty.items, 'command', '/model ')).toBeDefined()
    expect(empty.truncated).toBe(false)
  })


  test('discovers configured Claude and Grok skills and verified OMP commands', async () => {
    const root = sandbox()
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    const claudeConfig = join(root, 'claude-config')
    const grokHome = join(root, 'grok-home')
    const xdgConfig = join(root, 'xdg-config')
    process.env.HOME = home
    process.env.CLAUDE_CONFIG_DIR = claudeConfig
    process.env.GROK_HOME = grokHome
    process.env.XDG_CONFIG_HOME = xdgConfig
    delete process.env.PI_CONFIG_DIR
    delete process.env.OMP_CODING_AGENT_DIR
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.OMP_PROFILE
    delete process.env.PI_PROFILE

    writeFixture(claudeConfig, 'skills/private-review/SKILL.md', '---\nname: private-review\n---\nReview.')
    writeFixture(cwd, '.claude/skills/workspace-review/SKILL.md', '---\nname: workspace-review\n---\nReview.')
    writeFixture(grokHome, 'skills/grok-review/SKILL.md', '---\nname: grok-review\n---\nReview.')
    writeFixture(cwd, '.grok/skills/local-grok/SKILL.md', '---\nname: local-grok\n---\nReview.')
    writeFixture(home, '.agents/skills/shared/SKILL.md', '---\nname: shared\n---\nShared.')
    writeFixture(cwd, '.claude/skills/claude-shared/SKILL.md', '---\nname: claude-shared\n---\nShared.')
    writeFixture(cwd, '.opencode/skills/open-local/SKILL.md', '---\nname: open-local\n---\nOpenCode.')
    writeFixture(xdgConfig, 'opencode/skills/open-global/SKILL.md', '---\nname: open-global\n---\nOpenCode.')
    writeFixture(cwd, '.omp/skills/omp-workflow/SKILL.md', '---\nname: omp-workflow\ndescription: OMP workflow\n---\nInstructions.')
    writeFixture(home, '.omp/agent/skills/omp-global/SKILL.md', '---\nname: omp-global\ndescription: OMP global workflow\n---\nInstructions.')
    writeFixture(cwd, '.omp/skills/no-description/SKILL.md', '---\nname: hidden-skill\n---\nNo description.')
    writeFixture(home, '.zcode/skills/zcode-review/SKILL.md', '---\nname: zcode-review\ndescription: ZCode review\n---\nReview.')
    writeFixture(cwd, '.agents/skills/zcode-project/SKILL.md', '---\nname: zcode-project\ndescription: ZCode project workflow\n---\nReview.')
    writeFixture(home, '.zcode/commands/quick-check.md', '---\ndescription: Quick check\n---\nRun checks.')

    const ompGlobalCustom = join(home, 'shared skills', 'omp-global-custom')
    writeFixture(ompGlobalCustom, 'SKILL.md', '---\ndescription: OMP global custom workflow\n---\nInstructions.')
    writeFixture(home, '.omp/agent/config.yml', `skills:\n  customDirectories:\n    - ${JSON.stringify(join(home, 'shared skills'))}\n`)

    const ompProjectCustom = join(cwd, 'shared skills', 'omp-project-custom')
    writeFixture(ompProjectCustom, 'SKILL.md', '---\ndescription: OMP project custom workflow\n---\nInstructions.')
    writeFixture(join(cwd, 'shared skills', 'omp-workflow'), 'SKILL.md', '---\nname: omp-workflow\ndescription: OMP custom override\n---\nCustom instructions.')
    const ompOutside = join(root, 'omp outside')
    writeFixture(ompOutside, 'omp-hidden/SKILL.md', '---\ndescription: OMP should not follow this symlink\n---\nInstructions.')
    const ompSymlink = join(cwd, 'omp skill link')
    symlinkSync(ompOutside, ompSymlink, 'dir')
    writeFixture(cwd, '.omp/config.yml', `skills:\n  customDirectories:\n    - ${JSON.stringify(join(cwd, 'shared skills'))}\n    - ${JSON.stringify(ompSymlink)}\n`)
    const ompExplicitSkill = join(cwd, 'overlay skills', 'omp-explicit')
    writeFixture(ompExplicitSkill, 'SKILL.md', '---\ndescription: OMP launch overlay workflow\n---\nInstructions.')
    const ompOverlayConfig = writeFixture(
      root,
      'omp overlay.yml',
      `skills:\n  customDirectories:\n    - ${JSON.stringify(join(cwd, 'overlay skills'))}\n`
    )

    const claude = await pickItems(context(root), session(cwd, 'claude'), 'slash', 'private')
    expect(item(claude.items, 'skill', '/private-review ')).toBeDefined()
    expect(claude.truncated).toBe(false)

    const grok = await pickItems(context(root), session(cwd, 'grok'), 'slash', 'grok')
    expect(grok.items.map((candidate) => candidate.insert)).toContain('/grok-review ')
    expect(grok.items.map((candidate) => candidate.insert)).toContain('/local-grok ')
    expect(grok.items.some((candidate) => candidate.kind === 'command')).toBe(false)

    const openCode = await pickItems(context(root), session(cwd, 'opencode'), 'slash', 'open-')
    expect(openCode.items.map((candidate) => candidate.insert)).toEqual(['/open-global ', '/open-local '])
    const sharedClaudeConfigSkill = await pickItems(context(root), session(cwd, 'opencode'), 'slash', 'private-review')
    expect(item(sharedClaudeConfigSkill.items, 'skill', '/private-review ')).toBeDefined()
    const sharedOpenCodeSkill = await pickItems(context(root), session(cwd, 'opencode'), 'slash', 'claude-shared')
    expect(item(sharedOpenCodeSkill.items, 'skill', '/claude-shared ')).toBeDefined()
    const openCodeHelp = await pickItems(context(root), session(cwd, 'opencode'), 'slash', 'help')
    expect(item(openCodeHelp.items, 'command', '/help ')).toBeDefined()
    const ompSkills = await pickItems(context(root), session(cwd, 'omp'), 'slash', '/skill:omp-')
    expect(ompSkills.items.map((candidate) => candidate.insert)).toContain('/skill:omp-workflow ')
    expect(ompSkills.items.map((candidate) => candidate.insert)).toContain('/skill:omp-project-custom ')
    expect(ompSkills.items.map((candidate) => candidate.insert)).not.toContain('/skill:omp-global-custom ')
    expect(ompSkills.items.map((candidate) => candidate.insert)).not.toContain('/skill:omp-hidden ')
    expect(item(ompSkills.items, 'skill', '/skill:omp-workflow ')?.detail).toBe('OMP custom override')
    const launchedOmp = {
      ...session(cwd, 'omp'),
      launch: { command: 'omp', args: `--config ${JSON.stringify(ompOverlayConfig)}`, env: {} }
    } as Session
    const ompOverlaySkills = await pickItems(context(root), launchedOmp, 'slash', '/skill:omp-')
    expect(ompOverlaySkills.items.map((candidate) => candidate.insert)).toContain('/skill:omp-explicit ')
    expect(ompOverlaySkills.items.map((candidate) => candidate.insert)).not.toContain('/skill:omp-project-custom ')
    const profileCwd = join(root, 'profile-workspace')
    mkdirSync(profileCwd, { recursive: true })
    const profileSkillsRoot = join(root, 'profile custom skills')
    writeFixture(profileSkillsRoot, 'omp-profile/SKILL.md', '---\ndescription: OMP profile workflow\n---\nInstructions.')
    const profileConfigRoot = join(root, 'omp profile config')
    writeFixture(profileConfigRoot, 'profiles/review/agent/config.yml', `skills:\n  customDirectories:\n    - ${JSON.stringify(profileSkillsRoot)}\n`)
    const profileSession = {
      ...session(profileCwd, 'omp'),
      launch: { command: 'omp', args: '--profile review', env: { PI_CONFIG_DIR: profileConfigRoot } }
    } as Session
    const profileSkills = await pickItems(context(root), profileSession, 'slash', '/skill:omp-')
    expect(profileSkills.items.map((candidate) => candidate.insert)).toContain('/skill:omp-profile ')
    const zcodeSkills = await pickItems(context(root), session(cwd, 'zcode'), 'slash', 'zcode-')
    expect(zcodeSkills.items.map((candidate) => candidate.insert)).toContain('$zcode-review ')
    expect(zcodeSkills.items.map((candidate) => candidate.insert)).toContain('$zcode-project ')
    const zcodeCommand = await pickItems(context(root), session(cwd, 'zcode'), 'slash', 'quick-check')
    expect(item(zcodeCommand.items, 'command', '/quick-check ')).toBeDefined()
    const omp = await pickItems(context(root), session(cwd, 'omp'), 'slash', 'switch')
    expect(item(omp.items, 'command', '/switch ')).toBeDefined()
  })
  test('returns workspace-relative file mentions and ignores symlinks escaping the workspace', async () => {
    const root = sandbox()
    const cwd = join(root, 'workspace')
    const outside = join(root, 'outside')
    const expected = writeFixture(cwd, 'src/model.ts', 'export type Model = string')
    writeFixture(outside, 'secret.ts', 'not in the workspace')
    writeFixture(cwd, 'docs/model draft.ts', 'export type Draft = string')
    symlinkSync(outside, join(cwd, 'external'), 'dir')
    symlinkSync(join(outside, 'secret.ts'), join(cwd, 'src/secret.ts'))

    const result = await pickItems(context(root), session(cwd), 'file', '@src/mo')

    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'file:src/model.ts',
        label: 'src/model.ts',
        insert: '@src/model.ts ',
        kind: 'file'
      })
    ])
    expect(result.truncated).toBe(false)
    expect(relative(cwd, expected)).toBe('src/model.ts')
    const spaced = await pickItems(context(root), session(cwd), 'file', '@docs/model draft')
    expect(spaced.items).toEqual([
      expect.objectContaining({
        label: 'docs/model draft.ts',
        insert: '@docs/model%20draft.ts ',
        kind: 'file'
      })
    ])

    const escaped = await pickItems(context(root), session(cwd), 'file', 'secret')
    expect(escaped.items).toEqual([])
  })

  test('discovers Gemini project commands and skills', async () => {
    const root = sandbox()
    const cwd = join(root, 'workspace')
    writeFixture(cwd, '.gemini/commands/verify.toml', 'description = "Verify workspace"')
    writeFixture(cwd, '.agents/skills/gemini-review/SKILL.md', '---\nname: gemini-review\ndescription: Review a Gemini workspace\n---\nInstructions.')

    const commands = await pickItems(context(root), session(cwd, 'gemini'), 'slash', 'verify')
    expect(item(commands.items, 'command', '/verify ')).toMatchObject({
      label: 'verify',
      insert: '/verify ',
      kind: 'command',
      detail: 'Verify workspace'
    })
    const skills = await pickItems(context(root), session(cwd, 'gemini'), 'slash', 'gemini-review')
    expect(item(skills.items, 'skill', '/gemini-review ')).toMatchObject({
      label: 'gemini-review',
      insert: '/gemini-review ',
      kind: 'skill',
      detail: 'Review a Gemini workspace'
    })
  })

})
