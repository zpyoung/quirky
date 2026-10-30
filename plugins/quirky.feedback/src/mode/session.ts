import type { UiPluginContext } from '@quirky/protocol'
import { captureElement } from '../capture'
import { FEEDBACK_FULL, MAX_COMMENT_LENGTH, MAX_COMMENTS, type Capture, type Comment, type CommentIntent } from '../contract'
import { formatCommentsAsMarkdown } from '../format'
import { buildIssueDrafts, builtinRepository } from '../issue'
import { resolveTarget, type Target } from './target'

const ACTIVE = 'setting:quirky.feedback/active'
export const DISCARD_WARNING = 'Esc again discards this comment.'
const LIMIT_TITLE = 'Feedback tray is full'
const LIMIT_BODY = `The tray holds up to ${MAX_COMMENTS} comments. Delete or clear some to add more.`

export type Card = {
  /** Distinguishes one card from the next so a new selection starts with fresh focus. */
  serial: number
  /** Set when editing a saved comment; a new comment carries its capture instead. */
  id: string | null
  capture: Capture | null
  label: string
  intent: CommentIntent
  text: string
  initialText: string
  initialIntent: CommentIntent
  warned: boolean
  saving: boolean
}

export type SessionState = {
  comments: Comment[]
  recovered: boolean
  owners: Record<string, string>
  card: Card | null
  collapsed: boolean
  notice: string | null
}

type PluginInfo = { id: string; name?: string; repository?: string }

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Whether the card holds changes a discard would lose. */
export function isDirty(card: Card): boolean {
  if (card.text.trim() !== card.initialText.trim()) return true
  return card.id !== null && card.intent !== card.initialIntent
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function pluginsOf(value: unknown): PluginInfo[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is PluginInfo => typeof entry === 'object' && entry !== null && typeof (entry as PluginInfo).id === 'string')
}

/**
 * The state and actions behind the tray and card. Every daemon failure leaves the state as it was
 * and shows a toast; nothing leaves the window except through an explicit copy or issue draft.
 */
export function createSession(context: UiPluginContext, hooks: { suspend(suspended: boolean): void }) {
  let state: SessionState = { comments: [], recovered: false, owners: {}, card: null, collapsed: false, notice: null }
  let disposed = false
  let serial = 0
  let confirming = false
  const listeners = new Set<() => void>()

  const commit = (patch: Partial<SessionState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const patchCard = (patch: Partial<Card>) => {
    if (state.card !== null) commit({ card: { ...state.card, ...patch } })
  }
  const toastError = (title: string, cause: unknown) => context.toast(title, message(cause), { kind: 'error' })
  const toastFull = () => context.toast(LIMIT_TITLE, LIMIT_BODY, { kind: 'warning' })

  const ownerNames = (plugins: PluginInfo[]) => Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.name ?? plugin.id]))

  const self = {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async load() {
      const [listed, plugins] = await Promise.allSettled([
        context.call('quirky.feedback/list'),
        context.call('plugin.list')
      ])
      if (listed.status === 'rejected') toastError('Could not load feedback comments', listed.reason)
      const result = listed.status === 'fulfilled' ? listed.value as { comments?: Comment[]; recovered?: boolean } : {}
      commit({
        comments: Array.isArray(result.comments) ? result.comments : [],
        recovered: result.recovered === true,
        owners: plugins.status === 'fulfilled' ? ownerNames(pluginsOf(plugins.value)) : {}
      })
    },

    ownerName(owner: string): string {
      if (owner === 'quirky') return 'Quirky'
      return state.owners[owner] ?? owner
    },

    async exit() {
      try { await context.call('setting.set', { id: ACTIVE, value: false }) } catch (cause) { toastError('Could not leave Feedback mode', cause) }
    },

    pick(target: Target) {
      const card = state.card
      if (card !== null && isDirty(card)) return patchCard({ warned: true })
      if (state.comments.length >= MAX_COMMENTS) return toastFull()
      const capture = captureElement(target.element, { includeReact: process.env.QUIRKY_BUILD_CHANNEL === 'dev' })
      commit({
        notice: null,
        card: { serial: ++serial, id: null, capture, label: target.label, intent: 'change', text: '', initialText: '', initialIntent: 'change', warned: false, saving: false }
      })
    },

    pickElement: (element: Element) => self.pick(resolveTarget(element)),

    escape() {
      const card = state.card
      if (card === null) return void self.exit()
      if (isDirty(card) && !card.warned) return patchCard({ warned: true })
      commit({ card: null })
    },

    setText: (text: string) => patchCard({ text, warned: false }),
    setIntent: (intent: CommentIntent) => patchCard({ intent }),
    cancel: () => commit({ card: null }),

    edit(id: string) {
      const comment = state.comments.find((entry) => entry.id === id)
      if (comment === undefined) return
      const card = state.card
      if (card !== null && isDirty(card)) return patchCard({ warned: true })
      commit({
        notice: null,
        card: { serial: ++serial, id, capture: null, label: '', intent: comment.intent, text: comment.comment, initialText: comment.comment, initialIntent: comment.intent, warned: false, saving: false }
      })
    },

    async submit() {
      const card = state.card
      const text = card?.text.trim() ?? ''
      if (card === null || card.saving || text === '' || text.length > MAX_COMMENT_LENGTH) return
      patchCard({ saving: true })
      try {
        if (card.id === null) {
          const added = await context.call('quirky.feedback/add', { intent: card.intent, comment: text, capture: card.capture }) as Comment
          commit({ comments: [...state.comments, added], card: null })
        } else {
          const updated = await context.call('quirky.feedback/update', { id: card.id, comment: text, intent: card.intent }) as Comment
          commit({ comments: state.comments.map((entry) => (entry.id === updated.id ? updated : entry)), card: null })
        }
      } catch (cause) {
        patchCard({ saving: false })
        if (message(cause).startsWith(FEEDBACK_FULL)) toastFull()
        else toastError('Could not save the comment', cause)
      }
    },

    async remove(id: string) {
      try { await context.call('quirky.feedback/remove', { id }) } catch (cause) { return toastError('Could not delete the comment', cause) }
      commit({ comments: state.comments.filter((entry) => entry.id !== id), card: state.card?.id === id ? null : state.card })
    },

    async clear() {
      if (confirming) return
      confirming = true
      hooks.suspend(true)
      let confirmed = false
      try {
        confirmed = await context.confirm({
          title: 'Clear all feedback comments?',
          body: `This removes all ${plural(state.comments.length, 'comment')} from the tray.`,
          confirmLabel: 'Clear'
        })
      } catch (cause) { toastError('Could not ask for confirmation', cause) } finally { confirming = false; hooks.suspend(false) }
      if (!confirmed) return
      try { await context.call('quirky.feedback/clear') } catch (cause) { return toastError('Could not clear the comments', cause) }
      commit({ comments: [], card: state.card?.id === null ? state.card : null, notice: null })
    },

    async copy() {
      if (state.comments.length === 0) return
      const count = state.comments.length
      try {
        if (!navigator.clipboard?.writeText) throw new Error('The clipboard is not available in this window')
        await navigator.clipboard.writeText(formatCommentsAsMarkdown(state.comments))
      } catch (cause) { return toastError('Could not copy the comments', cause) }
      context.toast('Copied', `${plural(count, 'comment')} copied as Markdown.`, { kind: 'success' })
    },

    async fileIssue() {
      if (state.comments.length === 0) return
      let plugins: PluginInfo[]
      try { plugins = pluginsOf(await context.call('plugin.list')) } catch (cause) { return toastError('Could not look up plugin repositories', cause) }
      const repositoryOf = (owner: string) => builtinRepository(owner) ?? plugins.find((plugin) => plugin.id === owner)?.repository ?? null
      const { drafts, unrouted } = buildIssueDrafts(state.comments, repositoryOf)
      let opened = 0
      for (const draft of drafts) {
        try {
          const result = await context.call('quirky.terminal/openExternal', { target: draft.url }) as { ok?: boolean } | null
          if (result?.ok === false) toastError('Could not open the issue draft', `The draft for ${draft.repository} did not open.`)
          else opened++
        } catch (cause) { toastError('Could not open the issue draft', cause) }
      }
      const lines: string[] = []
      if (opened > 0) lines.push(`Opened ${plural(opened, 'issue draft')}.`)
      if (unrouted.length > 0) lines.push(`${plural(unrouted.length, 'comment')} can't go to GitHub. Use Copy for those.`)
      const remaining = drafts.reduce((total, draft) => total + draft.remaining, 0)
      if (remaining > 0) lines.push(`${plural(remaining, 'comment')} didn't fit. Delete the filed ones, then choose File issue again, or use Copy.`)
      commit({ notice: lines.length > 0 ? lines.join(' ') : null })
    },

    toggleCollapsed: () => commit({ collapsed: !state.collapsed }),
    dispose() {
      disposed = true
      listeners.clear()
    }
  }
  return self
}

export type Session = ReturnType<typeof createSession>
