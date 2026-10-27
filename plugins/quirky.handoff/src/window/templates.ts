import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { Template } from '../core/types'
import { TEMPLATE_BODY_MAX, TEMPLATE_LIMIT, TEMPLATE_NAME_MAX } from '../core/template'
import { messageOf, PLUGIN_ID, reasonOf } from './copy'
import type { CommandResult } from './model'

const METHOD = (name: string) => `${PLUGIN_ID}/${name}`

export type TemplateEditor = { id: string | null; name: string; body: string }

export type TemplatesSnapshot = {
  templates: Template[]
  custom: boolean
  limit: number
  editor: TemplateEditor | null
  /** The title of the confirmation waiting for an answer. */
  confirm: string | null
  /** Set after a save that reused another template's name; both templates are kept. */
  warning: string | null
}

type CatalogResult = { templates: Template[]; custom: boolean; limit?: number; warnings?: string[] }

const ok = (): CommandResult => ({ ok: true })
const refused = (reason: string): CommandResult => ({ ok: false, reason })

/** The view's report: the catalog and what the editor and confirmation hold. */
export function templatesReport(s: TemplatesSnapshot) {
  return {
    templates: s.templates,
    custom: s.custom,
    count: s.templates.length,
    limit: s.limit,
    editor: s.editor,
    confirm: s.confirm,
    warning: s.warning
  }
}

export const canSaveEditor = (editor: TemplateEditor | null): boolean =>
  editor !== null && editor.name.trim() !== '' && editor.body.trim() !== ''

/**
 * The Session handoff settings page: the template catalog as the daemon holds it, the editor
 * for one template, and the confirmations before removing one or resetting the list. Shared by
 * the view and its commands, so a script drives the page the window shows.
 */
export class TemplatesStore {
  private snapshot: TemplatesSnapshot = { templates: [], custom: false, limit: TEMPLATE_LIMIT, editor: null, confirm: null, warning: null }
  private listeners = new Set<() => void>()

  constructor(private readonly context: UiPluginContext) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): TemplatesSnapshot => this.snapshot

  private commit(patch: Partial<TemplatesSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private adopt(result: CatalogResult): void {
    this.commit({ templates: result.templates, custom: result.custom, limit: result.limit ?? this.snapshot.limit })
  }

  onEvent(event: QuirkyEvent): void {
    if (event.type === 'quirky.handoff/changed' && (event.data as { kind?: string } | null)?.kind === 'templates') void this.load()
  }

  async load(): Promise<void> {
    try {
      this.adopt((await this.context.call(METHOD('templates'))) as CatalogResult)
    } catch (error) {
      this.context.toast('Could not read the handoff templates', messageOf(error))
    }
  }

  /** Opens the editor for a new template, or, with `id`, for that template. */
  openEditor(editor: TemplateEditor): void {
    this.commit({ editor, warning: null })
  }

  editNew(fields: Partial<Pick<TemplateEditor, 'name' | 'body'>> = {}): void {
    this.openEditor({ id: null, name: fields.name ?? '', body: fields.body ?? '' })
  }

  editExisting(id: string, fields: Partial<Pick<TemplateEditor, 'name' | 'body'>> = {}): CommandResult {
    const template = this.snapshot.templates.find((candidate) => candidate.id === id)
    if (!template) return refused('unknown-template')
    this.openEditor({ id, name: fields.name ?? template.name, body: fields.body ?? template.body })
    return ok()
  }

  setEditor(patch: Partial<Pick<TemplateEditor, 'name' | 'body'>>): void {
    const { editor } = this.snapshot
    if (!editor) return
    this.commit({
      editor: {
        ...editor,
        ...(patch.name === undefined ? {} : { name: patch.name.slice(0, TEMPLATE_NAME_MAX) }),
        ...(patch.body === undefined ? {} : { body: patch.body.slice(0, TEMPLATE_BODY_MAX) })
      }
    })
  }

  closeEditor(): void {
    this.commit({ editor: null })
  }

  /** Stores the editor's template; a name another template already has is kept and warned about. */
  async saveEditor(): Promise<CommandResult> {
    const { editor } = this.snapshot
    if (!editor) return refused('no-editor')
    if (!canSaveEditor(editor)) return refused('cannot-save')
    const name = editor.name.trim()
    try {
      const result = (await this.context.call(METHOD('templateMutate'), {
        op: editor.id === null ? 'add' : 'update',
        template: { ...(editor.id === null ? {} : { id: editor.id }), name, body: editor.body }
      })) as CatalogResult
      this.adopt(result)
      this.commit({ editor: null, warning: result.warnings?.includes('duplicate-name') ? `Another template is already named “${name}”. Both were kept.` : null })
      return ok()
    } catch (error) {
      this.context.toast('Could not save the template', messageOf(error))
      return refused(reasonOf(error) ?? 'save-failed')
    }
  }

  private async confirmed(title: string, confirmLabel: string): Promise<boolean> {
    this.commit({ confirm: title })
    try {
      return await this.context.confirm({ title, confirmLabel })
    } finally {
      this.commit({ confirm: null })
    }
  }

  async remove(id: string): Promise<CommandResult> {
    const template = this.snapshot.templates.find((candidate) => candidate.id === id)
    if (!template) return refused('unknown-template')
    if (!(await this.confirmed(`Delete “${template.name}”?`, 'Delete'))) return refused('cancelled')
    try {
      this.adopt((await this.context.call(METHOD('templateMutate'), { op: 'remove', id })) as CatalogResult)
      this.commit({ warning: null })
      return ok()
    } catch (error) {
      this.context.toast('Could not remove the template', messageOf(error))
      return refused(reasonOf(error) ?? 'remove-failed')
    }
  }

  async reset(): Promise<CommandResult> {
    if (!(await this.confirmed('Reset handoff templates?', 'Reset'))) return refused('cancelled')
    try {
      this.adopt((await this.context.call(METHOD('templateMutate'), { op: 'reset' })) as CatalogResult)
      this.commit({ warning: null })
      return ok()
    } catch (error) {
      this.context.toast('Could not reset the templates', messageOf(error))
      return refused(reasonOf(error) ?? 'reset-failed')
    }
  }
}
