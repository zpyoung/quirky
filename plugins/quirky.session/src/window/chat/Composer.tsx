import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { AgentCapabilities, PermissionModeName, QueuedMessage, Session, StructuredMessage, UiPluginContext, VisualLevel } from '@quirky/protocol'
import { Button, ControlIcon, IconButton, InlineError, ScopeChip, StatusDot } from '@quirky/ui'
import { WORKTREE_VIEW_ID } from '../model'
import type { QuirkyCommandName } from './commands'
import { basename, base64Of, composeMessage, pasteLabel, relativeTo, useDraftSync, type Attachment, type PasteChip } from './composerDraft'
import { absolutePathsOf, AgentChip, defaultVisualLevel, NO_PICKS, reasonOf, registerChatHandle, useAgentOptions, useTurnSettings, useVisualLabels, VisualDial, type Picks } from './controls'
import { createChat } from './createChat'
import { ComposerEditor } from './editor/ComposerEditor'
import { parsePills } from './editor/pills'
import { rememberVisualLabel, type VisualLabel, type VisualRef } from './editor/types'
import { ImageChip } from './ImageChip'
import type { ComposerEditorHandle, NavKey, Trigger } from './editor/types'
import { useFileSearch } from './Mentions'
import { QueuedList, useQueue, type SteeredMessage } from './QueuedList'
import { ModeBadges, SettingsChip, type SettingsSection } from './SettingsChip'
import { fileSuggestions, slashSuggestions, SuggestionList, useAgentCommands, type Suggestion } from './SuggestionList'

type ReportedSettings = { model?: string; effort?: string; permissionMode?: string; visualLevel?: VisualLevel }
type Snapshot = { text: string; images: Attachment[]; pastes: PasteChip[] }
type Failure = { message: string; retry?: () => void }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const PASTE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const DROP_HINT = 'Drop or paste images here'

const outer = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  padding: 'var(--ui-space-8)',
  // the surrounding view's layout toggle floats over the bottom-right corner, so the card stops short of it
  paddingInlineEnd: 'calc(2.5rem + var(--ui-space-16))',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)'
} satisfies CSSProperties
const stack = { display: 'flex', flexDirection: 'column', minWidth: 0 } satisfies CSSProperties
const chips = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-4)' } satisfies CSSProperties
const editorBox = { minWidth: 0, flex: '0 0 auto', padding: 'var(--ui-space-2) var(--ui-space-4)' } satisfies CSSProperties
const toolbar = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-6)', minWidth: 0 } satisfies CSSProperties
const grow = { flex: '1 1 auto' } satisfies CSSProperties
const running = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-6)', color: 'var(--ui-muted)', whiteSpace: 'nowrap' } satisfies CSSProperties
const round = { borderRadius: '50%', flex: '0 0 auto' } satisfies CSSProperties
const errorBox = { paddingTop: 'var(--ui-space-6)' } satisfies CSSProperties
const endedCard = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-12)',
  color: 'var(--ui-muted)',
  border: 'var(--ui-border-width) dashed var(--ui-border)'
} satisfies CSSProperties

const card = (attached: boolean, accent: boolean): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-6)',
  minWidth: 0,
  padding: 'var(--ui-space-8)',
  background: 'var(--ui-surface)',
  border: `var(--ui-border-width) solid ${accent ? 'var(--ui-accent)' : 'var(--ui-border)'}`,
  borderRadius: attached ? '0 0 var(--ui-radius-window) var(--ui-radius-window)' : 'var(--ui-radius-window)'
})

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

/** Whether the desktop shell can open a native file picker; false until it says so. */
function useFilePicker(context: UiPluginContext): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    context
      .call('desktop.capabilities', {})
      .then((found) => {
        if (!cancelled) setAvailable((found as { filePicker?: boolean } | undefined)?.filePicker === true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [context])
  return available
}

const isImage = (file: File) => file.type.startsWith('image/')
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
let pasteSeq = 0

/**
 * The card under a chat transcript: the message editor with its toolbar inside the bottom edge and the
 * suggestion list or queued rows attached above it. Enter sends now, or queues for the end of the turn
 * while the agent works, and Cmd+Enter steers it into the running turn. Unsupported controls stay
 * visible with the capability's reason on hover. The Mode list, `/plan` and Shift+Tab share one
 * permission mode that follows `reportedMode`, the mode Claude says it is in; `autoAvailable` says whether
 * Claude offers Auto (undefined before the chat has started) and `previousMode` is where `/plan` returns
 * to. `onPick` reports model, effort and permission mode changes to whoever starts the next turn.
 * The visual dial shows `reportedLevel`, the level the chat last journaled, or the default level setting
 * before there is one. Pointing at part of a visual puts a reference chip in front of the typed text.
 */
export function Composer({
  context,
  session,
  capabilities,
  working,
  reportedMode,
  autoAvailable,
  previousMode,
  reportedLevel,
  onPick
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  working: boolean
  reportedMode?: PermissionModeName
  autoAvailable?: boolean
  previousMode?: PermissionModeName
  reportedLevel?: VisualLevel
  onPick?: (picks: Picks) => void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [pastes, setPastes] = useState<PasteChip[]>([])
  const [picks, setPicks] = useState<Picks>(NO_PICKS)
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [section, setSection] = useState<SettingsSection | null>(null)
  const [steered, setSteered] = useState<SteeredMessage[]>([])
  const [focused, setFocused] = useState(false)
  const editor = useRef<ComposerEditorHandle>(null)
  const previews = useRef(new Set<string>())
  const lastQuery = useRef('')
  const options = useAgentOptions(context, session.agent)
  const settings = useTurnSettings(context, session, capabilities, options, picks, autoAvailable)
  const reported = useRef(reportedMode)
  reported.current = reportedMode
  const reportedLevelRef = useRef(reportedLevel)
  reportedLevelRef.current = reportedLevel
  const latestText = useRef(text)
  latestText.current = text
  useVisualLabels(context)
  const queue = useQueue(context, session.id)
  const commands = useAgentCommands(context, session.id)
  const filePicker = useFilePicker(context)
  const search = useFileSearch(context, session.worktreeId, trigger?.kind === '@' ? trigger.query : null)
  const elapsed = useElapsed(working)
  const ended = session.status === 'exited'
  const agentLabel = capitalized(session.agent)
  const sendKey = (() => {
    try {
      return context.getSetting('send-with-cmd-enter') === true ? 'mod-enter' : 'enter'
    } catch {
      return 'enter'
    }
  })()

  const fail = (message: string, retry?: () => void) => setFailure({ message, ...(retry ? { retry } : {}) })

  const pick = async (next: Picks, before: Picks = picks) => {
    setPicks(next)
    onPick?.(next)
    const wasLevel = before.visualLevel ?? reportedLevelRef.current ?? defaultVisualLevel(context)
    const changes = {
      ...(next.model !== before.model && next.model !== null ? { model: next.model } : {}),
      ...(next.effort !== before.effort && next.effort !== null ? { effort: next.effort } : {}),
      ...(next.mode !== before.mode && next.mode !== null ? { permissionMode: next.mode } : {}),
      ...(next.visualLevel !== undefined && next.visualLevel !== wasLevel ? { visualLevel: next.visualLevel } : {})
    }
    if (Object.keys(changes).length === 0) return
    try {
      const result = (await context.call('quirky.structured/configure', { session: session.id, ...changes })) as { settings?: ReportedSettings } | undefined
      const settled = result?.settings
      if (settled) {
        setPicks((current) => ({
          model: settled.model ?? current.model,
          effort: settled.effort ?? current.effort,
          mode: settled.permissionMode ?? current.mode,
          ...((settled.visualLevel ?? current.visualLevel) === undefined ? {} : { visualLevel: settled.visualLevel ?? current.visualLevel })
        }))
      }
    } catch (error) {
      setPicks(before)
      fail(`Could not change the setting: ${messageOf(error)}`)
    }
  }

  useEffect(() => {
    if (reportedMode !== undefined) setPicks((current) => (current.mode === reportedMode ? current : { ...current, mode: reportedMode }))
  }, [reportedMode])

  useEffect(() => {
    if (reportedLevel !== undefined) setPicks((current) => (current.visualLevel === reportedLevel ? current : { ...current, visualLevel: reportedLevel }))
  }, [reportedLevel])

  // once Claude reports its mode, or the chat its visual level, the pick only mirrors it, so the stored pick is dropped from the draft
  const { visualLevel: levelPick, ...otherPicks } = picks
  const draftPicks: Picks = {
    ...(reportedMode === undefined ? otherPicks : { ...otherPicks, mode: null }),
    ...(levelPick !== undefined && reportedLevel === undefined ? { visualLevel: levelPick } : {})
  }
  const draft = useDraftSync(context, session.id, { text, images: images.map((image) => image.path), pastes, picks: draftPicks }, (restored) => {
    const known = reported.current
    const knownLevel = reportedLevelRef.current
    const stored = restored?.picks ?? NO_PICKS
    const level = knownLevel ?? stored.visualLevel
    setText(restored?.text ?? '')
    setImages((restored?.images ?? []).map((path) => ({ name: basename(path), path })))
    setPastes(restored?.pastes ?? [])
    setPicks({ model: stored.model, effort: stored.effort, mode: known ?? stored.mode, ...(level === undefined ? {} : { visualLevel: level }) })
    setTrigger(null)
    setFailure(null)
    if (!restored) setSteered([])
    else if (stored.model !== null || stored.effort !== null || (known === undefined && stored.mode !== null) || (knownLevel === undefined && stored.visualLevel !== undefined)) {
      void pick({ model: stored.model, effort: stored.effort, mode: known ?? stored.mode, ...(level === undefined ? {} : { visualLevel: level }) }, { ...NO_PICKS, mode: known ?? null })
    }
  })

  useEffect(() => {
    if (!working) setSteered([])
  }, [working])

  useEffect(() => {
    const created = previews.current
    return () => {
      for (const url of created) URL.revokeObjectURL(url)
      created.clear()
    }
  }, [])

  const previewOf = (file: File) => {
    const url = URL.createObjectURL(file)
    previews.current.add(url)
    return url
  }

  const removeImage = (image: Attachment) => {
    setImages((current) => current.filter((existing) => existing !== image))
    if (image.preview && previews.current.delete(image.preview)) URL.revokeObjectURL(image.preview)
  }

  const steerWatchers = useRef(new Set<{ text: string; arrived: boolean }>())

  useEffect(
    () =>
      context.subscribe((event) => {
        if (event.type !== 'quirky.structured/message') return
        const message = (event.data as { message?: StructuredMessage } | undefined)?.message
        if (!message || message.sessionId !== session.id || message.role !== 'user') return
        const said = message.text.trim()
        for (const watcher of steerWatchers.current) if (watcher.text.trim() === said) watcher.arrived = true
        setSteered((current) => {
          const index = current.findIndex((entry) => entry.text.trim() === said)
          return index < 0 ? current : current.filter((_, position) => position !== index)
        })
      }),
    [context, session.id]
  )

  const addImages = (added: Attachment[]) =>
    setImages((current) => {
      const next = [...current]
      for (const image of added) if (!next.some((existing) => existing.path === image.path)) next.push(image)
      return next
    })

  const submitRef = useRef<(kind: 'send' | 'steer', again?: Snapshot) => Promise<void>>(async () => {})
  const submit = async (kind: 'send' | 'steer', again?: Snapshot) => {
    const snapshot = again ?? { text, images, pastes }
    const body = composeMessage(snapshot.text, snapshot.pastes)
    if (body === '' && snapshot.images.length === 0) return
    const steerReason = reasonOf(capabilities?.steer)
    if (kind === 'steer' && working && steerReason !== undefined) {
      fail(steerReason)
      return
    }
    setText('')
    setImages([])
    setPastes([])
    setTrigger(null)
    setFailure(null)
    const watcher = { text: body, arrived: false }
    if (kind === 'steer' && working) steerWatchers.current.add(watcher)
    try {
      const result = (await context.call('quirky.structured/send', {
        session: session.id,
        text: body,
        ...(snapshot.images.length > 0 ? { images: snapshot.images.map((image) => image.path) } : {}),
        when: working ? 'idle' : 'now'
      })) as { queuedId?: string } | undefined
      draft.cleared()
      if (kind === 'steer' && working && result?.queuedId) {
        const id = result.queuedId
        if (!watcher.arrived) setSteered((current) => [...current, { id, text: body }])
        try {
          await context.call('quirky.structured/steer', { session: session.id, id })
        } catch (error) {
          setSteered((current) => current.filter((entry) => entry.id !== id))
          fail(`Could not steer: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      setText(snapshot.text)
      setImages(snapshot.images)
      setPastes(snapshot.pastes)
      fail(`Could not send: ${messageOf(error)}`, () => void submitRef.current(kind, snapshot))
    } finally {
      steerWatchers.current.delete(watcher)
    }
  }
  submitRef.current = submit

  const point = (ref: VisualRef, label: VisualLabel) => {
    rememberVisualLabel(ref, label)
    const handle = editor.current
    if (!handle) return
    const pills = parsePills(latestText.current)
    const present = pills.some(({ pill }) => pill.kind === 'visual' && pill.viewId === ref.viewId && pill.version === ref.version && pill.element === ref.element)
    if (!present) {
      // new references join the chips already at the front, so the typed text stays after them
      let at = 0
      for (const { from, to, pill } of pills) if (pill.kind === 'visual' && from === at) at = to
      handle.insertPill({ kind: 'visual', ...ref }, { from: at, to: at })
    }
    handle.focus()
  }
  const pointRef = useRef(point)
  pointRef.current = point
  useEffect(() => registerChatHandle(session.id, { point: (ref, label) => pointRef.current(ref, label) }), [session.id])

  const stop = async () => {
    try {
      await context.call('quirky.structured/interrupt', { session: session.id })
    } catch (error) {
      fail(`Could not stop: ${messageOf(error)}`)
    }
  }

  const resume = async () => {
    try {
      const resumed = (await context.call('quirky.structured/resume', { session: session.id })) as Session
      draft.carryTo(resumed.id, { text, images: images.map((image) => image.path), pastes, picks: draftPicks })
      context.openView(WORKTREE_VIEW_ID, { worktree: session.worktreeId, session: resumed.id })
    } catch (error) {
      fail(`Could not resume: ${messageOf(error)}`)
    }
  }

  const newChat = async () => {
    try {
      const created = await createChat(context, session.agent, session.worktreeId, picks)
      context.openView(WORKTREE_VIEW_ID, { worktree: session.worktreeId, session: created.id })
    } catch (error) {
      fail(`Could not start a chat: ${messageOf(error)}`)
    }
  }

  const openSettings = (target: SettingsSection) => {
    setSection(target)
    setSettingsOpen(true)
  }

  const modeOn = (mode: string) => settings.modeReasons[mode] === undefined

  const unavailable = () => settings.modeReasons.plan ?? settings.modeReason ?? 'Permission modes are unavailable'

  const togglePlan = () => {
    if (!settings.modes.includes('plan') || !modeOn('plan')) fail(unavailable())
    else if (settings.mode !== 'plan') void pick({ ...picks, mode: 'plan' })
    else void pick({ ...picks, mode: previousMode !== undefined && settings.modes.includes(previousMode) && modeOn(previousMode) ? previousMode : (settings.defaultMode ?? 'default') })
  }

  const cycleMode = () => {
    const cycle = settings.modes.filter((name) => modeOn(name) && !settings.isDangerous(name))
    if (cycle.length === 0) {
      fail(unavailable())
      return
    }
    const from = settings.modes.indexOf(settings.mode)
    const next = settings.modes.map((_, step) => settings.modes[(from + 1 + step) % settings.modes.length]!).find((name) => cycle.includes(name))
    if (next !== undefined && next !== settings.mode) void pick({ ...picks, mode: next })
  }

  const runCommand = (name: QuirkyCommandName) => {
    if (name === 'model' || name === 'effort' || name === 'mode') openSettings(name)
    else if (name === 'plan') togglePlan()
    else if (name === 'new') void newChat()
    else if (name === 'stop') void stop()
    else if (ended) void resume()
    else fail('The session has not ended')
  }

  const takeFiles = async (files: File[]) => {
    if (files.length === 0) return
    const paths = await absolutePathsOf(context, files)
    const added: Attachment[] = []
    let problem: string | null = null
    for (const [index, file] of files.entries()) {
      const path = paths[index]
      if (!isImage(file)) {
        if (path) editor.current?.insertPill({ kind: 'file', path: relativeTo(session.cwd, path) })
        else problem ??= `${file.name} has no file path`
      } else if (settings.imagesReason !== undefined) {
        problem ??= settings.imagesReason
      } else if (path) {
        added.push({ name: file.name, path, preview: previewOf(file) })
      } else if (!PASTE_MIMES.includes(file.type)) {
        problem ??= `${file.name || 'The pasted file'} is not a supported image`
      } else {
        try {
          const saved = (await context.call('quirky.session/pasteImage', { session: session.id, mime: file.type, data: await base64Of(file) })) as { path: string }
          added.push({ name: file.name || basename(saved.path), path: saved.path, preview: previewOf(file) })
        } catch (error) {
          problem ??= messageOf(error)
        }
      }
    }
    addImages(added)
    if (problem !== null) fail(problem)
  }

  const attachFromPicker = async () => {
    try {
      const picked = (await context.call('desktop.file.pick', { multiple: true, imagesOnly: true })) as { cancelled: boolean; paths: string[] }
      if (!picked.cancelled) addImages(picked.paths.map((path) => ({ name: basename(path), path })))
    } catch (error) {
      fail(`Could not attach: ${messageOf(error)}`)
    }
  }

  const onAttach = () => void attachFromPicker()

  const pullBack = async (entry: QueuedMessage) => {
    try {
      await context.call('quirky.structured/dequeue', { session: session.id, id: entry.id })
    } catch (error) {
      fail(`Could not update the queue: ${messageOf(error)}`)
      return
    }
    setText((current) => (current.trim() === '' ? entry.text : `${entry.text}\n\n${current}`))
    addImages((entry.images ?? []).map((path) => ({ name: basename(path), path })))
    editor.current?.focus()
  }

  const listKey = trigger ? `${trigger.kind}:${trigger.from}` : null
  const listOpen = trigger !== null && listKey !== dismissed
  const items: Suggestion[] = !listOpen
    ? []
    : trigger.kind === '@'
      ? fileSuggestions(search.items)
      : slashSuggestions(commands, trigger.query, agentLabel, text.slice(0, trigger.from).trim() === '')

  const choose = (item: Suggestion) => {
    if (item.source === 'file') editor.current?.insertPill({ kind: 'file', path: item.path })
    else if (item.source === 'agent') editor.current?.insertPill({ kind: 'command', name: item.name })
    else {
      if (trigger) setText(text.slice(0, trigger.from) + text.slice(trigger.to))
      setTrigger(null)
      runCommand(item.command)
    }
  }

  const navigate = (key: NavKey): boolean => {
    if (!listOpen) return false
    if (key === 'escape') {
      setDismissed(listKey)
      return true
    }
    if (items.length === 0) return false
    if (key === 'up' || key === 'down') {
      setActive((current) => (current + (key === 'down' ? 1 : -1) + items.length) % items.length)
      return true
    }
    choose(items[Math.min(active, items.length - 1)]!)
    return true
  }

  const trackTrigger = (next: Trigger | null) => {
    setTrigger(next)
    if (next === null) setDismissed(null)
    const query = next ? `${next.kind}${next.query}` : ''
    if (query !== lastQuery.current) setActive(0)
    lastQuery.current = query
  }

  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files')
  const canSend = text.trim() !== '' || pastes.length > 0 || images.length > 0
  const attachReason = settings.imagesReason ?? (filePicker ? undefined : DROP_HINT)
  const placeholder = working
    ? sendKey === 'mod-enter'
      ? 'Queue a follow-up… (Cmd+Enter queues · Shift+Cmd+Enter steers)'
      : 'Queue a follow-up… (Enter queues · Cmd+Enter steers)'
    : `Message ${agentLabel}… (/ for commands, @ for files)`

  const rows = (
    <QueuedList
      context={context}
      session={session}
      capabilities={capabilities}
      queue={queue}
      steered={steered}
      working={working}
      readOnly={ended}
      onEdit={(entry) => void pullBack(entry)}
      onSteered={(entry) => setSteered((current) => [...current, { id: entry.id, text: entry.text }])}
      onError={fail}
    />
  )
  const onRetry = failure?.retry
  const problem = failure && (
    <div style={errorBox}>
      <InlineError message={failure.message} action={onRetry ? { label: 'Retry', onAction: onRetry } : undefined} />
    </div>
  )

  if (ended) {
    return (
      <div style={outer}>
        <div style={stack}>
          {rows}
          <div style={{ ...endedCard, borderRadius: queue.length > 0 ? '0 0 var(--ui-radius-window) var(--ui-radius-window)' : 'var(--ui-radius-window)' }} role="status">
            <span style={grow}>Session ended</span>
            {capabilities?.resume.ok === true && <Button variant="primary" onClick={() => void resume()}>Resume</Button>}
            <Button onClick={() => void newChat()}>New chat</Button>
          </div>
        </div>
        {problem}
      </div>
    )
  }

  const attached = listOpen || queue.length > 0 || steered.length > 0
  const level = picks.visualLevel ?? reportedLevel ?? defaultVisualLevel(context)

  return (
    <div
      style={outer}
      onDragOver={(event) => {
        if (hasFiles(event)) event.preventDefault()
      }}
      onDrop={(event) => {
        if (event.defaultPrevented || !hasFiles(event)) return
        event.preventDefault()
        void takeFiles([...event.dataTransfer.files])
      }}
    >
      <div style={stack}>
        {listOpen ? (
          <SuggestionList
            items={items}
            active={active}
            label={trigger?.kind === '@' ? 'Files' : 'Commands'}
            empty={trigger?.kind === '@' ? 'No matching files' : `No commands match "/${trigger?.query ?? ''}". Enter sends it as text.`}
            unavailable={trigger?.kind === '@' && search.unavailable ? 'File search unavailable' : undefined}
            onPick={choose}
          />
        ) : (
          rows
        )}
        <div style={card(attached, working || focused)} onFocusCapture={() => setFocused(true)} onBlurCapture={() => setFocused(false)}>
          {(images.length > 0 || pastes.length > 0) && (
            <div style={chips} aria-label="Attachments">
              {images.map((image) =>
                image.preview ? (
                  <ImageChip key={image.path} name={image.name} preview={image.preview} onRemove={() => removeImage(image)} />
                ) : (
                  <ScopeChip key={image.path} label={image.name} removeLabel={`Remove ${image.name}`} onRemove={() => removeImage(image)} />
                )
              )}
              {pastes.map((paste) => (
                <ScopeChip
                  key={paste.id}
                  label={pasteLabel(paste.text)}
                  removeLabel="Remove pasted text"
                  onRemove={() => setPastes((current) => current.filter((existing) => existing !== paste))}
                />
              ))}
            </div>
          )}
          <div style={editorBox}>
            <ComposerEditor
              ref={editor}
              value={text}
              onChange={(value) => {
                setText(value)
                setFailure(null)
              }}
              placeholder={placeholder}
              sendKey={sendKey}
              onSubmit={(kind) => void submit(kind)}
              onTrigger={trackTrigger}
              onKeyNav={navigate}
              onEscape={() => {
                if (working) void stop()
              }}
              onCycleMode={cycleMode}
              onUpInEmpty={() => {
                const last = queue[queue.length - 1]
                if (last) void pullBack(last)
              }}
              onPasteFiles={(files) => void takeFiles(files)}
              onDropFiles={(files) => void takeFiles(files)}
              onLongPaste={(pasted) => setPastes((current) => [...current, { id: `paste-${Date.now().toString(36)}-${pasteSeq++}`, text: pasted }])}
              accessibleName="Message"
            />
          </div>
          <div style={toolbar}>
            <AgentChip session={session} />
            <SettingsChip settings={settings} picks={picks} onPicks={(next) => void pick(next)} open={settingsOpen} section={section} onOpenChange={setSettingsOpen} />
            <ModeBadges settings={settings} picks={picks} onPicks={(next) => void pick(next)} />
            <VisualDial level={level} onPick={(next) => void pick({ ...picks, visualLevel: next })} />
            <IconButton label="Attach images" style={round} disabled={attachReason !== undefined} title={attachReason ?? 'Attach images'} onClick={onAttach}>
              <ControlIcon name="plus" />
            </IconButton>
            <span style={grow} />
            {working && (
              <span style={running} role="timer" aria-label="Elapsed time">
                <StatusDot status="working" />
                Working {elapsed}
              </span>
            )}
            {working && (
              <IconButton label="Stop" variant="destructive" style={round} title="Stop (Esc)" onClick={() => void stop()}>
                <ControlIcon name="stop" />
              </IconButton>
            )}
            {(!working || canSend) && (
              <IconButton label="Send" variant="primary" style={round} disabled={!canSend} title={working ? 'Queue (Enter)' : 'Send (Enter)'} onClick={() => void submit('send')}>
                <ControlIcon name="arrow-up" />
              </IconButton>
            )}
          </div>
        </div>
      </div>
      {problem}
    </div>
  )
}
