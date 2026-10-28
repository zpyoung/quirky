import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UiPluginContext } from '@quirky/protocol'
import { startHarness, type Harness } from '../../../../packages/daemon/test/helpers'
import { HandoffDialog } from '../../src/window/model'

const PLUGINS = [
  'quirky.repo',
  'quirky.worktree',
  'quirky.git',
  'quirky.agents',
  'quirky.agent-status',
  'quirky.session',
  'quirky.terminal',
  'quirky.vault',
  'quirky.handoff'
]
const PLUGINS_ROOT = resolve(import.meta.dir, '../../..')
const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'QUIRKY_HOME',
  'QUIRKY_VAULT_SOURCE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'QUIRKY_AGENT_SEARCH_DIRS'
] as const
let harness: Harness | undefined
let root: string | undefined
let priorEnvironment: Map<string, string | undefined> | undefined

async function cleanup(): Promise<void> {
  try {
    await harness?.cleanup()
  } finally {
    harness = undefined
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
    if (priorEnvironment) {
      for (const [name, value] of priorEnvironment) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    priorEnvironment = undefined
  }
}

afterEach(cleanup)

test('Vault opens the real archived handoff dialog with provider identity and full source context', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-handoff-')))
  const quirkyHome = join(root, 'quirky-home')
  const sourceHome = join(root, 'source-home')
  const xdgHome = join(root, 'xdg-config')
  const emptyAgentBin = join(root, 'empty-agent-bin')
  for (const path of [quirkyHome, sourceHome, xdgHome, emptyAgentBin]) mkdirSync(path, { recursive: true })
  priorEnvironment = new Map(ENV_KEYS.map((name) => [name, process.env[name]] as const))
  process.env.HOME = sourceHome
  process.env.XDG_CONFIG_HOME = xdgHome
  process.env.QUIRKY_HOME = quirkyHome
  process.env.QUIRKY_VAULT_SOURCE_HOME = sourceHome
  process.env.CLAUDE_CONFIG_DIR = join(sourceHome, '.claude')
  process.env.CODEX_HOME = join(sourceHome, '.codex')
  process.env.QUIRKY_AGENT_SEARCH_DIRS = emptyAgentBin

  const builtinPluginsDir = join(quirkyHome, 'builtins')
  mkdirSync(builtinPluginsDir)
  for (const id of PLUGINS) symlinkSync(join(PLUGINS_ROOT, id), join(builtinPluginsDir, id), 'dir')
  harness = await startHarness({ home: quirkyHome, builtinPluginsDir })
  const caller = await harness.connectWithEvents('cli')
  const window = await harness.connectWithEvents('ui')

  const cwd = join(sourceHome, 'workspace')
  mkdirSync(cwd)
  const folderProject = await caller.client.callAny('quirky.repo/add', { path: cwd, folder: true }) as { id: string }
  const worktrees = await caller.client.callAny('quirky.worktree/list', { repo: folderProject.id }) as {
    id: string
    path: string
    isMain: boolean
  }[]
  const workspace = worktrees.find((worktree) => worktree.path === cwd && worktree.isMain)
  if (!workspace) throw new Error('registered archived-source folder has no primary worktree')
  const firstPrompt = `First archived prompt with its full literal content: ${'preserve this source context '.repeat(180)}`
  const lastPrompt = 'The most recent user request from the archived source.'
  const lastMessage = 'The latest assistant response from the archived transcript.'
  const providerSessionId = 'provider-archive-42'
  const transcriptPath = join(sourceHome, '.claude', 'projects', 'workspace', `${providerSessionId}.jsonl`)
  mkdirSync(join(sourceHome, '.claude', 'projects', 'workspace'), { recursive: true })
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'user',
      sessionId: providerSessionId,
      timestamp: '2026-10-01T10:00:00.000Z',
      cwd,
      message: { role: 'user', content: firstPrompt }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: providerSessionId,
      timestamp: '2026-10-01T10:00:01.000Z',
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: 'The first archived response.' }] }
    }),
    JSON.stringify({
      type: 'user',
      sessionId: providerSessionId,
      timestamp: '2026-10-01T10:00:02.000Z',
      cwd,
      message: { role: 'user', content: lastPrompt }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: providerSessionId,
      timestamp: '2026-10-01T10:00:03.000Z',
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: lastMessage }] }
    }),
    JSON.stringify({
      type: 'custom-title',
      sessionId: providerSessionId,
      timestamp: '2026-10-01T10:00:04.000Z',
      customTitle: 'Archived migration'
    })
  ].join(String.fromCharCode(10)) + String.fromCharCode(10))

  const sessions = await caller.client.callAny('quirky.vault/list', { agents: ['claude'], unlimited: true }) as {
    sessions: { id: string; sessionId: string; title: string; cwd: string; source: { filePath?: string } }[]
  }
  const selected = sessions.sessions.find((session) => session.sessionId === providerSessionId)
  if (!selected?.source.filePath) throw new Error('archived source was not discovered by the real Vault scanner')
  expect(selected.title).toBe('Archived migration')
  const fetchedFirstPrompt = await caller.client.callAny('quirky.vault/firstPrompt', { id: selected.id }) as {
    prompt: string | null
  }
  expect(fetchedFirstPrompt.prompt).toBe(firstPrompt)

  const uiContext = {
    call: (method: string, params: Record<string, unknown> = {}) => window.client.callAny(method, params),
    toast: () => {}
  } as unknown as UiPluginContext
  const dialog = new HandoffDialog(uiContext)
  window.client.onEvent((event) => {
    if (event.type !== 'ui.command.request' || event.id !== 'command:quirky.handoff/open-archived') return
    void (async () => {
      const args = event.args as { source: { archived: Parameters<typeof dialog.openArchived>[0] } }
      const result = await dialog.openArchived(args.source.archived)
      await window.client.call('ui.command.reply', { requestId: event.requestId, result })
    })()
  })

  const opened = await caller.client.callAny('quirky.vault/handoff', { id: selected.id }) as {
    available: boolean
    result?: { opened?: boolean }
    reason?: string
  }

  expect(opened).toMatchObject({ available: true, result: { opened: true } })
  expect(dialog.getSnapshot()).toMatchObject({
    shown: true,
    source: {
      session: null,
      agent: 'claude',
      providerSessionId,
      transcriptPath: selected.source.filePath,
      title: 'Archived migration',
      worktreeId: workspace.id,
      cwd,
      prompt: lastPrompt,
      lastMessage,
      live: false
    }
  })

  await caller.client.callAny('plugin.disable', { id: 'quirky.handoff' })
  const unavailable = await caller.client.callAny('quirky.vault/handoff', { id: selected.id }) as {
    available: boolean
    reason?: string
  }
  expect(unavailable.available).toBe(false)
  expect(typeof unavailable.reason).toBe('string')
  expect(unavailable.reason?.includes(providerSessionId)).toBe(false)
})
