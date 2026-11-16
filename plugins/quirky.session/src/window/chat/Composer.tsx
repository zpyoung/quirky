import { useEffect, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import type { AgentCapabilities, Session, UiPluginContext } from '@quirky/protocol'
import { Button, ScopeChip } from '@quirky/ui'
import { absolutePathsOf, Controls, NO_PICKS, reasonOf, useAgentOptions, type Picks } from './controls'
import { Mentions, useFileSearch } from './Mentions'
import { QueuedList } from './QueuedList'

type Attachment = { name: string; path: string }
type Mention = { start: number; query: string }

type ReportedSettings = { model?: string; effort?: string; permissionMode?: string; planMode?: boolean }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const MENTION_BEFORE_CARET = /(^|\s)@([^\s@]*)$/

const layout = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-6)',
  minWidth: 0,
  padding: 'var(--ui-space-8)',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)',
  borderTop: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties

const inputRow = { display: 'flex', alignItems: 'flex-end', gap: 'var(--ui-space-8)', minWidth: 0 } satisfies CSSProperties
const textarea = { flex: '1 1 auto', minWidth: 0, fontFamily: 'var(--ui-font-body)', resize: 'vertical' } satisfies CSSProperties
const footer = { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--ui-space-8)' } satisfies CSSProperties
const running = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-8)', color: 'var(--ui-muted)' } satisfies CSSProperties
const chips = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-4)' } satisfies CSSProperties
const ended = { padding: 'var(--ui-space-8)', color: 'var(--ui-muted)', borderTop: 'var(--ui-border-width) solid var(--ui-border)' } satisfies CSSProperties

/** Seconds since `working` last turned true, as "12s" or "1m 05s"; ticks once a second while working. */
function useElapsed(working: boolean): string {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!working) return
    const started = Date.now()
    setSeconds(0)
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [working])
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * The message box under a chat transcript. Enter sends now, or queues for the end of the turn while the
 * agent is working; unsupported controls stay visible with the capability's reason on hover. `onPick`
 * reports model, effort, permission mode and plan changes to whoever starts the next turn.
 */
export function Composer({
  context,
  session,
  capabilities,
  working,
  onPick
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  working: boolean
  onPick?: (picks: Picks) => void
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [picks, setPicks] = useState<Picks>(NO_PICKS)
  const [mention, setMention] = useState<Mention | null>(null)
  const [active, setActive] = useState(0)
  const options = useAgentOptions(context, session.agent)
  const search = useFileSearch(context, session.worktreeId, mention ? mention.query : null)
  const elapsed = useElapsed(working)

  const send = async () => {
    const value = text.trim()
    if (!value) return
    const images = attachments
    setText('')
    setAttachments([])
    setMention(null)
    try {
      await context.call('quirky.structured/send', {
        session: session.id,
        text: value,
        ...(images.length > 0 ? { images: images.map((image) => image.path) } : {}),
        when: working ? 'idle' : 'now'
      })
    } catch (error) {
      context.toast('Could not send', messageOf(error))
      setText(value)
      setAttachments(images)
    }
  }

  const pick = async (next: Picks) => {
    const before = picks
    setPicks(next)
    onPick?.(next)
    const changes = {
      ...(next.model !== before.model && next.model !== null ? { model: next.model } : {}),
      ...(next.effort !== before.effort && next.effort !== null ? { effort: next.effort } : {}),
      ...(next.mode !== before.mode && next.mode !== null ? { permissionMode: next.mode } : {}),
      ...(next.plan !== before.plan ? { planMode: next.plan } : {})
    }
    if (Object.keys(changes).length === 0) return
    try {
      const result = (await context.call('quirky.structured/configure', { session: session.id, ...changes })) as { settings?: ReportedSettings } | undefined
      const settings = result?.settings
      if (settings) {
        setPicks((current) => ({
          model: settings.model ?? current.model,
          effort: settings.effort ?? current.effort,
          mode: settings.permissionMode ?? current.mode,
          plan: settings.planMode ?? current.plan
        }))
      }
    } catch (error) {
      setPicks(before)
      context.toast('Could not change the setting', messageOf(error))
    }
  }

  const stop = async () => {
    try {
      await context.call('quirky.structured/interrupt', { session: session.id })
    } catch (error) {
      context.toast('Could not stop', messageOf(error))
    }
  }

  const attach = async (files: File[]) => {
    const unsupported = reasonOf(capabilities?.images)
    if (unsupported) {
      context.toast('Could not attach', unsupported)
      return
    }
    const paths = await absolutePathsOf(context, files)
    const added: Attachment[] = []
    files.forEach((file, index) => {
      const path = paths[index]
      if (!file.type.startsWith('image/')) context.toast('Could not attach', `${file.name} is not an image`)
      else if (path) added.push({ name: file.name, path })
      else context.toast('Could not attach', `${file.name} has no file path`)
    })
    setAttachments((current) => [...current, ...added.filter((image) => !current.some((existing) => existing.path === image.path))])
  }

  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files')

  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    const files = [...event.dataTransfer.files]
    if (files.length > 0) void attach(files)
  }

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    void attach(files)
  }

  const trackMention = (value: string, caret: number) => {
    const found = MENTION_BEFORE_CARET.exec(value.slice(0, caret))
    setMention(found ? { start: caret - found[2]!.length - 1, query: found[2]! } : null)
    setActive(0)
  }

  const pickMention = (path: string) => {
    if (!mention) return
    const end = mention.start + 1 + mention.query.length
    setText(`${text.slice(0, mention.start)}@${path} ${text.slice(end)}`)
    setMention(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (mention && search.items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((current) => (current + step + search.items.length) % search.items.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        pickMention(search.items[Math.min(active, search.items.length - 1)]!)
        return
      }
    }
    if (mention && event.key === 'Escape') {
      event.preventDefault()
      setMention(null)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  if (session.status === 'exited') {
    return (
      <div style={layout}>
        <QueuedList context={context} session={session} capabilities={capabilities} />
        <div style={ended} role="status">session ended</div>
      </div>
    )
  }

  return (
    <div
      style={layout}
      onDragOver={(event) => {
        if (hasFiles(event)) event.preventDefault()
      }}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <QueuedList context={context} session={session} capabilities={capabilities} />
      {mention && <Mentions search={search} active={active} onPick={pickMention} />}
      {attachments.length > 0 && (
        <div style={chips} aria-label="Attached images">
          {attachments.map((image) => (
            <ScopeChip
              key={image.path}
              label={image.name}
              removeLabel={`Remove ${image.name}`}
              onRemove={() => setAttachments((current) => current.filter((existing) => existing !== image))}
            />
          ))}
        </div>
      )}
      <div style={inputRow}>
        <textarea
          aria-label="Message"
          rows={2}
          value={text}
          placeholder={working ? 'Queue a message (Enter to queue, Shift+Enter for a new line)' : 'Message (Enter to send, Shift+Enter for a new line)'}
          className="ui-text-field__input"
          style={textarea}
          onChange={(event) => {
            setText(event.target.value)
            trackMention(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }}
          onKeyDown={onKeyDown}
        />
        <Button variant="primary" disabled={!text.trim()} onClick={() => void send()}>
          {working ? 'Queue' : 'Send'}
        </Button>
      </div>
      <div style={footer}>
        <Controls
          context={context}
          session={session}
          capabilities={capabilities}
          options={options}
          picks={picks}
          onPicks={(next) => void pick(next)}
        />
        {working && (
          <span style={running}>
            <span role="timer" aria-label="Elapsed time">{elapsed}</span>
            <Button variant="destructive" onClick={() => void stop()}>Stop</Button>
          </span>
        )}
      </div>
    </div>
  )
}
