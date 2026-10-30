import type { PluginContext } from '@quirky/protocol'
import { InputTracker } from './src/input-tracker'
import { LayoutService } from './src/layout/service'
import { LayoutStore, migrations } from './src/layout/store'
import { QuickCommandService } from './src/quick-commands/service'
import { importV1Scrollback } from './src/scrollback'
import { factEvent, TerminalService } from './src/terminal'
import { TerminalArtifactsService } from './src/artifacts'
import { EmulatorService } from './src/emulator'

let service: TerminalService | undefined
let layout: LayoutService | undefined
let artifacts: TerminalArtifactsService | undefined
let emulator: EmulatorService | undefined

export async function activate(context: PluginContext): Promise<void> {
  const store = context.openStore(migrations)
  const inputs = new InputTracker()
  const layoutStore = new LayoutStore(store)
  const layoutService = new LayoutService(context, layoutStore, inputs)
  const terminal = new TerminalService(
    context,
    (sessionIds) => layoutService.tabTitlesForSessions(sessionIds),
    inputs
  )
  const quickCommands = new QuickCommandService(context, layoutStore, layoutService, inputs, terminal)
  service = terminal
  const artifactService = new TerminalArtifactsService(context)
  artifacts = artifactService
  layout = layoutService
  const emulatorService = new EmulatorService(context)
  emulator = emulatorService

  const methods = {
    attach: terminal.attach,
    detach: terminal.detach,
    write: terminal.write,
    userInput: terminal.userInput,
    resize: terminal.resize,
    clear: terminal.clear,
    displayMode: terminal.displayMode,
    send: terminal.send,
    read: terminal.read,
    snapshot: terminal.snapshot,
    history: terminal.history,
    sessions: terminal.sessions,
    kill: terminal.kill,
    killAll: terminal.killAll,
    restartHost: terminal.restartHost,
    mobileState: terminal.mobileState,
    takeBack: terminal.takeBack,
    restoreFit: terminal.restoreFit,
    claim: terminal.claim,
    artifacts: artifactService.handle,
    emulators: emulatorService.list,
    emulatorFrame: emulatorService.frame,
    ...layoutService.methods,
    ...quickCommands.methods
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(`method:${context.pluginId}/${name}`, handler)

  context.pty.onData(terminal.onData)
  context.pty.onExit(terminal.onExit)
  context.pty.onFact((sessionId, fact) => {
    const event = factEvent(sessionId, fact)
    if (event) context.emit(event.name, event.data)
    layoutService.onFact(sessionId, fact)
  })
  context.pty.onReconnect(() => {
    void terminal.onReconnect()
    layoutService.onReconnect()
  })
  context.subscribe((event) => {
    terminal.onEvent(event)
    if (event.type === 'quirky.session/changed' || event.type === 'quirky.session/removed') layoutService.requestReconcile()
  })
  layoutService.start()

  try {
    await importV1Scrollback(context, store)
  } catch (error) {
    context.log(`could not import v1 scrollback: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function deactivate(): void {
  emulator?.shutdown()
  emulator = undefined
  artifacts?.shutdown()
  artifacts = undefined
  service?.shutdown()
  layout?.shutdown()
  service = undefined
  layout = undefined
}
