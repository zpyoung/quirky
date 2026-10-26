import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../daemon/test/helpers'
import { removeTempDirs, writePlugin } from '../../../daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from './headless-window'

export type WindowEnv = {
  harness: Harness
  win: HeadlessWindow
  /** A second client, as the CLI or an agent would be. */
  agent: QuirkyClient
}

const open: WindowEnv[] = []

/**
 * A real daemon with the plugins `write` installs under its home, and a headless window connected
 * to it once the window's layout and UI model have loaded. `closeWindows` ends everything started.
 */
export async function bootWindow(write: (installed: string) => void): Promise<WindowEnv> {
  const home = makeTempHome()
  write(join(home, 'plugins'))
  const harness = await startHarness({ home, builtinPluginsDir: null })
  const win = await startHeadlessWindow({ home, runtime: harness.runtime })
  const env = { harness, win, agent: await harness.connect('cli', 'agent') }
  open.push(env)
  return env
}

export async function closeWindows(): Promise<void> {
  for (const env of open.splice(0)) {
    await env.win.stop()
    await env.harness.cleanup()
  }
  removeTempDirs()
}

const q = JSON.stringify

/**
 * Installs plugin `id` whose UI module is plain JavaScript: `body` runs inside `activate(context)`
 * and may call `context.provide`. The DOM globals are the headless window's.
 */
export function installUiPlugin(
  installed: string,
  id: string,
  contributes: Record<string, unknown[]>,
  body: string,
  extra: Record<string, unknown> = {}
): void {
  writePlugin(
    installed,
    { id, name: id, version: '1.0.0', ui: 'ui.js', contributes, ...extra },
    { 'ui.js': `export function activate(context) {\n${body}\n}\nexport function deactivate() {}\n` }
  )
}

/** Statements providing `slot` as a mount function whose body sees `element`, `props` and `context`. */
export const provide = (slot: string, body: string) =>
  `context.provide(${q(slot)}, (element, props) => { ${body} })`
