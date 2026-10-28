import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { DIALOG_OVERLAY_ID, messageOf, PLUGIN_ID, RESEND_CONFIRM_TITLE, SETTINGS_VIEW_ID } from './window/copy'
import { Dialog } from './window/Dialog'
import { HandoffDialog, reportOf, type CommandResult } from './window/model'
import { SettingsView } from './window/SettingsView'
import { injectHandoffStyles } from './window/styles'
import { templatesReport, TemplatesStore } from './window/templates'

const METHOD = (name: string) => `${PLUGIN_ID}/${name}`
const COMMAND = (name: string) => `command:${PLUGIN_ID}/${name}`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const ok = (): CommandResult => ({ ok: true })
const refused = (reason: string): CommandResult => ({ ok: false, reason })

let active: HandoffDialog | null = null

/**
 * Activates the handoff plugin's window code: the Continue in New Session overlay (always
 * mounted, reporting its fields, preview and Start state), the Session handoff settings view,
 * and every command that drives them, the pane menu entry and the delivery toast's actions.
 */
export function activate(context: UiPluginContext): void {
  const dialog = new HandoffDialog(context)
  const templates = new TemplatesStore(context)
  active = dialog

  context.subscribe((event) => {
    dialog.onEvent(event)
    templates.onEvent(event)
  })

  const mountDialog: MountFunction = (element, props) => {
    injectHandoffStyles(element.ownerDocument)
    const root = createRoot(element)
    let last = ''
    const send = () => {
      const report = reportOf(dialog.getSnapshot())
      const serialized = JSON.stringify(report)
      if (serialized === last) return
      last = serialized
      props.report?.(report)
    }
    const unsubscribe = dialog.subscribe(send)
    send()
    root.render(<Dialog dialog={dialog} />)
    return () => {
      unsubscribe()
      root.unmount()
    }
  }

  const mountSettings: MountFunction = (element, props) => {
    injectHandoffStyles(element.ownerDocument)
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', overflow: 'auto' })
    const root = createRoot(element)
    const send = () => props.report?.(templatesReport(templates.getSnapshot()))
    const unsubscribe = templates.subscribe(send)
    send()
    void templates.load()
    root.render(<SettingsView store={templates} />)
    return () => {
      unsubscribe()
      root.unmount()
    }
  }

  context.provide(DIALOG_OVERLAY_ID, mountDialog)
  context.provide(SETTINGS_VIEW_ID, mountSettings)

  const provide = (name: string, handler: (args: Record<string, unknown>) => unknown) =>
    context.provide(COMMAND(name), (args?: unknown) => handler(isRecord(args) ? args : {}))

  provide('open', (args) => {
    const session = text(args.session)
    return session ? dialog.open(session) : refused('session-required')
  })
  provide('set', (args) => dialog.set(text(args.field) ?? '', args.value))
  provide('edit', (args) => {
    const edited = text(args.text)
    return edited === undefined ? refused('text-required') : dialog.edit(edited)
  })
  provide('regenerate', () => dialog.regenerate())
  provide('wait-idle', () => dialog.waitIdle())
  provide('capture', () => dialog.capture())
  provide('start', () => dialog.start())
  provide('cancel', () => dialog.cancel())
  provide('save-template', (args) => dialog.saveTemplate(text(args.name)))
  provide('search', (args) => dialog.search(text(args.query) ?? ''))

  provide('resend-confirm', async (args) => {
    const session = text(args.session)
    if (!session) return refused('session-required')
    if (!(await context.confirm({ title: RESEND_CONFIRM_TITLE, confirmLabel: 'Send again' }))) return refused('cancelled')
    try {
      await context.call(METHOD('resend'), { session })
      return ok()
    } catch (error) {
      context.toast('Could not resend the brief', messageOf(error))
      return refused('resend-failed')
    }
  })

  provide('discard', async (args) => {
    const session = text(args.session)
    if (!session) return refused('session-required')
    try {
      await context.call(METHOD('discard'), { session })
    } catch (error) {
      context.log(`could not discard the handoff brief: ${messageOf(error)}`)
    }
    return ok()
  })

  provide('jump', async (args) => {
    const session = text(args.session)
    if (!session) return refused('session-required')
    const lineage = text(args.lineage)
    try {
      await context.call(METHOD('jump'), { session, ...(lineage === undefined ? {} : { lineage }) })
      return ok()
    } catch (error) {
      context.toast(messageOf(error), '')
      return refused('jump-failed')
    }
  })

  provide('open-settings', () => {
    context.openView(SETTINGS_VIEW_ID)
    return ok()
  })

  const edit = async (args: Record<string, unknown>, open: () => CommandResult): Promise<CommandResult> => {
    const opened = open()
    if (!opened.ok) return opened
    context.openView(SETTINGS_VIEW_ID)
    const name = text(args.name)
    const body = text(args.body)
    if (name !== undefined || body !== undefined) templates.setEditor({ ...(name === undefined ? {} : { name }), ...(body === undefined ? {} : { body }) })
    return args.save === true ? templates.saveEditor() : ok()
  }
  provide('template-add', (args) =>
    edit(args, () => {
      templates.editNew()
      return ok()
    })
  )
  const loaded = async () => {
    if (templates.getSnapshot().templates.length === 0) await templates.load()
  }
  provide('template-edit', async (args) => {
    await loaded()
    return edit(args, () => templates.editExisting(text(args.id) ?? ''))
  })
  provide('template-remove', async (args) => {
    await loaded()
    return templates.remove(text(args.id) ?? '')
  })
  provide('templates-reset', () => templates.reset())
}

/** Ends the dialog's timers and listeners when the plugin is turned off. */
export function deactivate(): void {
  active?.stop()
  active = null
}
