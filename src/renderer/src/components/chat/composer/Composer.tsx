import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { cn } from '@/lib/utils'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { AttachButton, SendButton, StopButton } from './controls'
import { ComposerEditor } from './editor/ComposerEditor'
import type { ComposerEditorHandle, NavKey, Trigger } from './editor/types'
import { useComposerDraftText } from './composer-draft'
import type { LocalCommandName, ComposerCommand } from './composer-commands'
import type { ComposerHandle, ComposerProps, ComposerSettings } from './composer-types'
import { ImageChip } from './ImageChip'
import { useFileSearch } from './Mentions'
import { QueuedList } from './QueuedList'
import { SettingsChip, type SettingsSection } from './SettingsChip'
import {
  fileSuggestions,
  slashSuggestions,
  SuggestionList,
  type Suggestion
} from './SuggestionList'
import {
  modeAfterPlan,
  PLAN_MODE_VALUE,
  permissionModeDescriptor,
  planModeActive
} from './settings-options'
import { useComposerAttachments } from './use-composer-attachments'
import './composer.css'

const NO_COMMANDS: readonly ComposerCommand[] = []
const NO_WORKSPACE = { terminalTabId: '' } as const
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The CodeMirror message composer, in two modes. `chat` is the structured chat's: the queue above the
 * card, the settings chip, plan mode where the session has one, and Stop while the agent works. `terminal`
 * is the dock under an agent terminal: the same editor, pills, suggestions and attachments, with no
 * queue, settings or plan controls, and sends held while `quarantined`.
 *
 * Enter sends, Shift+Enter inserts a newline, and neither acts while an IME composition is live. The
 * draft lives in the shared draft store under `draftScopeKey` and is cleared only once `onSubmit`
 * does not answer `false`.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  return <ComposerPane key={props.draftScopeKey} {...props} ref={ref} />
})

const ComposerPane = forwardRef<ComposerHandle, ComposerProps>(function ComposerPane(
  {
    mode,
    onSubmit,
    queue,
    settings,
    draftScopeKey,
    disabled = false,
    acceptsImages,
    commands = NO_COMMANDS,
    onRunCommand,
    planModeAvailable = false,
    autoFocus = false,
    working = false,
    canStop = false,
    onStop,
    quarantined = false,
    quarantineReason = 'Input is paused while the terminal reconnects.',
    queueMove,
    workspace,
    sendKey = 'enter',
    agentLabel = 'the agent'
  },
  ref
) {
  const chat = mode === 'chat'
  const imagesOn = acceptsImages !== false
  const ime = useImeEnterGestureOwnership()
  const editor = useRef<ComposerEditorHandle>(null)
  const { text, setText, subscribe } = useComposerDraftText(draftScopeKey)
  const initialText = useRef(text)
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [notice, setNoticeText] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [section, setSection] = useState<SettingsSection | null>(null)
  const [focused, setFocused] = useState(false)
  const lastQuery = useRef('')
  const submitting = useRef(false)
  const previousMode = useRef<string | boolean | null>(null)
  const setNotice = useCallback((next: string | null) => setNoticeText(next), [])

  const replaceText = useCallback(
    (next: string) => {
      editor.current?.setValue(next)
      setText(next)
    },
    [setText]
  )
  const attachments = useComposerAttachments({
    scopeKey: draftScopeKey,
    mode,
    workspace,
    acceptsImages: imagesOn,
    disabled,
    ime,
    editor,
    replaceText,
    setNotice
  })
  const { images } = attachments

  // a queued-message edit or a reload changes the draft from outside the editor
  const syncFromStore = useCallback(() => {
    editor.current?.setValue(readNativeChatComposerDraft(draftScopeKey).text)
  }, [draftScopeKey])
  useEffect(() => subscribe(syncFromStore), [subscribe, syncFromStore])

  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), [])

  useEffect(() => {
    if (autoFocus) {
      editor.current?.focus()
    }
  }, [autoFocus])
  useEffect(() => {
    if (!autoFocus) {
      return
    }
    // a window that regains focus lands on the body, never on the docked composer
    const refocus = () => {
      const current = document.activeElement
      if (!current || current === document.body) {
        editor.current?.focus()
      }
    }
    window.addEventListener('focus', refocus)
    return () => window.removeEventListener('focus', refocus)
  }, [autoFocus])

  const search = useFileSearch(
    workspace ?? NO_WORKSPACE,
    workspace !== undefined && trigger?.kind === '@' ? trigger.query : null
  )

  const togglePlan = useCallback(() => {
    if (!settings || !planModeAvailable) {
      return
    }
    const snapshot = settings.surface.getSnapshot()
    const modeOption = permissionModeDescriptor(snapshot)
    if (modeOption?.kind.type !== 'select' || !modeOption.settable) {
      setNotice('Plan mode is not available right now.')
      return
    }
    if (planModeActive(snapshot)) {
      const back = modeAfterPlan(snapshot, previousMode.current)
      if (back !== null) {
        void settings.setOption(modeOption.id, back)
      }
      return
    }
    previousMode.current = modeOption.kind.currentValue ?? null
    void settings.setOption(modeOption.id, PLAN_MODE_VALUE).then((applied) => {
      if (!applied) {
        setNotice('Plan mode is not available right now.')
      }
    })
  }, [planModeAvailable, setNotice, settings])

  const cycleMode = useCallback(
    (target: ComposerSettings) => {
      const modeOption = permissionModeDescriptor(target.surface.getSnapshot())
      if (modeOption?.kind.type !== 'select' || !modeOption.settable) {
        setNotice('Permission modes are not available right now.')
        return
      }
      const current = modeOption.kind.currentValue
      const cycle = modeOption.kind.choices.filter(
        (choice) => choice.value !== 'full-access' && choice.value !== PLAN_MODE_VALUE
      )
      const from = cycle.findIndex((choice) => choice.value === current)
      const next = cycle[(from + 1) % cycle.length]
      if (next && next.value !== current) {
        void target.setOption(modeOption.id, next.value)
      }
    },
    [setNotice]
  )

  const stop = useCallback(() => {
    if (working && canStop) {
      onStop?.()
    }
  }, [canStop, onStop, working])

  const submit = async (kind: 'send' | 'steer') => {
    if (disabled || quarantined || submitting.current) {
      return
    }
    const value = editor.current?.getValue() ?? ''
    const empty = value.trim() === '' && images.length === 0
    if (kind === 'steer' && empty && queue?.steerNewest()) {
      return
    }
    if (images.some((image) => image.pending)) {
      setNotice('Wait for the attachment to finish uploading.')
      return
    }
    const unavailable = images.find((image) => image.unavailableName !== undefined)
    if (unavailable) {
      setNotice(`Attach ${unavailable.unavailableName} again before sending.`)
      return
    }
    const attached = images.map(({ path, connectionId }) => ({
      path,
      previewUri: path,
      ...(connectionId ? { connectionId } : {})
    }))
    if (value.trim() === '' && attached.length === 0) {
      return
    }
    const submitted = readNativeChatComposerDraft(draftScopeKey)
    submitting.current = true
    try {
      const result = await onSubmit(value, attached)
      if (result !== false) {
        setNotice(null)
        setTrigger(null)
        clearNativeChatComposerDraftIfUnchanged(draftScopeKey, submitted)
      }
    } catch (error) {
      setNotice(`Could not send: ${messageOf(error)}`)
    } finally {
      submitting.current = false
    }
  }

  const openSettings = (target: SettingsSection) => {
    setSection(target)
    setSettingsOpen(true)
  }

  const localCommands = useMemo(() => {
    const available = new Set<LocalCommandName>()
    if (chat && settings) {
      available.add('model').add('effort').add('mode')
    }
    if (chat && settings && planModeAvailable) {
      available.add('plan')
    }
    if (chat && working && canStop && onStop) {
      available.add('stop')
    }
    return available
  }, [canStop, chat, onStop, planModeAvailable, settings, working])
  const slashCommands = useMemo(
    () => commands.filter((command) => command.kind !== 'host' || onRunCommand !== undefined),
    [commands, onRunCommand]
  )

  const listKey = trigger ? `${trigger.kind}:${trigger.from}` : null
  const listOpen = trigger !== null && listKey !== dismissed
  const items: Suggestion[] = !listOpen
    ? []
    : trigger.kind === '@'
      ? workspace
        ? fileSuggestions(search.items)
        : []
      : slashSuggestions(slashCommands, trigger.query, localCommands)

  const dropTrigger = () => {
    if (!trigger) {
      return
    }
    const value = editor.current?.getValue() ?? text
    replaceText(value.slice(0, trigger.from) + value.slice(trigger.to))
    setTrigger(null)
  }

  const choose = (item: Suggestion) => {
    if (item.source === 'file') {
      editor.current?.insertPill({ kind: 'file', path: item.path })
      return
    }
    if (item.source === 'agent') {
      editor.current?.insertPill({ kind: 'command', name: item.name })
      return
    }
    dropTrigger()
    if (item.source === 'host') {
      onRunCommand?.(item.command)
    } else if (item.command === 'plan') {
      togglePlan()
    } else if (item.command === 'stop') {
      stop()
    } else {
      openSettings(item.command === 'mode' ? 'permissionMode' : item.command)
    }
    editor.current?.focus()
  }

  const navigate = (key: NavKey): boolean => {
    if (!listOpen) {
      return false
    }
    if (key === 'escape') {
      setDismissed(listKey)
      return true
    }
    if (items.length === 0) {
      return false
    }
    if (key === 'up' || key === 'down') {
      setActive((current) => (current + (key === 'down' ? 1 : -1) + items.length) % items.length)
      return true
    }
    const picked = items[Math.min(active, items.length - 1)]
    if (picked) {
      choose(picked)
    }
    return true
  }

  const trackTrigger = (next: Trigger | null) => {
    setTrigger(next)
    if (next === null) {
      setDismissed(null)
    }
    const query = next ? `${next.kind}${next.query}` : ''
    if (query !== lastQuery.current) {
      setActive(0)
    }
    lastQuery.current = query
  }

  const sendHeld = quarantined || disabled
  const canSend = text.trim() !== '' || images.length > 0
  const attached = listOpen || (chat && (queue?.cards.length ?? 0) > 0)
  const placeholder = working
    ? sendKey === 'mod-enter'
      ? 'Queue a follow-up… (Cmd+Enter queues, Shift+Cmd+Enter steers)'
      : 'Queue a follow-up… (Enter queues, Cmd+Enter steers)'
    : `Message ${agentLabel}… (/ for commands${workspace ? ', @ for files' : ''})`

  const lastQueued = queue?.cards.at(-1)

  return (
    <div className={cn(chat ? 'bg-chat-canvas px-3 pt-2 pb-4 sm:px-4' : 'p-1.5')}>
      <div className="mx-auto flex w-full max-w-(--chat-content-max-width) min-w-0 flex-col">
        {listOpen ? (
          <SuggestionList
            items={items}
            active={active}
            label={trigger?.kind === '@' ? 'Files' : 'Commands'}
            empty={
              trigger?.kind === '@'
                ? 'No matching files'
                : `No commands match "/${trigger?.query ?? ''}". Enter sends it as text.`
            }
            {...(trigger?.kind === '@' && search.unavailable
              ? { unavailable: 'File search unavailable' }
              : {})}
            onPick={choose}
          />
        ) : chat && queue ? (
          <QueuedList queue={queue} working={working} {...(queueMove ? { move: queueMove } : {})} />
        ) : null}
        <div
          className={cn(
            'flex min-w-0 flex-col gap-1.5 border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs',
            attached ? 'rounded-b-xl rounded-t-none' : 'rounded-xl',
            (focused || working) && 'border-ring'
          )}
          data-composer-mode={mode}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
        >
          {imagesOn && images.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Attachments">
              {images.map((image) => (
                <ImageChip
                  key={image.id}
                  name={
                    image.pending
                      ? (image.pendingName ?? 'Saving image…')
                      : (image.unavailableName ?? image.path.slice(image.path.lastIndexOf('/') + 1))
                  }
                  {...(image.previewUrl ? { preview: image.previewUrl } : {})}
                  pending={image.pending === true}
                  onRemove={() => attachments.removeImage(image.id)}
                />
              ))}
            </div>
          ) : null}
          <div className="min-w-0 px-1">
            <ComposerEditor
              ref={editor}
              initialValue={initialText.current}
              onChange={(value) => {
                setText(value)
                setNotice(null)
              }}
              placeholder={placeholder}
              disabled={disabled}
              sendKey={sendKey}
              ime={ime}
              onSubmit={(kind) => void submit(kind)}
              onTrigger={trackTrigger}
              onKeyNav={navigate}
              {...(working && canStop ? { onEscape: stop } : {})}
              {...(chat && settings ? { onCycleMode: () => cycleMode(settings) } : {})}
              {...(chat && queue && lastQueued && queue.editCapable && !lastQueued.command
                ? { onUpInEmpty: () => void queue.edit(lastQueued.messageId) }
                : {})}
              onPaste={attachments.takePaste}
              onCompositionSettled={() => {
                attachments.flushPendingAttachments()
                syncFromStore()
              }}
              accessibleName="Message"
            />
          </div>
          {quarantined ? (
            <p role="status" className="px-1 text-xs text-status-warning">
              {quarantineReason}
            </p>
          ) : null}
          {notice ? (
            <p role="alert" className="px-1 text-xs text-destructive">
              {notice}
            </p>
          ) : null}
          <div className="flex shrink-0 items-center gap-1" data-composer-toolbar="">
            {workspace ? (
              <AttachButton disabled={disabled} onAttach={attachments.pickAttachments} />
            ) : null}
            {chat && settings ? (
              <SettingsChip
                settings={settings}
                planModeAvailable={planModeAvailable}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                section={section}
                onTogglePlan={togglePlan}
              />
            ) : null}
            <span className="flex-1" />
            {chat && working && canStop ? <StopButton onStop={stop} /> : null}
            <SendButton
              disabled={sendHeld || !canSend}
              title={quarantined ? quarantineReason : working ? 'Queue (Enter)' : 'Send (Enter)'}
              onSend={() => void submit('send')}
            />
          </div>
        </div>
      </div>
    </div>
  )
})
