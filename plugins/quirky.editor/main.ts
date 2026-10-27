import type { MethodHandler, PluginCaller, PluginContext } from '@quirky/protocol'
import { createMarkdownMethods } from './src/markdown/service'
import { createNotebookMethods } from './src/notebook/service'
import { createViewerMethods } from './src/viewers/service'
import { EditorDaemon } from './src/daemon/service'

let editor: EditorDaemon | undefined
let markdown: ReturnType<typeof createMarkdownMethods> | undefined
let notebook: ReturnType<typeof createNotebookMethods> | undefined
let viewers: ReturnType<typeof createViewerMethods> | undefined
let unsubscribe: (() => void) | undefined
const UI_COMMAND_METHODS = [
  'find',
  'replace',
  'markdown-preview',
  'toggle-word-wrap',
  'copy-context',
  'add-review-note',
  'zoom-in',
  'zoom-out',
  'reset-zoom',
  'toggle-right-sidebar',
  'new-markdown',
  'open-markdown'
] as const

export async function activate(context: PluginContext): Promise<void> {
  const core = new EditorDaemon(context)
  const markdownMethods = createMarkdownMethods(core.services)
  const notebookMethods = createNotebookMethods(core.services)
  const viewerMethods = createViewerMethods(core.services)
  editor = core
  markdown = markdownMethods
  notebook = notebookMethods
  viewers = viewerMethods
  unsubscribe = context.subscribe((event) => core.onEvent(event))
  const uiCommandMethods: Record<string, MethodHandler> = Object.fromEntries(UI_COMMAND_METHODS.map((name) => [
    name,
    (args: Record<string, unknown>) => context.call('ui.command.run', {
      id: `command:${context.pluginId}/${name}`,
      args
    })
  ]))

  const methods = {
    ...core.methods,
    ...markdownMethods.methods,
    ...notebookMethods.methods,
    ...viewerMethods.methods,
    ...uiCommandMethods
  }
  for (const [name, handler] of Object.entries(methods)) {
    context.provide(`method:${context.pluginId}/${name}`, async (params: Record<string, unknown>, caller: PluginCaller) =>
      core.projectPublic(name, await handler(params, caller))
    )
  }
  await core.restore()
}

export async function deactivate(): Promise<void> {
  unsubscribe?.()
  unsubscribe = undefined
  const current = editor
  editor = undefined
  await current?.dispose()
  await markdown?.dispose()
  await notebook?.dispose()
  await viewers?.dispose()
  markdown = undefined
  notebook = undefined
  viewers = undefined
}
