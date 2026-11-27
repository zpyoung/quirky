/**
 * An agent drives Quirky through the `quirky` CLI alone: discover commands, read UI state, follow
 * the public event stream, change a setting, hit the destructive-call preview, and manage tabs and
 * chats. Setup uses the fixture's window; every assertion about the product goes through the CLI.
 */
import path from 'node:path'
import { spawnProcess } from '@quirky/process-host'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { z } from 'zod'
import { PublicEventSchema, type PublicEvent } from '../../src/shared/public-rpc/public-events'
import { expect, test } from './helpers/quirky-app'
import { runCompiledQuirkyCli, type QuirkyCliResult } from './helpers/compiled-quirky-cli'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { SUPPORTED, test as chatTest } from './helpers/structured-claude-stub'

const RuntimeStatusResult = z.object({ runtime: z.object({ reachable: z.boolean() }) })
const SchemaIndex = z.array(z.object({ command: z.string(), summary: z.string() }))
const UiStateResult = z.object({ worktreeId: z.string().nullable() })
const TabsResult = z.object({
  tabs: z.array(z.object({ id: z.string(), type: z.string(), title: z.string() }))
})
const WorktreeShowResult = z.object({ worktree: z.object({ id: z.string() }) })
const ChatCreateResult = z.object({ sessionId: z.string() })
const ChatSendResult = z.object({ sessionId: z.string(), status: z.string() })
const ChatHistoryResult = z.object({ items: z.array(z.object({ itemId: z.string() })) })
const ChatRequestsResult = z.object({ requests: z.array(z.unknown()) })
const StableFailure = z.object({
  code: z.string(),
  data: z.object({
    reason: z.string().optional(),
    next: z.array(z.object({ command: z.string(), why: z.string() })).optional(),
    effects: z.array(z.string()).optional()
  })
})

const BENIGN_SETTING = 'compactWorktreeCards'

type ParsedOutput<S extends z.ZodType> = { run: QuirkyCliResult; result: z.output<S> }

/** Runs a command that must exit 0 and parses its `--json` envelope's `result` with `schema`. */
async function cliOk<S extends z.ZodType>(
  userDataDir: string,
  args: string[],
  schema: S
): Promise<ParsedOutput<S>> {
  const run = await runCompiledQuirkyCli(userDataDir, [...args, '--json'])
  expect(run.code, `quirky ${args.join(' ')}: ${run.stdout} ${run.stderr}`).toBe(0)
  expect(run.json?.ok, run.stdout).toBe(true)
  return { run, result: schema.parse(run.json?.result) }
}

/** Runs a command that must fail and returns its exit code with the stable error it reported. */
async function cliFailure(
  userDataDir: string,
  args: string[]
): Promise<{ exitCode: number | null; error: z.output<typeof StableFailure> }> {
  const run = await runCompiledQuirkyCli(userDataDir, [...args, '--json'])
  expect(run.json?.ok, run.stdout).toBe(false)
  return { exitCode: run.code, error: StableFailure.parse(run.json?.error) }
}

type EventsStream = {
  events: () => PublicEvent[]
  isReady: () => boolean
  stop: () => Promise<void>
}

/** `quirky events` as a background process, collecting every frame it prints. */
async function startEventsStream(userDataDir: string, topics: string): Promise<EventsStream> {
  const child = spawnProcess({
    program: process.execPath,
    args: [
      path.join(process.cwd(), 'out', 'cli', 'index.js'),
      'events',
      '--topic',
      topics,
      '--json'
    ],
    env: { ...process.env, QUIRKY_USER_DATA_PATH: userDataDir, QUIRKY_DEV_CLI_INVOCATION: '1' },
    timeoutMs: null
  })
  const events: PublicEvent[] = []
  let ready = false
  let stderr = ''
  let pending = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines.filter((candidate) => candidate.trim().length > 0)) {
      const frame: unknown = JSON.parse(line)
      if (z.object({ type: z.literal('ready') }).safeParse(frame).success) {
        ready = true
        continue
      }
      const event = PublicEventSchema.safeParse(frame)
      if (event.success) {
        events.push(event.data)
      }
    }
  })
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    const exited = new Promise((settle) => child.once('exit', settle))
    child.kill('SIGTERM')
    await exited
  }
  const stream: EventsStream = { events: () => events, isReady: () => ready, stop }
  try {
    await expect
      .poll(() => (child.exitCode === null ? ready : `exited ${child.exitCode}: ${stderr}`), {
        timeout: 30_000,
        message: 'quirky events never sent its ready frame'
      })
      .toBe(true)
  } catch (error) {
    await stop()
    throw error
  }
  return stream
}

async function userDataDirOf(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ app }) => app.getPath('userData'))
}

test('an agent discovers, observes, changes and previews destructive calls through the CLI alone', async ({
  quirkyPage,
  electronApp
}) => {
  await waitForSessionReady(quirkyPage)
  const worktreeId = await waitForActiveWorktree(quirkyPage)
  const userDataDir = await userDataDirOf(electronApp)
  const workspace = `id:${worktreeId}`

  await test.step('status reaches the running app', async () => {
    const { result } = await cliOk(userDataDir, ['status'], RuntimeStatusResult)
    expect(result.runtime.reachable).toBe(true)
  })

  await test.step('schema lists chat send', async () => {
    const run = await runCompiledQuirkyCli(userDataDir, ['schema', '--json'])
    expect(run.code, run.stderr).toBe(0)
    const index = SchemaIndex.parse(JSON.parse(run.stdout))
    expect(index.map((entry) => entry.command)).toContain('chat send')
  })

  await test.step('ui state names the workspace the window shows', async () => {
    await expect
      .poll(
        async () => (await cliOk(userDataDir, ['ui', 'state'], UiStateResult)).result.worktreeId
      )
      .toBe(worktreeId)
  })

  const stream = await startEventsStream(userDataDir, 'ui,workspace,activity')
  try {
    await test.step('a setting change shows up as an activity event', async () => {
      await cliOk(userDataDir, ['settings', 'set', BENIGN_SETTING, 'true'], z.unknown())
      await expect
        .poll(
          () =>
            stream
              .events()
              .some(
                (event) =>
                  event.type === 'activity.recorded' && event.data.method === 'settings.update'
              ),
          { timeout: 15_000, message: 'no activity.recorded event for settings.update' }
        )
        .toBe(true)
    })

    await test.step('a destructive action previews and changes nothing without --yes', async () => {
      const { exitCode, error } = await cliFailure(userDataDir, [
        'action',
        'run',
        'workspace.delete',
        '--workspace',
        workspace
      ])
      expect(exitCode).toBe(4)
      expect(error.code).toBe('needs_confirmation')
      expect(error.data.effects?.length ?? 0).toBeGreaterThan(0)
      expect(error.data.next?.length ?? 0).toBeGreaterThan(0)

      const shown = await cliOk(
        userDataDir,
        ['worktree', 'show', '--worktree', workspace],
        WorktreeShowResult
      )
      expect(shown.result.worktree.id).toBe(worktreeId)
    })
  } finally {
    await stream.stop()
  }

  await test.step('tabs of every type list and close', async () => {
    await cliOk(userDataDir, ['terminal', 'create', '--worktree', workspace], z.unknown())
    let tabId: string | undefined
    await expect
      .poll(
        async () => {
          const { result } = await cliOk(userDataDir, ['tab', 'list', '--type', 'all'], TabsResult)
          tabId = result.tabs.find((tab) => tab.type === 'terminal')?.id
          return tabId
        },
        { timeout: 30_000, message: 'tab list --type all never showed the new terminal' }
      )
      .toBeTruthy()

    await cliOk(userDataDir, ['tab', 'close', '--page', tabId ?? '', '--type', 'all'], z.unknown())
    await expect
      .poll(
        async () =>
          (await cliOk(userDataDir, ['tab', 'list', '--type', 'all'], TabsResult)).result.tabs.some(
            (tab) => tab.id === tabId
          ),
        { timeout: 30_000, message: 'tab close left the tab in the list' }
      )
      .toBe(false)
  })
})

async function useStubClaude(page: Page, stubCommand: string): Promise<void> {
  await page.evaluate(async (command) => {
    await window.__store?.getState().updateSettings({
      experimentalNativeChat: true,
      defaultTuiAgent: 'claude',
      agentCmdOverrides: { claude: command }
    })
  }, buildFakeAgentCommandOverride(stubCommand))
}

chatTest.describe('an agent chats through the CLI', () => {
  chatTest.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  chatTest(
    'create, send --wait, history and requests work against a stubbed Claude',
    async ({ quirkyPage, electronApp, claudeStub }) => {
      chatTest.setTimeout(180_000)
      await waitForSessionReady(quirkyPage)
      const worktreeId = await waitForActiveWorktree(quirkyPage)
      await useStubClaude(quirkyPage, claudeStub.command)
      const userDataDir = await userDataDirOf(electronApp)
      const workspace = `id:${worktreeId}`

      const created = await cliOk(
        userDataDir,
        ['chat', 'create', '--workspace', workspace, '--agent', 'claude'],
        ChatCreateResult
      )
      const { sessionId } = created.result

      const sent = await cliOk(
        userDataDir,
        ['chat', 'send', sessionId, 'say hello', '--wait', '--timeout', '90000'],
        ChatSendResult
      )
      expect(sent.result).toMatchObject({ sessionId, status: 'finished' })

      await expect
        .poll(
          async () =>
            (await cliOk(userDataDir, ['chat', 'history', sessionId], ChatHistoryResult)).result
              .items.length,
          { timeout: 30_000, message: 'chat history stayed empty after a finished turn' }
        )
        .toBeGreaterThan(0)

      const requests = await cliOk(userDataDir, ['chat', 'requests', sessionId], ChatRequestsResult)
      expect(requests.result.requests).toEqual([])

      const unknown = await cliFailure(userDataDir, [
        'chat',
        'respond',
        sessionId,
        'no-such-request',
        '--allow'
      ])
      expect(unknown.exitCode).toBe(3)
      expect(unknown.error.code).toBe('not_found')
      expect(unknown.error.data.next?.length ?? 0).toBeGreaterThan(0)
    }
  )
})
