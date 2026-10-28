import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { QuirkyClient, type Session } from '@quirky/protocol'
import { E2eHarness, waitFor } from '../../quirky.terminal/test/e2e-support'
import { readRuntime, rpcUrl } from '@quirky/protocol/node'
import { openTab } from '../../quirky.terminal/test/e2e/support'

export type DockHarness = E2eHarness

type DockE2EOptions = { holdBeforeEnter?: boolean }
export type DockSubmitWait = { reached: Promise<void>; dispose(): void }


function prepareBeforeSubmitBuiltins(home: string): string {
  const pluginRoot = resolve(import.meta.dir, '..', '..')
  const overlayRoot = join(home, 'dock-test-builtins')
  const sourceDock = join(pluginRoot, 'quirky.terminal-dock')
  const overlayDock = join(overlayRoot, 'quirky.terminal-dock')
  mkdirSync(overlayRoot)
  for (const name of readdirSync(pluginRoot)) {
    if (name !== 'quirky.terminal-dock') symlinkSync(join(pluginRoot, name), join(overlayRoot, name))
  }
  mkdirSync(overlayDock)
  for (const name of readdirSync(sourceDock)) {
    if (name !== 'main.ts') symlinkSync(join(sourceDock, name), join(overlayDock, name))
  }

  const mainUrl = pathToFileURL(join(sourceDock, 'main.ts')).href
  const stagePath = join(home, 'dock-before-enter')
  writeFileSync(join(overlayDock, 'main.ts'), [
    `import { writeFileSync } from 'node:fs'`,
    `import { activate as activateDock } from ${JSON.stringify(mainUrl)}`,
    `export async function activate(context) {`,
    `  await activateDock(context, {`,
    `    beforeSubmit(signal) {`,
    `      writeFileSync(${JSON.stringify(stagePath)}, '')`,
    `      const { promise, resolve } = Promise.withResolvers<void>()`,
    `      const aborted = () => {`,
    `        signal.removeEventListener('abort', aborted)`,
    `        resolve()`,
    `      }`,
    `      if (signal.aborted) aborted()`,
    `      else signal.addEventListener('abort', aborted, { once: true })`,
    `      return promise`,
    `    }`,
    `  })`,
    `}`,
    `export { deactivate } from ${JSON.stringify(mainUrl)}`,
    ''
  ].join('\n'))
  return overlayRoot
}


export function waitForDockBeforeEnter(harness: DockHarness): DockSubmitWait {
  const stagePath = join(harness.home, 'dock-before-enter')
  const stageName = 'dock-before-enter'
  let settled = false
  let watcher: FSWatcher | undefined
  const { promise: reached, resolve: resolveReached, reject: rejectReached } = Promise.withResolvers<void>()
  const finish = (error?: unknown): void => {
    if (settled) return
    settled = true
    watcher?.close()
    if (error) rejectReached(error)
    else resolveReached()
  }
  watcher = watch(harness.home, (_event, filename) => {
    if ((filename === null || filename.toString() === stageName) && existsSync(stagePath)) finish()
  })
  watcher.on('error', finish)
  if (existsSync(stagePath)) finish()
  return { reached, dispose: () => finish() }
}

/** Starts a fresh real daemon/PTY host with a raw-mode fake Claude TUI under its temporary HOME. */
export async function startDockE2E(options: DockE2EOptions = {}): Promise<DockHarness> {
  const harness = await E2eHarness.start({
    shell: '/bin/bash',
    ...(options.holdBeforeEnter ? { builtinPluginsDir: prepareBeforeSubmitBuiltins } : {})
  })
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

const FAKE_TUI = `if [ "$1" = "--version" ]; then printf '1.0.0 (dock fake)\\n'; exit 0; fi
stty raw -echo
printf '\\033[?2004h> '
exec /bin/cat >> "$HOME/dock-pty-input.bin"`


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
