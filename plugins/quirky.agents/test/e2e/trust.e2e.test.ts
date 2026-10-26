import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Session } from '@quirky/protocol'
import { startAgentsE2E, type E2E, type FakeEvent } from '../support/e2e'

type Start = Extract<FakeEvent, { type: 'start' }>

const TRUST_SETTING = 'setting:quirky.agents/workspace-trust'

/** The agents that pre-write a trust record, by catalog ID, with the command each one runs. */
const AGENTS = [
  { id: 'claude', fake: 'claude' },
  { id: 'cursor', fake: 'cursor-agent' },
  { id: 'copilot', fake: 'copilot' },
  { id: 'codex', fake: 'codex' }
]

let e2e: E2E
beforeEach(async () => {
  e2e = await startAgentsE2E({ fakes: Object.fromEntries(AGENTS.map((agent) => [agent.fake, true as const])) })
}, 30_000)
afterEach(() => e2e.cleanup())

/** The files a user would already have, with keys Quirky must leave alone. */
const SEEDED = {
  claude: () => join(e2e.userHome, '.claude.json'),
  copilot: () => join(e2e.userHome, '.copilot', 'config.json'),
  codex: () => join(e2e.userHome, '.codex', 'config.toml'),
  cursorMarker: () => join(e2e.userHome, '.cursor', 'projects', e2e.repo.replace(/^\/+/, '').replace(/[\\/:*?"<>|]+/g, '-'), '.workspace-trusted')
}

const CLAUDE_BEFORE = { theme: 'dark', projects: { '/elsewhere': { allowedTools: ['Bash'] } } }
const COPILOT_BEFORE = { banner: 'never', trustedFolders: ['/elsewhere'] }
const CODEX_BEFORE = 'model = "gpt-5"\n\n[projects."/elsewhere"]\ntrust_level = "trusted"\n'

function seedHome(): void {
  writeFileSync(SEEDED.claude(), `${JSON.stringify(CLAUDE_BEFORE, null, 2)}\n`)
  mkdirSync(dirname(SEEDED.copilot()), { recursive: true })
  writeFileSync(SEEDED.copilot(), `${JSON.stringify(COPILOT_BEFORE, null, 2)}\n`)
  mkdirSync(dirname(SEEDED.codex()), { recursive: true })
  writeFileSync(SEEDED.codex(), CODEX_BEFORE)
}

async function startAgent(agent: (typeof AGENTS)[number]): Promise<Start> {
  const created = await e2e.cli(['session', 'new', '--agent', agent.id, '--json'])
  expect(created.code).toBe(0)
  const session = JSON.parse(created.stdout) as Session
  const events = await e2e.waitForFakeLog(
    agent.fake,
    (log) => log.some((event) => event.type === 'start' && event.env.QUIRKY_SESSION_ID === session.id),
    15_000
  )
  return events.find((event): event is Start => event.type === 'start' && event.env.QUIRKY_SESSION_ID === session.id)!
}

const modifiedAt = (path: string) => statSync(path).mtimeMs
const daemonLog = () => readFileSync(join(dirname(e2e.home), 'daemon.log'), 'utf8')

describe('SC-36: trust records are pre-written before the agent starts', () => {
  test(
    'SC-36: with workspace trust on, each agent has its folder recorded before its fake ran, and other keys are kept',
    async () => {
      seedHome()
      const started: Record<string, Start> = {}
      for (const agent of AGENTS) started[agent.id] = await startAgent(agent)

      const claude = JSON.parse(readFileSync(SEEDED.claude(), 'utf8'))
      expect(claude.projects[e2e.repo].hasTrustDialogAccepted).toBe(true)
      expect(claude.theme).toBe('dark')
      expect(claude.projects['/elsewhere']).toEqual({ allowedTools: ['Bash'] })
      expect(modifiedAt(SEEDED.claude())).toBeLessThanOrEqual(started.claude!.at)

      expect(existsSync(SEEDED.cursorMarker())).toBe(true)
      expect(modifiedAt(SEEDED.cursorMarker())).toBeLessThanOrEqual(started.cursor!.at)

      const copilot = JSON.parse(readFileSync(SEEDED.copilot(), 'utf8'))
      expect(copilot.trustedFolders).toEqual(['/elsewhere', e2e.repo])
      expect(copilot.banner).toBe('never')
      expect(modifiedAt(SEEDED.copilot())).toBeLessThanOrEqual(started.copilot!.at)

      const codex = readFileSync(SEEDED.codex(), 'utf8')
      expect(codex.startsWith(CODEX_BEFORE)).toBe(true)
      expect(codex).toContain(`[projects."${e2e.repo}"]\ntrust_level = "trusted"`)
      expect(modifiedAt(SEEDED.codex())).toBeLessThanOrEqual(started.codex!.at)
    },
    60_000
  )

  test(
    'SC-36: with the setting off, none of the records change',
    async () => {
      seedHome()
      const before = {
        claude: readFileSync(SEEDED.claude(), 'utf8'),
        copilot: readFileSync(SEEDED.copilot(), 'utf8'),
        codex: readFileSync(SEEDED.codex(), 'utf8')
      }
      const off = await e2e.cli(['setting', 'set', TRUST_SETTING, 'false'])
      expect(off.code).toBe(0)

      for (const agent of AGENTS) await startAgent(agent)

      expect(readFileSync(SEEDED.claude(), 'utf8')).toBe(before.claude)
      expect(readFileSync(SEEDED.copilot(), 'utf8')).toBe(before.copilot)
      expect(readFileSync(SEEDED.codex(), 'utf8')).toBe(before.codex)
      expect(existsSync(SEEDED.cursorMarker())).toBe(false)
      expect(existsSync(join(e2e.userHome, '.cursor'))).toBe(false)
    },
    60_000
  )

  test(
    'SC-36: an unwritable $HOME/.claude.json is logged and the session still starts',
    async () => {
      mkdirSync(SEEDED.claude())
      const claude = AGENTS.find((agent) => agent.id === 'claude')!
      const started = await startAgent(claude)
      expect(started.cwd).toBe(e2e.repo)

      const deadline = Date.now() + 5000
      while (!/quirky\.agents: trust for claude failed: /.test(daemonLog()) && Date.now() < deadline) await Bun.sleep(50)
      expect(daemonLog()).toMatch(/quirky\.agents: trust for claude failed: /)

      const codex = await startAgent(AGENTS.find((agent) => agent.id === 'codex')!)
      expect(codex.cwd).toBe(e2e.repo)
      expect(readFileSync(SEEDED.codex(), 'utf8')).toContain(`[projects."${e2e.repo}"]`)
    },
    60_000
  )
})
