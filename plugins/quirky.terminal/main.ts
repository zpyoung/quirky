import type { PluginContext } from '@quirky/protocol'
import { importMigrations, importV1Scrollback } from './src/scrollback'
import { TerminalService } from './src/terminal'

let service: TerminalService | undefined

export async function activate(context: PluginContext): Promise<void> {
  const terminal = new TerminalService(context)
  service = terminal

  const methods = {
    attach: terminal.attach,
    detach: terminal.detach,
    write: terminal.write,
    resize: terminal.resize,
    send: terminal.send,
    read: terminal.read
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(`method:${context.pluginId}/${name}`, handler)

  context.pty.onData(terminal.onData)
  context.pty.onReconnect(() => void terminal.onReconnect())
  context.subscribe(terminal.onEvent)

  try {
    await importV1Scrollback(context, context.openStore(importMigrations))
  } catch (error) {
    context.log(`could not import v1 scrollback: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function deactivate(): void {
  service?.shutdown()
  service = undefined
}
