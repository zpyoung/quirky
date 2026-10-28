import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, type Session } from '@quirky/protocol'
import { E2eHarness, waitFor } from '../../quirky.terminal/test/e2e-support'
import { readRuntime, rpcUrl } from '@quirky/protocol/node'
import { openTab } from '../../quirky.terminal/test/e2e/support'

export type DockHarness = E2eHarness

const FAKE_TUI = `if [ "$1" = "--version" ]; then printf '1.0.0 (dock fake)\\n'; exit 0; fi
stty raw -echo
printf '\\033[?2004h> '
exec /bin/cat >> "$HOME/dock-pty-input.bin"`

/** Starts a fresh real daemon/PTY host with a raw-mode fake Claude TUI under its temporary HOME. */
export async function startDockE2E(): Promise<DockHarness> {
  const harness = await E2eHarness.start({ shell: '/bin/bash' })
  try {
    harness.writeBinScript('dock-fake-claude', FAKE_TUI)
    await harness.call('quirky.agents/configure', {
      agent: 'claude',
      command: join(harness.home, 'bin', 'dock-fake-claude')
    })
    return harness
  } catch (error) {
    await harness.cleanup()
    throw error
  }
}

export async function launchFakeClaude(harness: DockHarness): Promise<Session> {
  const opened = await openTab(harness, ['--agent', 'claude'], { ready: false })
  const session = await harness.sessionRecord(opened.session)
  await waitFor(`fake Claude PTY ${session.id} to start`, async () => {
    const lines = await harness.screen(session.id, 10).catch(() => [])
    return lines.some((line) => line.includes('>')) ? true : undefined
  }, 15_000)
  return session
}

export async function launchShell(harness: DockHarness): Promise<Session> {
  const opened = await openTab(harness, [], { ready: false })
  return harness.sessionRecord(opened.session)
}

export async function enableDock(harness: DockHarness): Promise<void> {
  await harness.call('setting.set', { id: 'setting:quirky.terminal-dock/enabled', value: true })
}

export async function connectUi(harness: DockHarness): Promise<QuirkyClient> {
  const runtime = readRuntime(harness.home)
  if (!runtime) throw new Error('dock test daemon is not running')
  return QuirkyClient.connect(rpcUrl(runtime), { role: 'ui', name: 'terminal-dock-test', subscribe: true })
}

export async function paneOf(harness: DockHarness, session: string): Promise<string> {
  const result = (await harness.call('quirky.terminal/paneOf', { session })) as { pane: string }
  return result.pane
}

/** Reads the bytes the fake TUI actually consumed from its PTY, not an RPC echo. */
export function inputBytes(harness: DockHarness): Buffer {
  try {
    return readFileSync(join(harness.home, 'dock-pty-input.bin'))
  } catch {
    return Buffer.alloc(0)
  }
}

export function inputText(harness: DockHarness): string {
  return inputBytes(harness).toString('utf8')
}

export function waitForTuiInput(harness: DockHarness, check: (input: Buffer) => boolean, timeoutMs = 15_000): Promise<Buffer> {
  return waitFor('fake TUI PTY input', () => {
    const bytes = inputBytes(harness)
    return check(bytes) ? bytes : undefined
  }, timeoutMs)
}
