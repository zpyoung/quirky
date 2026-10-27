import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { hookCommand } from '../src/hook-command.ts'
import {
  OTHER_INSTALLERS,
  ampInstaller,
  mimoCodeInstaller,
  ompInstaller,
  opencode2Installer,
  opencodeInstaller,
  piInstaller,
  primeAgentInstaller
} from '../src/install/other-installers.ts'
import { dshInstaller, hermesInstaller } from '../src/install/yaml-installers.ts'
import { jcodeInstaller, kimiInstaller } from '../src/install/toml-installers.ts'
import { ampPluginSource } from '../src/install/sources/amp.ts'
import { hermesInitSource, hermesManifest } from '../src/install/sources/hermes.ts'
import { openCodePluginSource } from '../src/install/sources/opencode.ts'
import { piExtensionSource } from '../src/install/sources/pi.ts'
import { InstallError, type InstallEnv, type Installer } from '../src/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-install-other-'))
  dirs.push(home)
  return home
}

function target(home: string, env: Record<string, string> = {}): InstallEnv {
  return { home, env: { HOME: home, ...env }, quirkyHome: join(home, '.quirky') }
}

function put(home: string, rel: string, content: string): string {
  const path = join(home, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Every file under `dir` by relative path, for comparing a tree before install and after remove. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[relative(dir, full)] = readFileSync(full, 'utf8')
    }
  }
  walk(dir)
  return out
}

function expectError(installer: Installer, env: InstallEnv, message: string): void {
  let caught: unknown
  try {
    installer.install(env)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(InstallError)
  expect((caught as Error).message).toBe(message)
  expect(installer.status(env)).toEqual({ error: message })
}

/** Splits a command the way jcode does: on unquoted whitespace, single quotes verbatim, backslash escapes outside quotes. */
function shellTokens(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote = ''
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = ''
      else current += char
    } else if (quote === '"') {
      if (char === '"') quote = ''
      else if (char === '\\') current += command[++index]
      else current += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === '\\') {
      current += command[++index]
      started = true
    } else if (/\s/.test(char)) {
      if (started || current) tokens.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started || current) tokens.push(current)
  return tokens
}

describe('registry', () => {
  test('exports the eleven agents once each, with their hook sources', () => {
    expect(OTHER_INSTALLERS.map((installer) => installer.agent)).toEqual([
      'kimi',
      'jcode',
      'dsh',
      'hermes',
      'amp',
      'opencode',
      'opencode2',
      'mimo-code',
      'pi',
      'omp',
      'prime-agent'
    ])
    for (const installer of OTHER_INSTALLERS) expect(installer.source).toBe(installer.agent)
  })

  test('install and remove write nothing when home is the real home', () => {
    for (const installer of OTHER_INSTALLERS) {
      const elsewhere = makeHome()
      const env = {
        HOME: homedir(),
        KIMI_CODE_HOME: elsewhere,
        JCODE_HOME: elsewhere,
        DSH_HOME: elsewhere,
        HERMES_HOME: elsewhere,
        XDG_CONFIG_HOME: elsewhere,
        OPENCODE_CONFIG_DIR: elsewhere,
        MIMOCODE_HOME: elsewhere,
        PI_CODING_AGENT_DIR: elsewhere,
        PRIME_AGENT_CODING_AGENT_DIR: elsewhere
      }
      const real: InstallEnv = { home: homedir(), env, quirkyHome: join(elsewhere, '.quirky') }
      const installed = installer.install(real)
      expect(installed.changed).toEqual([])
      expect(installed.message).toContain('real home')
      expect(installer.remove(real).changed).toEqual([])
      expect(tree(elsewhere)).toEqual({})
    }
  })
})

describe('kimi', () => {
  const original = 'model = "kimi-k2"\n\n[ui]\ntheme = "dark"\n'

  test('appends one marked block of seven hook tables and removal restores the file', () => {
    const home = makeHome()
    const path = put(home, '.kimi-code/config.toml', original)
    const env = target(home)
    expect(kimiInstaller.install(env).changed).toEqual([path])
    const text = read(path)
    expect(text.startsWith(`${original}\n# >>> quirky-managed-kimi-hooks\n`)).toBe(true)
    expect(text.endsWith('# <<< quirky-managed-kimi-hooks\n')).toBe(true)
    const parsed = Bun.TOML.parse(text) as { model: string; ui: { theme: string }; hooks: { event: string; command: string; timeout: number }[] }
    expect(parsed.model).toBe('kimi-k2')
    expect(parsed.ui.theme).toBe('dark')
    expect(parsed.hooks.map((hook) => hook.event)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'Stop',
      'StopFailure'
    ])
    for (const hook of parsed.hooks) {
      expect(hook.command).toBe(hookCommand('kimi'))
      expect(hook.timeout).toBe(10)
    }
    expect(kimiInstaller.status(env)).toBe('installed')

    expect(kimiInstaller.install(env).changed).toEqual([])
    expect(read(path)).toBe(text)

    expect(kimiInstaller.remove(env).changed).toEqual([path])
    expect(read(path)).toBe(original)
    expect(kimiInstaller.status(env)).toBe('not-installed')
  })

  test('keeps the user own hook tables and replaces a stale block', () => {
    const home = makeHome()
    const mine = '[[hooks]]\nevent = "Stop"\ncommand = "notify.sh"\n'
    const path = put(home, '.kimi-code/config.toml', `${mine}\n# >>> quirky-managed-kimi-hooks\n[[hooks]]\nevent = "Stop"\ncommand = "old"\n# <<< quirky-managed-kimi-hooks\n`)
    expect(kimiInstaller.install(target(home)).changed).toEqual([path])
    const parsed = Bun.TOML.parse(read(path)) as { hooks: { event: string; command: string }[] }
    expect(parsed.hooks).toHaveLength(8)
    expect(parsed.hooks[0]).toEqual({ event: 'Stop', command: 'notify.sh' })
    expect(read(path).match(/>>> quirky-managed-kimi-hooks/g)).toHaveLength(1)
    expect(kimiInstaller.remove(target(home)).changed).toEqual([path])
    expect(read(path)).toBe(`${mine}`)
  })

  test('creates the file when missing and deletes it on remove', () => {
    const home = makeHome()
    const env = target(home)
    const path = join(home, '.kimi-code', 'config.toml')
    expect(kimiInstaller.install(env).changed).toEqual([path])
    expect(existsSync(path)).toBe(true)
    expect(kimiInstaller.remove(env).changed).toEqual([path])
    expect(existsSync(path)).toBe(false)
    expect(kimiInstaller.remove(env).changed).toEqual([])
  })

  test('reads KIMI_CODE_HOME', () => {
    const home = makeHome()
    const custom = join(home, 'custom-kimi')
    const env = target(home, { KIMI_CODE_HOME: custom })
    expect(kimiInstaller.install(env).changed).toEqual([join(custom, 'config.toml')])
    expect(kimiInstaller.files(env)).toEqual([join(custom, 'config.toml')])
    expect(existsSync(join(home, '.kimi-code'))).toBe(false)
  })

  test('an unreadable file is reported and left alone', () => {
    const home = makeHome()
    const path = put(home, '.kimi-code/config.toml', 'this is not toml\n')
    expectError(kimiInstaller, target(home), 'Could not parse ~/.kimi-code/config.toml')
    expect(read(path)).toBe('this is not toml\n')
    expect(() => kimiInstaller.remove(target(home))).toThrow('Could not parse ~/.kimi-code/config.toml')
    put(home, '.kimi-code/config.toml', 'note = """never closed\n')
    expectError(kimiInstaller, target(home), 'Could not parse ~/.kimi-code/config.toml')
  })

  test('a hooks key that [[hooks]] tables cannot extend is reported and left alone', () => {
    const home = makeHome()
    const path = join(home, '.kimi-code', 'config.toml')
    for (const existing of ['hooks = []\n', 'hooks = [{ event = "Stop", command = "mine" }]\n', 'model = "x"\n\n[hooks]\nfoo = 1\n', 'hooks.foo = 1\n']) {
      put(home, '.kimi-code/config.toml', existing)
      expect(() => kimiInstaller.install(target(home))).toThrow(InstallError)
      expect(() => kimiInstaller.install(target(home))).toThrow('~/.kimi-code/config.toml')
      expect(read(path)).toBe(existing)
      expect(kimiInstaller.remove(target(home)).changed).toEqual([])
      expect(read(path)).toBe(existing)
    }
  })

  test('adds to the user own [[hooks]] tables', () => {
    const home = makeHome()
    const mine = '[[hooks]]\nevent = "Stop"\ncommand = "mine"\n'
    const path = put(home, '.kimi-code/config.toml', mine)
    kimiInstaller.install(target(home))
    const hooks = (Bun.TOML.parse(read(path)) as { hooks: Array<{ command: string }> }).hooks
    expect(hooks).toHaveLength(8)
    expect(hooks[0]!.command).toBe('mine')
    kimiInstaller.remove(target(home))
    expect(read(path)).toBe(mine)
  })

  test('markers inside a user string are not a region and the file is left alone', () => {
    const home = makeHome()
    const inString = 'note = """\n# >>> quirky-managed-kimi-hooks\nkeep me\n# <<< quirky-managed-kimi-hooks\n"""\n'
    const path = put(home, '.kimi-code/config.toml', inString)
    expect(() => kimiInstaller.install(target(home))).toThrow(InstallError)
    expect(read(path)).toBe(inString)
    expect(() => kimiInstaller.remove(target(home))).toThrow(InstallError)
    expect(read(path)).toBe(inString)
  })

  test('input the TOML parser rejects is reported and left alone', () => {
    const home = makeHome()
    const path = join(home, '.kimi-code', 'config.toml')
    for (const bad of ['model = "unterminated\n', 'model = 1\nmodel = 2\n', 'model = nonsense\n', '[a]\nx = 1\n[a]\ny = 2\n']) {
      put(home, '.kimi-code/config.toml', bad)
      expectError(kimiInstaller, target(home), 'Could not parse ~/.kimi-code/config.toml')
      expect(() => kimiInstaller.remove(target(home))).toThrow('Could not parse ~/.kimi-code/config.toml')
      expect(read(path)).toBe(bad)
    }
  })

  test('keeps CRLF line endings', () => {
    const home = makeHome()
    const path = put(home, '.kimi-code/config.toml', 'model = "x"\r\n')
    kimiInstaller.install(target(home))
    expect(read(path)).toContain('\r\n# >>> quirky-managed-kimi-hooks\r\n')
    expect(read(path).replaceAll('\r\n', '')).not.toContain('\n')
    kimiInstaller.remove(target(home))
    expect(read(path)).toBe('model = "x"\r\n')
  })
})

describe('jcode', () => {
  const events = ['session_start', 'turn_start', 'pre_tool', 'post_tool', 'turn_end', 'session_end']
  const original = 'model = "gpt"\n\n[ui]\nfancy = true\n'

  test('adds a hooks table of sh -c wrapped commands that tokenize back to the shim command', () => {
    const home = makeHome()
    const path = put(home, '.jcode/config.toml', original)
    const env = target(home)
    expect(jcodeInstaller.install(env).changed).toEqual([path])
    const parsed = Bun.TOML.parse(read(path)) as { ui: { fancy: boolean }; hooks: Record<string, string> }
    expect(parsed.ui.fancy).toBe(true)
    expect(Object.keys(parsed.hooks)).toEqual(events)
    for (const event of events) {
      expect(shellTokens(parsed.hooks[event]!)).toEqual(['sh', '-c', hookCommand('jcode')])
    }
    expect(jcodeInstaller.status(env)).toBe('installed')
    const text = read(path)
    expect(jcodeInstaller.install(env).changed).toEqual([])
    expect(read(path)).toBe(text)

    expect(jcodeInstaller.remove(env).changed).toEqual([path])
    expect(read(path)).toBe(original)
  })

  test('keeps a key the user owns and says so', () => {
    const home = makeHome()
    const mine = '[hooks]\nturn_start = \'notify.sh\'\npre_tool_timeout_ms = 5000 # ms\n\n[ui]\nfancy = true\n'
    const path = put(home, '.jcode/config.toml', mine)
    const env = target(home)
    const result = jcodeInstaller.install(env)
    expect(result.changed).toEqual([path])
    expect(result.message).toContain('turn_start')
    const parsed = Bun.TOML.parse(read(path)) as { hooks: Record<string, unknown> }
    expect(parsed.hooks.turn_start).toBe('notify.sh')
    expect(parsed.hooks.pre_tool_timeout_ms).toBe(5000)
    expect(Object.keys(parsed.hooks).filter((key) => events.includes(key))).toHaveLength(6)
    expect(jcodeInstaller.status(env)).toBe('not-installed')

    expect(jcodeInstaller.remove(env).changed).toEqual([path])
    expect(read(path)).toBe(mine)
  })

  test('repoints a Quirky key whose command is out of date', () => {
    const home = makeHome()
    const path = put(home, '.jcode/config.toml', `[hooks]\nsession_start = "sh -c '/old/bin/quirky-hook\\" jcode'"\n`)
    jcodeInstaller.install(target(home))
    const parsed = Bun.TOML.parse(read(path)) as { hooks: Record<string, string> }
    expect(shellTokens(parsed.hooks.session_start!)[2]).toBe(hookCommand('jcode'))
    expect(read(path).match(/session_start/g)).toHaveLength(1)
  })

  test('creates the file when missing and deletes it on remove', () => {
    const home = makeHome()
    const env = target(home)
    const path = join(home, '.jcode', 'config.toml')
    expect(jcodeInstaller.install(env).changed).toEqual([path])
    expect(read(path).startsWith('[hooks]\n')).toBe(true)
    expect(jcodeInstaller.remove(env).changed).toEqual([path])
    expect(existsSync(path)).toBe(false)
  })

  test('reads JCODE_HOME', () => {
    const home = makeHome()
    const custom = join(home, 'custom-jcode')
    const env = target(home, { JCODE_HOME: custom })
    expect(jcodeInstaller.install(env).changed).toEqual([join(custom, 'config.toml')])
  })

  test('input the TOML parser rejects is reported and left alone', () => {
    const home = makeHome()
    const path = join(home, '.jcode', 'config.toml')
    for (const bad of ['model = "unterminated\n', 'model = 1\nmodel = 2\n', 'model = nonsense\n', '[hooks]\nturn_start = "a"\nturn_start = "b"\n']) {
      put(home, '.jcode/config.toml', bad)
      expectError(jcodeInstaller, target(home), 'Could not parse ~/.jcode/config.toml')
      expect(() => jcodeInstaller.remove(target(home))).toThrow('Could not parse ~/.jcode/config.toml')
      expect(read(path)).toBe(bad)
    }
  })

  test('a file it cannot place a hooks table in is reported and left alone', () => {
    const home = makeHome()
    for (const bad of ['[hooks\nfoo\n', '[hooks]\na = "x"\n[hooks]\nb = "y"\n', 'hooks.session_start = "x"\n']) {
      const path = put(home, '.jcode/config.toml', bad)
      expectError(jcodeInstaller, target(home), 'Could not parse ~/.jcode/config.toml')
      expect(read(path)).toBe(bad)
    }
  })
})

describe('dsh', () => {
  const hooksFile = (home: string): string => join(home, '.quirky', 'agent-hooks', 'dsh-hooks.json')

  test('creates a marked entry and the Claude-shaped hooks file it points at', () => {
    const home = makeHome()
    const env = target(home)
    const patch = join(home, '.dsh', 'cordis.patch.yml')
    expect(dshInstaller.install(env).changed).toEqual([patch, hooksFile(home)])
    const text = read(patch)
    expect(text).toBe(
      [
        '# >>> quirky-managed-dsh-hooks',
        '- insert:',
        '    - id: quirky-agent-hooks',
        "      name: '@deepseek-ai/dsh-hooks-claude-code'",
        '      config:',
        `        configPath: '${hooksFile(home)}'`,
        '# <<< quirky-managed-dsh-hooks',
        ''
      ].join('\n')
    )
    expect((Bun.YAML.parse(text) as any[])[0].insert[0]).toMatchObject({ id: 'quirky-agent-hooks', config: { configPath: hooksFile(home) } })
    const hooks = JSON.parse(read(hooksFile(home))).hooks
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: hookCommand('dsh'), timeout: 10 }] }])
    expect(dshInstaller.status(env)).toBe('installed')

    expect(dshInstaller.install(env).changed).toEqual([])
    expect(dshInstaller.remove(env).changed).toEqual([patch, hooksFile(home)])
    expect(existsSync(patch)).toBe(false)
    expect(existsSync(hooksFile(home))).toBe(false)
    expect(dshInstaller.status(env)).toBe('not-installed')
  })

  test('appends after the user rows and removal restores the file', () => {
    const home = makeHome()
    const original = '# mine\n- insert:\n    - id: my-row\n      name: thing\n'
    const patch = put(home, '.dsh/cordis.patch.yml', original)
    const env = target(home)
    dshInstaller.install(env)
    const rows = Bun.YAML.parse(read(patch)) as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0].insert[0].id).toBe('my-row')
    const text = read(patch)
    expect(dshInstaller.install(env).changed).toEqual([])
    expect(read(patch)).toBe(text)
    dshInstaller.remove(env)
    expect(read(patch)).toBe(original)
  })

  test('replaces an empty flow sequence and restores it on remove', () => {
    const home = makeHome()
    const patch = put(home, '.dsh/cordis.patch.yml', '[]\n')
    const env = target(home)
    dshInstaller.install(env)
    expect(read(patch)).not.toContain('[]\n- insert')
    expect(Array.isArray(Bun.YAML.parse(read(patch)))).toBe(true)
    expect(dshInstaller.install(env).changed).toEqual([])
    dshInstaller.remove(env)
    expect(read(patch)).toBe('[]\n')
  })

  test('reads DSH_HOME', () => {
    const home = makeHome()
    const custom = join(home, 'custom-dsh')
    const env = target(home, { DSH_HOME: custom })
    expect(dshInstaller.install(env).changed[0]).toBe(join(custom, 'cordis.patch.yml'))
  })

  test('a patch file it cannot append to is reported and left alone', () => {
    const home = makeHome()
    for (const bad of ['[a, b]\n', 'theme: dark\n']) {
      const patch = put(home, '.dsh/cordis.patch.yml', bad)
      expectError(dshInstaller, target(home), 'Could not parse ~/.dsh/cordis.patch.yml')
      expect(read(patch)).toBe(bad)
      expect(existsSync(hooksFile(home))).toBe(false)
    }
  })
})

describe('hermes', () => {
  const pluginDir = (home: string): string => join(home, '.hermes', 'plugins', 'quirky-status')

  test('writes the plugin and enables it in a new config, and removal deletes everything', () => {
    const home = makeHome()
    const env = target(home)
    const config = join(home, '.hermes', 'config.yaml')
    const changed = hermesInstaller.install(env).changed
    expect(changed).toEqual([join(pluginDir(home), 'plugin.yaml'), join(pluginDir(home), '__init__.py'), config])
    expect(read(join(pluginDir(home), 'plugin.yaml'))).toBe(hermesManifest())
    expect(read(join(pluginDir(home), '__init__.py'))).toBe(hermesInitSource())
    expect(Bun.YAML.parse(read(join(pluginDir(home), 'plugin.yaml')))).toMatchObject({ name: 'quirky-status', kind: 'standalone' })
    expect((Bun.YAML.parse(read(config)) as any).plugins.enabled).toEqual(['quirky-status'])
    expect(hermesInstaller.status(env)).toBe('installed')

    expect(hermesInstaller.install(env).changed).toEqual([])
    expect(hermesInstaller.remove(env).changed.sort()).toEqual(changed.sort())
    expect(tree(home)).toEqual({})
    expect(existsSync(pluginDir(home))).toBe(false)
    expect(hermesInstaller.status(env)).toBe('not-installed')
  })

  test('adds to a block list, leaves the disabled list, and restores the file', () => {
    const home = makeHome()
    const original = 'model: sonnet\nplugins:\n  enabled:\n    - other # keep\n  disabled:\n    - quirky-status\n    - noisy\ndisplay:\n  compact: true\n'
    const config = put(home, '.hermes/config.yaml', original)
    const env = target(home)
    hermesInstaller.install(env)
    const parsed = Bun.YAML.parse(read(config)) as any
    expect(parsed.plugins.enabled).toEqual(['other', 'quirky-status'])
    expect(parsed.plugins.disabled).toEqual(['noisy'])
    expect(parsed.model).toBe('sonnet')
    expect(parsed.display).toEqual({ compact: true })
    expect(hermesInstaller.status(env)).toBe('installed')
    const text = read(config)
    expect(hermesInstaller.install(env).changed).toEqual([])
    expect(read(config)).toBe(text)

    hermesInstaller.remove(env)
    expect(read(config)).toBe(original)
  })

  test('edits one-line flow lists and an empty plugins mapping', () => {
    const home = makeHome()
    const flow = 'plugins:\n  enabled: [a, "b"]\n  disabled: [quirky-status, c]\n'
    const config = put(home, '.hermes/config.yaml', flow)
    hermesInstaller.install(target(home))
    const parsed = Bun.YAML.parse(read(config)) as any
    expect(parsed.plugins.enabled).toEqual(['a', 'b', 'quirky-status'])
    expect(parsed.plugins.disabled).toEqual(['c'])
    hermesInstaller.remove(target(home))
    expect(read(config)).toBe(flow)

    for (const empty of ['plugins: {}\nmodel: x\n', 'plugins:\nmodel: x\n', 'plugins:\n  enabled:\nmodel: x\n']) {
      writeFileSync(config, empty)
      hermesInstaller.install(target(home))
      expect((Bun.YAML.parse(read(config)) as any).plugins.enabled).toEqual(['quirky-status'])
      expect((Bun.YAML.parse(read(config)) as any).model).toBe('x')
      hermesInstaller.remove(target(home))
      expect(read(config)).toBe(empty)
    }
  })

  test('adds a plugins mapping to a config without one', () => {
    const home = makeHome()
    const original = 'model: sonnet\n'
    const config = put(home, '.hermes/config.yaml', original)
    hermesInstaller.install(target(home))
    expect(Bun.YAML.parse(read(config))).toEqual({ model: 'sonnet', plugins: { enabled: ['quirky-status'] } })
    hermesInstaller.remove(target(home))
    expect(read(config)).toBe(original)
  })

  test('leaves an entry the user already had', () => {
    const home = makeHome()
    const original = 'plugins:\n  enabled:\n    - quirky-status\n'
    const config = put(home, '.hermes/config.yaml', original)
    expect(hermesInstaller.install(target(home)).changed).toEqual([
      join(pluginDir(home), 'plugin.yaml'),
      join(pluginDir(home), '__init__.py')
    ])
    expect(read(config)).toBe(original)
    hermesInstaller.remove(target(home))
    expect(read(config)).toBe(original)
  })

  test('keeps user entries added under a block Quirky created', () => {
    const home = makeHome()
    const config = join(home, '.hermes', 'config.yaml')
    hermesInstaller.install(target(home))
    writeFileSync(config, read(config).replace('    - quirky-status', '    - mine\n    - quirky-status'))
    hermesInstaller.remove(target(home))
    expect(Bun.YAML.parse(read(config))).toEqual({ plugins: { enabled: ['mine'] } })
  })

  test('reads HERMES_HOME', () => {
    const home = makeHome()
    const custom = join(home, 'custom-hermes')
    const env = target(home, { HERMES_HOME: custom })
    hermesInstaller.install(env)
    expect(existsSync(join(custom, 'plugins', 'quirky-status', '__init__.py'))).toBe(true)
    expect(existsSync(join(custom, 'config.yaml'))).toBe(true)
    expect(existsSync(join(home, '.hermes'))).toBe(false)
  })

  test('a config layout it cannot edit is reported, with nothing written', () => {
    const home = makeHome()
    for (const bad of ['plugins: [broken\n', 'plugins: yes please\n', 'just some words\n', 'plugins:\n  enabled: mine\n']) {
      const config = put(home, '.hermes/config.yaml', bad)
      expectError(hermesInstaller, target(home), 'Could not parse ~/.hermes/config.yaml')
      expect(read(config)).toBe(bad)
      expect(existsSync(pluginDir(home))).toBe(false)
    }
  })

  test('quoted names in a flow list keep their exact text and meaning', () => {
    const home = makeHome()
    const original = `plugins:\n  enabled: ["a,b", "true", 'null', "x # y"] # mine\n  disabled: ["c,d", quirky-status, "7"]\n`
    const config = put(home, '.hermes/config.yaml', original)
    const env = target(home)
    hermesInstaller.install(env)
    const parsed = Bun.YAML.parse(read(config)) as any
    expect(parsed.plugins.enabled).toEqual(['a,b', 'true', 'null', 'x # y', 'quirky-status'])
    expect(parsed.plugins.disabled).toEqual(['c,d', '7'])
    expect(read(config)).toContain(`["a,b", "true", 'null', "x # y", quirky-status]`)
    expect(read(config)).toContain(`["c,d", "7"]`)
    expect(hermesInstaller.status(env)).toBe('installed')
    hermesInstaller.remove(env)
    expect(read(config)).toBe(original)
  })

  test('a quoted plugins key is edited in place, not shadowed by a second mapping', () => {
    const home = makeHome()
    for (const original of [
      '"plugins":\n  enabled: [other]\n',
      "'plugins':\n  enabled:\n    - other\n",
      'plugins:\n  "enabled":\n    - other\n  \'disabled\': [quirky-status, x]\n'
    ]) {
      const config = put(home, '.hermes/config.yaml', original)
      hermesInstaller.install(target(home))
      const text = read(config)
      expect(text.match(/plugins/g)).toHaveLength(1)
      const parsed = Bun.YAML.parse(text) as any
      expect(parsed.plugins.enabled).toEqual(['other', 'quirky-status'])
      expect(hermesInstaller.status(target(home))).toBe('installed')
      hermesInstaller.remove(target(home))
      expect(read(config)).toBe(original)
    }
  })

  test('malformed YAML is reported and left untouched, never edited', () => {
    const home = makeHome()
    for (const bad of ['model: [broken\n', 'model: "unterminated\nother: 1\n', 'a: b: c\n', 'model: x\n  stray: 1\n', 'a: 1\n---\nb: 2\n']) {
      const config = put(home, '.hermes/config.yaml', bad)
      expectError(hermesInstaller, target(home), 'Could not parse ~/.hermes/config.yaml')
      expect(read(config)).toBe(bad)
      expect(existsSync(pluginDir(home))).toBe(false)
    }
  })

  test('a plugin directory the user wrote is never overwritten', () => {
    const home = makeHome()
    const mine = put(home, '.hermes/plugins/quirky-status/__init__.py', '# mine\n')
    const config = put(home, '.hermes/config.yaml', 'model: x\n')
    expect(() => hermesInstaller.install(target(home))).toThrow('~/.hermes/plugins/quirky-status/__init__.py exists and was not written by Quirky')
    expect(read(mine)).toBe('# mine\n')
    expect(read(config)).toBe('model: x\n')
    expect(existsSync(join(pluginDir(home), 'plugin.yaml'))).toBe(false)
    hermesInstaller.remove(target(home))
    expect(read(mine)).toBe('# mine\n')
  })
})

describe('plugin files', () => {
  type Case = {
    installer: Installer
    path: (home: string) => string
    content: string
    env?: (home: string) => Record<string, string>
    envPath?: (home: string) => string
  }

  const cases: Case[] = [
    {
      installer: ampInstaller,
      path: (home) => join(home, '.config/amp/plugins/quirky-agent-status.ts'),
      content: ampPluginSource(),
      env: (home) => ({ XDG_CONFIG_HOME: join(home, 'xdg') }),
      envPath: (home) => join(home, 'xdg/amp/plugins/quirky-agent-status.ts')
    },
    {
      installer: opencodeInstaller,
      path: (home) => join(home, '.config/opencode/plugins/quirky-opencode-status.js'),
      content: openCodePluginSource('opencode'),
      env: (home) => ({ OPENCODE_CONFIG_DIR: join(home, 'oc') }),
      envPath: (home) => join(home, 'oc/plugins/quirky-opencode-status.js')
    },
    {
      installer: opencode2Installer,
      path: (home) => join(home, '.config/opencode/plugins/quirky-opencode2-status.js'),
      content: openCodePluginSource('opencode2'),
      env: (home) => ({ XDG_CONFIG_HOME: join(home, 'xdg') }),
      envPath: (home) => join(home, 'xdg/opencode/plugins/quirky-opencode2-status.js')
    },
    {
      installer: mimoCodeInstaller,
      path: (home) => join(home, '.config/mimocode/plugins/quirky-mimo-code-status.js'),
      content: openCodePluginSource('mimo-code'),
      env: (home) => ({ MIMOCODE_HOME: join(home, 'mimo') }),
      envPath: (home) => join(home, 'mimo/config/plugins/quirky-mimo-code-status.js')
    },
    {
      installer: piInstaller,
      path: (home) => join(home, '.pi/agent/extensions/quirky-agent-status.ts'),
      content: piExtensionSource('pi'),
      env: (home) => ({ PI_CODING_AGENT_DIR: join(home, 'pidir') }),
      envPath: (home) => join(home, 'pidir/extensions/quirky-agent-status.ts')
    },
    {
      installer: ompInstaller,
      path: (home) => join(home, '.omp/agent/extensions/quirky-agent-status.ts'),
      content: piExtensionSource('omp'),
      env: (home) => ({ PI_CODING_AGENT_DIR: join(home, 'ompdir') }),
      envPath: (home) => join(home, 'ompdir/extensions/quirky-agent-status.ts')
    },
    {
      installer: primeAgentInstaller,
      path: (home) => join(home, '.prime/agent/extensions/quirky-agent-status.ts'),
      content: piExtensionSource('prime-agent'),
      env: (home) => ({ PRIME_AGENT_CODING_AGENT_DIR: join(home, 'primedir') }),
      envPath: (home) => join(home, 'primedir/extensions/quirky-agent-status.ts')
    }
  ]

  for (const { installer, path, content, env, envPath } of cases) {
    describe(installer.agent, () => {
      test('writes the generated source once, reruns unchanged, and removal deletes it', () => {
        const home = makeHome()
        const keep = put(home, 'unrelated.txt', 'mine')
        const before = tree(home)
        const e = target(home)
        expect(installer.files(e)).toEqual([path(home)])
        expect(installer.status(e)).toBe('not-installed')
        expect(installer.install(e).changed).toEqual([path(home)])
        expect(read(path(home))).toBe(content)
        expect(read(path(home)).split('\n')[0]).toBe('// Managed by Quirky. Do not edit; changes may be overwritten.')
        expect(installer.status(e)).toBe('installed')

        const mtime = statSync(path(home)).mtimeMs
        expect(installer.install(e).changed).toEqual([])
        expect(statSync(path(home)).mtimeMs).toBe(mtime)

        expect(installer.remove(e).changed).toEqual([path(home)])
        expect(tree(home)).toEqual(before)
        expect(read(keep)).toBe('mine')
        expect(installer.remove(e).changed).toEqual([])
      })

      test('rewrites a stale file Quirky wrote', () => {
        const home = makeHome()
        put(home, path(home).slice(home.length + 1), '// Managed by Quirky. Do not edit; changes may be overwritten.\nold\n')
        expect(installer.status(target(home))).toBe('not-installed')
        expect(installer.install(target(home)).changed).toEqual([path(home)])
        expect(read(path(home))).toBe(content)
      })

      test('never overwrites or removes a file the user wrote at that path', () => {
        const home = makeHome()
        const file = put(home, path(home).slice(home.length + 1), 'export default function () {}\n')
        const message = `${path(home).replace(home, '~')} exists and was not written by Quirky`
        expectError(installer, target(home), message)
        expect(installer.remove(target(home)).changed).toEqual([])
        expect(read(file)).toBe('export default function () {}\n')
      })

      test('honors its home override', () => {
        const home = makeHome()
        const e = target(home, env!(home))
        expect(installer.install(e).changed).toEqual([envPath!(home)])
        expect(installer.files(e)).toEqual([envPath!(home)])
        expect(existsSync(path(home))).toBe(false)
        expect(installer.remove(e).changed).toEqual([envPath!(home)])
      })
    })
  }

  test('a relative override is ignored', () => {
    const home = makeHome()
    const e = target(home, { OPENCODE_CONFIG_DIR: 'relative/dir', XDG_CONFIG_HOME: 'also/relative' })
    expect(opencodeInstaller.files(e)).toEqual([join(home, '.config/opencode/plugins/quirky-opencode-status.js')])
  })

  test('OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME for the OpenCode family only', () => {
    const home = makeHome()
    const e = target(home, { OPENCODE_CONFIG_DIR: join(home, 'oc'), XDG_CONFIG_HOME: join(home, 'xdg') })
    expect(opencodeInstaller.files(e)).toEqual([join(home, 'oc/plugins/quirky-opencode-status.js')])
    expect(opencode2Installer.files(e)).toEqual([join(home, 'oc/plugins/quirky-opencode2-status.js')])
    expect(mimoCodeInstaller.files(e)).toEqual([join(home, 'xdg/mimocode/plugins/quirky-mimo-code-status.js')])
  })

  test('pi and omp share one file when PI_CODING_AGENT_DIR is set, so either installs it for both', () => {
    const home = makeHome()
    const e = target(home, { PI_CODING_AGENT_DIR: join(home, 'shared') })
    expect(piInstaller.files(e)).toEqual(ompInstaller.files(e))
    expect(piInstaller.install(e).changed).toHaveLength(1)
    expect(ompInstaller.status(e)).toBe('installed')
    expect(ompInstaller.install(e).changed).toEqual([])
  })
})
