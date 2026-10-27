import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cliJson, installAgents, newSession, startOf, startStatusE2E, waitFor, type StatusE2E } from './support'

type Setup = { agent: string; status: string; changed: string[]; note?: string; message?: string }
type Removal = { agent: string; changed: string[]; message?: string }
type Status = { agent: string; status: string; files: string[]; message?: string }

const STATUSES = ['installed', 'not-installed', 'agent_disabled', 'cli_not_found', 'hooks_disabled', 'error']
const HOOKS_SETTING = 'setting:quirky.agent-status/hooks'
const CODEX_REVIEW_NOTE = 'Codex asks you to review these hooks once (/hooks)'

let e2e: StatusE2E | undefined
afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

const run = (...args: string[]) => e2e!.cli(['agent-status', 'hooks', ...args])
const statusOf = () => cliJson<Status[]>(e2e!, ['agent-status', 'hooks', 'status'])
const lines = (stdout: string) => stdout.split('\n').filter(Boolean)
const changedLines = (stdout: string) => lines(stdout).filter((line) => line.startsWith('changed '))
const sorted = (...events: string[]) => [...events].sort()
const json = (text: string | null) => JSON.parse(text ?? 'null') as unknown

/** Every file under the temporary HOME (but not the runtime's own cache) and Quirky's hook helper files, by path. */
function snapshot(root: StatusE2E): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (path !== join(root.userHome, 'Library') && path !== join(root.userHome, '.bun')) walk(path)
      } else files.set(path.replace(root.userHome, '~'), readFileSync(path, 'utf8'))
    }
  }
  walk(root.userHome)
  walk(join(root.home, 'agent-hooks'))
  return files
}

/** Hook command strings written by Quirky in a JSON value, keyed by the name of the event array that holds them. */
function quirkyEvents(value: unknown): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  const strings = (node: unknown): string[] =>
    typeof node === 'string' ? [node] : node && typeof node === 'object' ? Object.values(node).flatMap(strings) : []
  const walk = (node: unknown, key: string) => {
    if (Array.isArray(node)) {
      const ours = strings(node).filter((text) => text.includes('/bin/quirky-hook'))
      if (ours.length > 0) found[key] = ours
    } else if (node && typeof node === 'object') {
      for (const [name, child] of Object.entries(node)) walk(child, name)
    }
  }
  walk(value, '')
  return found
}

/** The events Quirky registered in a JSON hooks file; every command must name its source and exit 0 quietly when the shim is gone. */
function registered(text: string | null, source: string): string[] {
  const events = quirkyEvents(json(text))
  for (const commands of Object.values(events)) {
    for (const command of commands) {
      expect(command).toContain('[ -x "${QUIRKY_HOME-}/bin/quirky-hook" ]')
      expect(command).toContain(`"$QUIRKY_HOME/bin/quirky-hook" ${source}; exit 0`)
    }
  }
  return Object.keys(events).sort()
}

const QODER_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'Notification', 'PostCompact']

describe('SC-24: setting up one agent is safe to rerun', () => {
  test(
    'setup twice then remove leaves the theme and the user hook, and the second run changes nothing',
    async () => {
      e2e = await startStatusE2E()
      const original = { theme: 'dark', hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: '/home/me/notify.sh' }] }] } }
      e2e.put('.gemini/settings.json', original)
      await installAgents(e2e, ['gemini'])

      const first = await run('setup', 'gemini')
      expect(first.code).toBe(0)
      expect(lines(first.stdout)).toEqual(['changed ~/.gemini/settings.json', 'gemini: installed'])
      const installed = e2e.read('.gemini/settings.json')
      const settings = json(installed) as typeof original & { hooks: Record<string, unknown[]> }
      expect(settings.theme).toBe('dark')
      expect(Object.keys(settings.hooks).sort()).toEqual(sorted('AfterAgent', 'BeforeAgent', 'BeforeTool', 'AfterTool'))
      expect(registered(installed, 'gemini')).toEqual(sorted('BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'))
      expect(settings.hooks.AfterAgent![0]).toEqual(original.hooks.AfterAgent[0]!)

      const second = await run('setup', 'gemini')
      expect(second.code).toBe(0)
      expect(lines(second.stdout)).toEqual(['gemini: installed'])
      expect(e2e.read('.gemini/settings.json')).toBe(installed)

      const removed = await run('remove', 'gemini')
      expect(removed.code).toBe(0)
      expect(lines(removed.stdout)).toEqual(['changed ~/.gemini/settings.json', 'gemini: removed'])
      expect(json(e2e.read('.gemini/settings.json'))).toEqual(original)
    },
    60_000
  )
})

describe('SC-25: every agent installer writes its file and events', () => {
  test(
    'setup writes each agent, a second run changes nothing, and remove keeps only the files the user had',
    async () => {
      e2e = await startStatusE2E()
      const agents = (await statusOf()).map((entry) => entry.agent)
      expect(agents).toHaveLength(28)
      await installAgents(e2e, agents)
      e2e.put('.kiro/agents/mine.json', { name: 'mine' })
      const userCodexHook = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/home/me/codex-stop.sh' }] }] } }
      e2e.put('.codex/hooks.json', userCodexHook)
      const preexisting = new Set(snapshot(e2e).keys())

      const setup = await cliJson<Setup[]>(e2e, ['agent-status', 'hooks', 'setup'])
      expect(setup.map((entry) => [entry.agent, entry.status])).toEqual(agents.map((agent) => [agent, 'installed']))
      expect(setup.find((entry) => entry.agent === 'codex')?.note).toBe(CODEX_REVIEW_NOTE)
      for (const entry of await statusOf()) {
        expect(entry.files.length, entry.agent).toBeGreaterThan(0)
        for (const path of entry.files) expect(existsSync(path), `${entry.agent}: ${path}`).toBe(true)
      }

      expect(registered(e2e.read('.openclaude/settings.json'), 'openclaude')).toEqual(
        sorted('SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PostCompact')
      )
      expect(registered(e2e.read('.qoder/settings.json'), 'qoder')).toEqual(sorted(...QODER_EVENTS))
      expect(registered(e2e.read('.qwen/settings.json'), 'qwen-code')).toEqual(
        sorted(...QODER_EVENTS.filter((event) => event !== 'PostCompact'), 'SubagentStart', 'SubagentStop')
      )
      expect(registered(e2e.read('.factory/settings.json'), 'droid')).toEqual(
        sorted('SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification')
      )
      expect(registered(e2e.read('.gemini/settings.json'), 'gemini')).toEqual(sorted('BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'))
      expect(registered(e2e.read('.gemini/config/hooks.json'), 'antigravity')).toEqual(
        sorted('PreInvocation', 'PostInvocation', 'Stop', 'PreToolUse', 'PostToolUse')
      )

      const codex = e2e.read('.codex/hooks.json')
      expect(registered(codex, 'codex')).toEqual(
        sorted('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt')
      )
      expect(JSON.stringify(json(codex))).toContain('/home/me/codex-stop.sh')

      // cursor and copilot name the event in the command so the shim can answer it
      const cursor = e2e.read('.cursor/hooks.json')
      expect(registered(cursor, 'cursor')).toEqual(
        sorted('beforeSubmitPrompt', 'stop', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'beforeShellExecution', 'beforeMCPExecution', 'afterAgentResponse')
      )
      expect(cursor).toContain('QUIRKY_HOOK_EVENT=beforeShellExecution')
      expect(registered(e2e.read('.grok/hooks/quirky-status.json'), 'grok')).toEqual(
        sorted('SessionStart', 'UserPromptSubmit', 'Stop', 'StopCancelled', 'StopFailure', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification')
      )
      const copilot = e2e.read('.copilot/hooks/quirky.json')
      expect(registered(copilot, 'copilot')).toEqual(
        sorted('SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'subagentStart', 'SubagentStop', 'PreCompact', 'Stop', 'ErrorOccurred', 'PermissionRequest', 'Notification')
      )
      expect(copilot).toContain('QUIRKY_HOOK_EVENT=ErrorOccurred')
      expect(registered(e2e.read('.kiro/agents/mine.json'), 'kiro')).toEqual(sorted('agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'))
      expect(json(e2e.read('.kiro/agents/mine.json'))).toMatchObject({ name: 'mine' })

      const kimi = e2e.read('.kimi-code/config.toml')!
      expect(kimi).toContain('# >>> quirky-managed-kimi-hooks')
      expect([...kimi.matchAll(/^event = "(\w+)"/gm)].map((match) => match[1]!).sort()).toEqual(
        sorted('UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure')
      )
      const jcode = e2e.read('.jcode/config.toml')!
      for (const key of ['session_start', 'turn_start', 'pre_tool', 'post_tool', 'turn_end', 'session_end']) {
        expect(jcode, key).toMatch(new RegExp(`^${key} = ".*quirky-hook\\\\" jcode; exit 0`, 'm'))
      }

      const dsh = e2e.read('.dsh/cordis.patch.yml')!
      expect(dsh).toContain('# >>> quirky-managed-dsh-hooks')
      expect(dsh).toContain(join(e2e.home, 'agent-hooks', 'dsh-hooks.json'))
      expect(readFileSync(join(e2e.home, 'agent-hooks', 'dsh-hooks.json'), 'utf8')).toContain('quirky-hook')
      expect(e2e.read('.hermes/config.yaml')).toContain('- quirky-status')
      const hermes = e2e.read('.hermes/plugins/quirky-status/__init__.py')!
      for (const event of ['on_session_start', 'pre_llm_call', 'post_llm_call', 'pre_tool_call', 'post_tool_call', 'pre_approval_request', 'post_approval_response', 'on_session_end', 'on_session_finalize', 'on_session_reset']) {
        expect(hermes, event).toContain(event)
      }

      const amp = e2e.read('.config/amp/plugins/quirky-agent-status.ts')!
      for (const event of ['session.start', 'agent.start', 'tool.call', 'tool.result', 'agent.end']) expect(amp, event).toContain(event)
      expect(e2e.read('.config/opencode/plugins/quirky-opencode-status.js')).toContain("const QUIRKY_AGENT = 'opencode'")
      expect(e2e.read('.config/opencode/plugins/quirky-opencode2-status.js')).toContain("const QUIRKY_AGENT = 'opencode2'")
      expect(e2e.read('.config/mimocode/plugins/quirky-mimo-code-status.js')).toContain("const QUIRKY_AGENT = 'mimo-code'")
      for (const dir of ['.pi/agent/extensions', '.omp/agent/extensions', '.prime/agent/extensions']) {
        expect(e2e.read(`${dir}/quirky-agent-status.ts`), dir).toContain('Managed by Quirky')
      }

      const written = snapshot(e2e)
      const again = await run('setup')
      expect(again.code).toBe(0)
      expect(changedLines(again.stdout)).toEqual([])
      expect(snapshot(e2e)).toEqual(written)

      const removed = await cliJson<Removal[]>(e2e, ['agent-status', 'hooks', 'remove'])
      expect(removed.map((entry) => entry.agent)).toEqual(agents)
      expect(removed.filter((entry) => entry.message !== undefined)).toEqual([])
      const left = snapshot(e2e)
      for (const path of written.keys()) expect(left.has(path), path).toBe(preexisting.has(path))
      expect(json(e2e.read('.kiro/agents/mine.json'))).toEqual({ name: 'mine' })
      expect(json(e2e.read('.codex/hooks.json'))).toEqual(userCodexHook)
      expect((await statusOf()).every((entry) => entry.status === 'not-installed')).toBe(true)
    },
    60_000
  )
})

describe('SC-26: what setup says about agents it skips and a config it cannot read', () => {
  test(
    'gemini is agent_disabled, cursor cli_not_found, droid an error with its file untouched, and the command exits 0',
    async () => {
      e2e = await startStatusE2E()
      const unparseable = '{ "hooks": [ not json'
      e2e.put('.factory/settings.json', unparseable)
      await installAgents(e2e, ['gemini', 'droid'])
      expect((await e2e.cli(['agents', 'disable', 'gemini'])).code).toBe(0)

      const setup = await run('setup')
      expect(setup.code).toBe(0)
      const printed = lines(setup.stdout)
      expect(printed).toContain('gemini: agent_disabled')
      expect(printed).toContain('cursor: cli_not_found')
      expect(printed).toContain('droid: error — Could not parse ~/.factory/settings.json')
      expect(changedLines(setup.stdout)).toEqual([])
      expect(e2e.read('.factory/settings.json')).toBe(unparseable)
      expect(e2e.read('.gemini/settings.json')).toBeNull()
      expect(e2e.read('.cursor/hooks.json')).toBeNull()

      const status = await run('status')
      expect(status.code).toBe(0)
      expect(lines(status.stdout)).toContain('gemini: agent_disabled')
      expect(lines(status.stdout)).toContain('droid: error — Could not parse ~/.factory/settings.json')
      const entries = await statusOf()
      expect(entries).toHaveLength(28)
      for (const entry of entries) expect(STATUSES, entry.agent).toContain(entry.status)
      expect(entries.find((entry) => entry.agent === 'cursor')?.status).toBe('cli_not_found')
    },
    60_000
  )
})

describe('SC-27: the Agent status hooks switch', () => {
  test(
    'off removes the entries, a restart does nothing, setup refuses while off, and on installs again',
    async () => {
      e2e = await startStatusE2E()
      await installAgents(e2e, ['gemini', 'cursor'])
      expect((await run('setup')).code).toBe(0)
      const states = async () => Object.fromEntries((await statusOf()).filter((entry) => ['gemini', 'cursor'].includes(entry.agent)).map((entry) => [entry.agent, entry.status]))
      expect(await states()).toEqual({ gemini: 'installed', cursor: 'installed' })
      expect(e2e.read('.gemini/settings.json')).not.toBeNull()
      expect(e2e.read('.cursor/hooks.json')).not.toBeNull()

      const off = await e2e.cli(['setting', 'set', HOOKS_SETTING, 'false'])
      expect(off.code).toBe(0)
      await waitFor(async () => e2e!.read('.gemini/settings.json') === null && e2e!.read('.cursor/hooks.json') === null, 10_000, 'the entries to be removed')
      expect((await statusOf()).every((entry) => entry.status === 'hooks_disabled')).toBe(true)

      // a file written while the switch is off is the user's; the restart must neither touch it nor add Quirky's entries
      const userSettings = JSON.stringify({ theme: 'light' })
      e2e.put('.gemini/settings.json', userSettings)
      await e2e.restartDaemon()
      expect(e2e.read('.gemini/settings.json')).toBe(userSettings)
      expect(e2e.read('.cursor/hooks.json')).toBeNull()
      expect((await statusOf()).every((entry) => entry.status === 'hooks_disabled')).toBe(true)

      const refused = await run('setup')
      expect(refused.code).not.toBe(0)
      expect(refused.stderr).toContain('Agent status hooks are turned off')
      expect(e2e.read('.cursor/hooks.json')).toBeNull()

      expect((await e2e.cli(['setting', 'set', HOOKS_SETTING, 'true'])).code).toBe(0)
      await waitFor(async () => {
        const now = await states()
        return now.gemini === 'installed' && now.cursor === 'installed'
      }, 10_000, 'gemini and cursor to be installed again')
      expect(json(e2e.read('.gemini/settings.json'))).toMatchObject({ theme: 'light' })
      expect(registered(e2e.read('.gemini/settings.json'), 'gemini')).toEqual(sorted('BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'))
      expect(registered(e2e.read('.cursor/hooks.json'), 'cursor')).toHaveLength(8)
    },
    90_000
  )
})

describe('SC-29: Codex setup asks for review and keeps the notify hook', () => {
  test(
    'setup prints the hooks file and the review note, and a codex launch still carries notify',
    async () => {
      e2e = await startStatusE2E()
      await installAgents(e2e, ['codex'])

      const setup = await run('setup', 'codex')
      expect(setup.code).toBe(0)
      expect(lines(setup.stdout)).toEqual(['changed ~/.codex/hooks.json', `codex: installed — ${CODEX_REVIEW_NOTE}`])
      expect(e2e.read('.codex/hooks.json')).not.toBeNull()

      const session = await newSession(e2e, 'codex')
      const started = await startOf(e2e, 'codex', session.id)
      const notify = started.argv.find((arg) => arg.startsWith('notify='))
      expect(notify).toBe(`notify=${JSON.stringify([join(e2e.home, 'bin', 'quirky-hook'), 'codex'])}`)
      expect(started.argv[started.argv.indexOf(notify!) - 1]).toBe('-c')
    },
    60_000
  )
})
