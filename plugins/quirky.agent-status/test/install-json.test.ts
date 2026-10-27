import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hookCommand } from '../src/hook-command.ts'
import { isRealHomeInTest, resolveHome } from '../src/install/common.ts'
import {
  JSON_INSTALLERS,
  antigravityInstaller,
  copilotInstaller,
  cursorInstaller,
  geminiInstaller,
  kiroInstaller,
  museInstaller
} from '../src/install/other-json.ts'
import { codexInstaller, devinInstaller, droidInstaller, openclaudeInstaller, zcodeInstaller } from '../src/install/claude-json.ts'
import { InstallError, type InstallEnv, type Installer } from '../src/types.ts'

type Json = Record<string, any>

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-install-json-'))
  dirs.push(home)
  return home
}

function target(home: string, env: Record<string, string> = {}): InstallEnv {
  return { home, env: { HOME: home, ...env }, quirkyHome: join(home, '.quirky') }
}

function put(home: string, rel: string, content: Json | string): string {
  const path = join(home, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  return path
}

function read(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const userHook = { type: 'command', command: 'notify.sh' }

describe('shared helpers', () => {
  test('resolveHome prefers HOME over the OS home', () => {
    expect(resolveHome({ HOME: '/tmp/somewhere' })).toBe('/tmp/somewhere')
    expect(resolveHome({})).toBe(homedir())
  })

  test('isRealHomeInTest is true only for the real home, under NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test')
    expect(isRealHomeInTest(homedir())).toBe(true)
    expect(isRealHomeInTest(makeHome())).toBe(false)
  })
})

describe('merging into a settings file', () => {
  test('gemini keeps the user keys and hooks, reruns unchanged, and removes to the original (SC-24)', () => {
    const home = makeHome()
    const original = { theme: 'dark', hooks: { AfterAgent: [{ hooks: [userHook] }] } }
    const path = put(home, '.gemini/settings.json', original)

    expect(geminiInstaller.install(target(home))).toEqual({ changed: [path] })
    const installed = read(path)
    expect(installed.theme).toBe('dark')
    expect(Object.keys(installed.hooks)).toEqual(['AfterAgent', 'BeforeAgent', 'BeforeTool', 'AfterTool'])
    expect(installed.hooks.AfterAgent[0]).toEqual({ hooks: [userHook] })
    expect(installed.hooks.AfterAgent[1]).toEqual({
      hooks: [{ type: 'command', command: hookCommand('gemini'), timeout: 10000 }]
    })

    const bytes = readFileSync(path, 'utf8')
    expect(bytes.endsWith('}\n')).toBe(true)
    expect(geminiInstaller.install(target(home)).changed).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(bytes)

    expect(geminiInstaller.remove(target(home))).toEqual({ changed: [path] })
    expect(read(path)).toEqual(original)
    expect(geminiInstaller.remove(target(home)).changed).toEqual([])
  })

  test('a rerun leaves a file the user formatted differently alone', () => {
    const home = makeHome()
    const path = join(home, '.gemini/settings.json')
    geminiInstaller.install(target(home))
    const compact = JSON.stringify(read(path))
    writeFileSync(path, compact)

    expect(geminiInstaller.install(target(home)).changed).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(compact)
  })

  test('install replaces a stale Quirky entry and sweeps Quirky entries under retired events', () => {
    const home = makeHome()
    const stale = { type: 'command', command: hookCommand('openclaude').replace('; exit 0', '; true'), timeout: 3 }
    const path = put(home, '.openclaude/settings.json', {
      hooks: {
        Stop: [{ hooks: [userHook, stale] }],
        SessionEnd: [{ hooks: [stale] }, { hooks: [userHook] }]
      }
    })

    openclaudeInstaller.install(target(home))
    const hooks = read(path).hooks
    expect(hooks.Stop).toEqual([
      { hooks: [userHook] },
      { hooks: [{ type: 'command', command: hookCommand('openclaude'), timeout: 10 }] }
    ])
    expect(hooks.SessionEnd).toEqual([{ hooks: [userHook] }])

    openclaudeInstaller.remove(target(home))
    expect(read(path).hooks).toEqual({ Stop: [{ hooks: [userHook] }], SessionEnd: [{ hooks: [userHook] }] })
  })

  test('a user hook sharing a group with the Quirky hook survives remove', () => {
    const home = makeHome()
    const path = put(home, '.openclaude/settings.json', {
      hooks: { Stop: [{ hooks: [userHook, { type: 'command', command: hookCommand('openclaude') }] }] }
    })

    openclaudeInstaller.remove(target(home))
    expect(read(path)).toEqual({ hooks: { Stop: [{ hooks: [userHook] }] } })
  })

  test('an unparseable file is an InstallError naming it with ~, and stays untouched', () => {
    const home = makeHome()
    const path = put(home, '.factory/settings.json', '{ "hooks": ')

    expect(() => droidInstaller.install(target(home))).toThrow(InstallError)
    expect(() => droidInstaller.install(target(home))).toThrow('Could not parse ~/.factory/settings.json')
    expect(() => droidInstaller.remove(target(home))).toThrow('Could not parse ~/.factory/settings.json')
    expect(droidInstaller.status(target(home))).toEqual({ error: 'Could not parse ~/.factory/settings.json' })
    expect(readFileSync(path, 'utf8')).toBe('{ "hooks": ')
  })

  test('a file whose hooks key has the wrong shape is reported, not overwritten', () => {
    const home = makeHome()
    const path = put(home, '.factory/settings.json', { hooks: 'nope' })

    expect(() => droidInstaller.install(target(home))).toThrow('Could not parse ~/.factory/settings.json')
    expect(read(path)).toEqual({ hooks: 'nope' })
  })

  test('devin reads plain JSON, so a config with comments is an error', () => {
    const home = makeHome()
    const text = '{\n  // my setting\n  "a": 1\n}\n'
    const path = put(home, '.config/devin/config.json', text)

    expect(() => devinInstaller.install(target(home))).toThrow('Could not parse ~/.config/devin/config.json')
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  test('install creates parent directories 0700 and leaves no temp files', () => {
    const home = makeHome()
    geminiInstaller.install(target(home))

    const dir = join(home, '.gemini')
    expect(statMode(dir)).toBe(0o700)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('the real-home guard', () => {
  test('install and remove write nothing when home is the real home', () => {
    const elsewhere = makeHome()
    const real = { home: homedir(), env: { HOME: homedir(), CODEX_HOME: elsewhere }, quirkyHome: join(elsewhere, '.quirky') }

    const result = codexInstaller.install(real)
    expect(result.changed).toEqual([])
    expect(result.message).toContain('real home')
    expect(existsSync(join(elsewhere, 'hooks.json'))).toBe(false)
    expect(codexInstaller.remove(real).changed).toEqual([])
  })
})

describe('format specifics', () => {
  test('codex follows CODEX_HOME and asks the user to review the hooks', () => {
    const home = makeHome()
    const codexHome = join(makeHome(), 'codex')
    const result = codexInstaller.install(target(home, { CODEX_HOME: codexHome }))

    expect(result).toEqual({ changed: [join(codexHome, 'hooks.json')], note: 'Codex asks you to review these hooks once (/hooks)' })
    expect(Object.keys(read(join(codexHome, 'hooks.json')))).toEqual(['hooks'])
    expect(codexInstaller.files(target(home))).toEqual([join(home, '.codex/hooks.json')])
  })

  test('cursor writes version 1 first, keeps a version the user set, and runs the event-specific command', () => {
    const home = makeHome()
    const path = join(home, '.cursor/hooks.json')
    cursorInstaller.install(target(home))
    const fresh = read(path)
    expect(Object.keys(fresh)).toEqual(['version', 'hooks'])
    expect(fresh.hooks.stop).toEqual([{ command: hookCommand('cursor', 'stop'), timeout: 10 }])

    cursorInstaller.remove(target(home))
    expect(existsSync(path)).toBe(false)

    put(home, '.cursor/hooks.json', { version: 2, hooks: { stop: [{ command: 'mine.sh' }] } })
    cursorInstaller.install(target(home))
    expect(read(path).version).toBe(2)
    cursorInstaller.remove(target(home))
    expect(read(path)).toEqual({ version: 2, hooks: { stop: [{ command: 'mine.sh' }] } })
  })

  test('antigravity nests lifecycle entries directly and tool entries under a matcher', () => {
    const home = makeHome()
    antigravityInstaller.install(target(home))
    const bundle = read(join(home, '.gemini/config/hooks.json'))['quirky-status']

    expect(bundle.PreInvocation).toEqual([{ type: 'command', command: hookCommand('antigravity', 'PreInvocation'), timeout: 10 }])
    expect(bundle.PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: hookCommand('antigravity', 'PreToolUse'), timeout: 10 }] }
    ])
  })

  test('copilot writes bash entries with a 5 second timeout under COPILOT_HOME', () => {
    const home = makeHome()
    const copilotHome = join(makeHome(), 'cp')
    copilotInstaller.install(target(home, { COPILOT_HOME: copilotHome }))
    const file = read(join(copilotHome, 'hooks/quirky.json'))

    expect(file.version).toBe(1)
    expect(file.hooks.subagentStart).toEqual([{ type: 'command', bash: hookCommand('copilot', 'subagentStart'), timeoutSec: 5 }])
  })

  test('zcode sets hooks.enabled only when the user has not, and leaves it on remove', () => {
    const home = makeHome()
    const path = put(home, '.zcode/cli/config.json', { hooks: { enabled: false } })
    zcodeInstaller.install(target(home))
    expect(read(path).hooks.enabled).toBe(false)
    expect(Object.keys(read(path).hooks.events)).toHaveLength(7)

    rmSync(path)
    zcodeInstaller.install(target(home))
    expect(read(path).hooks.enabled).toBe(true)
    zcodeInstaller.remove(target(home))
    expect(existsSync(path)).toBe(false)

    put(home, '.zcode/cli/config.json', { name: 'x' })
    zcodeInstaller.install(target(home))
    zcodeInstaller.remove(target(home))
    expect(read(path)).toEqual({ name: 'x', hooks: { enabled: true } })
  })

  test('muse points settings.json at a Quirky-owned hooks file and allowlists the shim variables', () => {
    const home = makeHome()
    const xdg = join(makeHome(), 'xdg')
    const t = target(home, { XDG_CONFIG_HOME: xdg })
    const settings = join(xdg, 'muse/settings.json')
    const hooksFile = join(home, '.quirky/agent-hooks/muse-hooks.json')
    put(xdg, 'muse/settings.json', { schema_version: 1, theme: 'x', managed_hooks_env_vars: ['KEEP'] })

    expect(museInstaller.install(t).changed).toEqual([settings, hooksFile])
    expect(read(settings)).toEqual({
      schema_version: 1,
      theme: 'x',
      managed_hooks_env_vars: ['KEEP', 'QUIRKY_SESSION_ID', 'QUIRKY_HOME', 'QUIRKY_HOOK_URL', 'QUIRKY_HOOK_TOKEN'],
      managed_hooks_path: hooksFile
    })
    expect(Object.keys(read(hooksFile).hooks)).toHaveLength(11)
    expect(museInstaller.status(t)).toBe('installed')
    expect(museInstaller.install(t).changed).toEqual([])

    expect(museInstaller.remove(t).changed).toEqual([settings, hooksFile])
    expect(read(settings)).toEqual({ schema_version: 1, theme: 'x', managed_hooks_env_vars: ['KEEP'] })
    expect(existsSync(hooksFile)).toBe(false)
    expect(museInstaller.status(t)).toBe('not-installed')
  })

  test('muse leaves a managed_hooks_path the user pointed elsewhere', () => {
    const home = makeHome()
    const text = JSON.stringify({ schema_version: 1, managed_hooks_path: '/etc/mine.json' })
    const settings = put(home, '.config/muse/settings.json', text)
    const result = museInstaller.install(target(home))

    expect(result.changed).toEqual([])
    expect(result.message).toContain('/etc/mine.json')
    expect(readFileSync(settings, 'utf8')).toBe(text)
    expect(existsSync(join(home, '.quirky/agent-hooks/muse-hooks.json'))).toBe(false)
    expect(museInstaller.remove(target(home)).changed).toEqual([])
    expect(readFileSync(settings, 'utf8')).toBe(text)
  })

  test('kiro with no agents dir reports it and creates nothing', () => {
    const home = makeHome()
    expect(kiroInstaller.install(target(home))).toEqual({ changed: [], message: 'no Kiro agents to patch' })
    expect(kiroInstaller.status(target(home))).toBe('not-installed')
    expect(readdirSync(home)).toEqual([])
  })

  test('kiro patches each parseable agent json under KIRO_HOME and never deletes one', () => {
    const home = makeHome()
    const kiroHome = join(makeHome(), 'kiro')
    const t = target(home, { KIRO_HOME: kiroHome })
    const a = put(kiroHome, 'agents/a.json', { name: 'a', hooks: { stop: [{ command: 'mine.sh' }] } })
    const b = put(kiroHome, 'agents/b.json', { name: 'b' })
    const broken = put(kiroHome, 'agents/broken.json', '{')
    const notes = put(kiroHome, 'agents/notes.txt', 'hi')

    const result = kiroInstaller.install(t)
    expect(result.changed).toEqual([a, b])
    expect(result.message).toContain('broken.json')
    expect(read(a).hooks.stop).toEqual([
      { command: 'mine.sh' },
      { command: hookCommand('kiro'), timeout_ms: 10000 }
    ])
    expect(read(b).hooks.preToolUse).toEqual([{ matcher: '*', command: hookCommand('kiro'), timeout_ms: 10000 }])
    expect(readFileSync(broken, 'utf8')).toBe('{')
    expect(readFileSync(notes, 'utf8')).toBe('hi')
    expect(kiroInstaller.status(t)).toBe('installed')
    expect(kiroInstaller.install(t).changed).toEqual([])

    kiroInstaller.remove(t)
    expect(read(a)).toEqual({ name: 'a', hooks: { stop: [{ command: 'mine.sh' }] } })
    expect(read(b)).toEqual({ name: 'b' })
  })
})

type TableEntry = {
  installer: Installer
  /** The config file, relative to the home. */
  file: string
  /** The file holding the event map, when it isn't the config file (muse). */
  eventsFile?: string
  mapPath: string[]
  events: string[]
  /** Commands carry QUIRKY_HOOK_EVENT for these agents. */
  perEvent?: boolean
  /** A file the user already has, with the same keys after remove. */
  user: Json
  /** Quirky creates no file for this agent. */
  userOnly?: boolean
}

const CLAUDE_USER: Json = { theme: 'dark', hooks: { Notification: [{ hooks: [userHook] }] } }

const qoderEvents = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Notification',
  'PostCompact'
]

function entry(agent: string): Installer {
  const installer = JSON_INSTALLERS.find((candidate) => candidate.agent === agent)
  if (!installer) throw new Error(`no installer for ${agent}`)
  return installer
}

const TABLE: TableEntry[] = [
  {
    installer: entry('openclaude'),
    file: '.openclaude/settings.json',
    mapPath: ['hooks'],
    events: [
      'SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'TeammateIdle',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PostCompact'
    ],
    user: CLAUDE_USER
  },
  { installer: entry('qoder'), file: '.qoder/settings.json', mapPath: ['hooks'], events: qoderEvents, user: CLAUDE_USER },
  { installer: entry('qoder-cn'), file: '.qoder-cn/settings.json', mapPath: ['hooks'], events: qoderEvents, user: CLAUDE_USER },
  {
    installer: entry('qwen-code'),
    file: '.qwen/settings.json',
    mapPath: ['hooks'],
    events: [...qoderEvents.filter((e) => e !== 'PostCompact'), 'SubagentStart', 'SubagentStop'],
    user: CLAUDE_USER
  },
  {
    installer: entry('codebuddy'),
    file: '.codebuddy/settings.json',
    mapPath: ['hooks'],
    events: qoderEvents.filter((e) => e !== 'PostCompact'),
    user: CLAUDE_USER
  },
  {
    installer: entry('codex'),
    file: '.codex/hooks.json',
    mapPath: ['hooks'],
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'],
    user: { hooks: { Notification: [{ hooks: [userHook] }] } }
  },
  {
    installer: entry('gemini'),
    file: '.gemini/settings.json',
    mapPath: ['hooks'],
    events: ['BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'],
    user: CLAUDE_USER
  },
  {
    installer: entry('antigravity'),
    file: '.gemini/config/hooks.json',
    mapPath: ['quirky-status'],
    events: ['PreInvocation', 'PostInvocation', 'Stop', 'PreToolUse', 'PostToolUse'],
    perEvent: true,
    user: { 'other-bundle': { Stop: [{ type: 'command', command: 'mine.sh' }] } }
  },
  {
    installer: entry('cursor'),
    file: '.cursor/hooks.json',
    mapPath: ['hooks'],
    events: ['beforeSubmitPrompt', 'stop', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'beforeShellExecution', 'beforeMCPExecution', 'afterAgentResponse'],
    perEvent: true,
    user: { version: 1, hooks: { sessionStart: [{ command: 'mine.sh' }] } }
  },
  {
    installer: entry('droid'),
    file: '.factory/settings.json',
    mapPath: ['hooks'],
    events: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification'],
    user: CLAUDE_USER
  },
  {
    installer: entry('command-code'),
    file: '.commandcode/settings.json',
    mapPath: ['hooks'],
    events: ['PreToolUse', 'PostToolUse', 'Stop'],
    user: CLAUDE_USER
  },
  {
    installer: entry('grok'),
    file: '.grok/hooks/quirky-status.json',
    mapPath: ['hooks'],
    events: ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopCancelled', 'StopFailure', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification'],
    user: { hooks: { Notification: [{ hooks: [userHook] }] } }
  },
  {
    installer: entry('copilot'),
    file: '.copilot/hooks/quirky.json',
    mapPath: ['hooks'],
    events: [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'subagentStart',
      'SubagentStop', 'PreCompact', 'Stop', 'ErrorOccurred', 'PermissionRequest', 'Notification'
    ],
    perEvent: true,
    user: { version: 1, hooks: { Stop: [{ type: 'command', bash: 'mine.sh' }] } }
  },
  {
    installer: entry('devin'),
    file: '.config/devin/config.json',
    mapPath: ['hooks'],
    events: ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostCompaction', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PermissionRequest'],
    user: CLAUDE_USER
  },
  {
    installer: entry('muse'),
    file: '.config/muse/settings.json',
    eventsFile: '.quirky/agent-hooks/muse-hooks.json',
    mapPath: ['hooks'],
    events: ['SessionStart', 'SubagentStart', 'SessionEnd', 'Notification', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure'],
    user: { schema_version: 1, theme: 'x' }
  },
  {
    installer: entry('zcode'),
    file: '.zcode/cli/config.json',
    mapPath: ['hooks', 'events'],
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'],
    user: { hooks: { enabled: true, events: { Notification: [{ hooks: [userHook] }] } } }
  },
  {
    installer: entry('kiro'),
    file: '.kiro/agents/mine.json',
    mapPath: ['hooks'],
    events: ['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'],
    user: { name: 'mine', hooks: { stop: [{ command: 'mine.sh' }] } },
    userOnly: true
  }
]

function commandsOf(definition: Json): string[] {
  const direct = [definition.command, definition.bash].filter((c): c is string => typeof c === 'string')
  const nested = Array.isArray(definition.hooks) ? definition.hooks.map((hook: Json) => hook.command) : []
  return [...direct, ...nested]
}

function eventMap(home: string, row: TableEntry): Json {
  let node: any = read(join(home, row.eventsFile ?? row.file))
  for (const key of row.mapPath) node = node[key]
  return node
}

function expectQuirkyEvents(home: string, row: TableEntry): void {
  const map = eventMap(home, row)
  const source = row.installer.source
  const quirkyEvents = Object.keys(map).filter((event) => row.events.includes(event))
  expect(quirkyEvents.sort()).toEqual([...row.events].sort())
  for (const event of row.events) {
    const quirky = (map[event] as Json[]).flatMap(commandsOf).filter((c) => c.includes('/bin/quirky-hook"'))
    expect(quirky).toEqual([row.perEvent ? hookCommand(source, event) : hookCommand(source)])
  }
}

describe('every JSON installer (SC-25)', () => {
  test('the table covers every installer once', () => {
    expect(TABLE.map((row) => row.installer.agent).sort()).toEqual(JSON_INSTALLERS.map((i) => i.agent).sort())
    expect(new Set(JSON_INSTALLERS.map((i) => i.agent)).size).toBe(JSON_INSTALLERS.length)
    for (const installer of JSON_INSTALLERS) expect(installer.source).toBe(installer.agent)
  })

  for (const row of TABLE) {
    const { installer } = row

    test(`${installer.agent}: install, rerun, remove on an empty home`, () => {
      if (row.userOnly) {
        expect(installer.install(target(makeHome())).changed).toEqual([])
        return
      }
      const home = makeHome()
      const t = target(home)
      const first = installer.install(t)
      expect(first.changed).toContain(join(home, row.file))
      expect(installer.files(t)).toContain(join(home, row.file))
      expectQuirkyEvents(home, row)
      expect(installer.status(t)).toBe('installed')

      const snapshot = readFileSync(join(home, row.file), 'utf8')
      expect(installer.install(t).changed).toEqual([])
      expect(readFileSync(join(home, row.file), 'utf8')).toBe(snapshot)

      const removed = installer.remove(t)
      expect(removed.changed).toContain(join(home, row.file))
      expect(existsSync(join(home, row.file))).toBe(false)
      expect(existsSync(join(home, row.eventsFile ?? row.file))).toBe(false)
      expect(installer.status(t)).toBe('not-installed')
    })

    test(`${installer.agent}: install, rerun, remove on the user's file`, () => {
      const home = makeHome()
      const t = target(home)
      const path = put(home, row.file, row.user)

      expect(installer.install(t).changed).toContain(path)
      expectQuirkyEvents(home, row)
      expect(installer.status(t)).toBe('installed')
      const snapshot = readFileSync(path, 'utf8')
      expect(installer.install(t).changed).toEqual([])
      expect(readFileSync(path, 'utf8')).toBe(snapshot)

      expect(installer.remove(t).changed).toContain(path)
      expect(read(path)).toEqual(row.user)
      expect(installer.remove(t).changed).toEqual([])
    })
  }
})
