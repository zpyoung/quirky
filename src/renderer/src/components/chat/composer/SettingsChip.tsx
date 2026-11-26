import { translate } from '@/i18n/i18n'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { Check, ChevronDown, ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { SessionOptionDescriptor } from '../../../../../shared/native-chat-session-options'
import type { ComposerSettings } from './composer-types'
import {
  disabledReasonText,
  planModeActive,
  settingDescriptors,
  settingsSummary,
  visibleChoices
} from './settings-options'

/** Which option a `/model`, `/effort` or `/mode` command wants the chip to open on. */
export type SettingsSection = 'model' | 'effort' | 'permissionMode'

/**
 * The chip under the editor: the model and effort in force, opening a list of every option the agent
 * lets this session change. Plan mode is listed only when `planModeAvailable`, and a control the
 * session cannot change right now stays visible with the reason.
 */
export function SettingsChip({
  settings,
  planModeAvailable,
  open,
  onOpenChange,
  section,
  onTogglePlan
}: {
  settings: ComposerSettings
  planModeAvailable: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  section: SettingsSection | null
  onTogglePlan: () => void
}): React.JSX.Element | null {
  const { surface } = settings
  const subscribe = useCallback(
    (onChange: () => void) => surface.subscribe(() => onChange()),
    [surface]
  )
  const snapshot = useSyncExternalStore(subscribe, () => surface.getSnapshot())
  const descriptors = settingDescriptors(snapshot)
  const content = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || section === null) {
      return
    }
    const target = content.current?.querySelector<HTMLElement>(
      `[data-option="${section}"] [aria-checked="true"], [data-option="${section}"] [role="radio"]`
    )
    target?.focus()
  }, [open, section])

  if (descriptors.length === 0 && !planModeAvailable) {
    return null
  }
  const planOn = planModeActive(snapshot)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={translate(
            'components.chat.composer.sessionSettings',
            'Session settings: {{summary}}',
            { summary: settingsSummary(snapshot) }
          )}
          className="max-w-56 min-w-0 shrink"
        >
          <span className="truncate">{settingsSummary(snapshot)}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent ref={content} align="start" side="top" collisionPadding={8} wheelScroll>
        <div className="scrollbar-sleek flex max-h-80 flex-col overflow-y-auto">
          {planModeAvailable ? (
            <button
              type="button"
              role="switch"
              aria-checked={planOn}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={onTogglePlan}
            >
              <ClipboardList className="size-3.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {translate('components.chat.composer.planMode', 'Plan mode')}
              </span>
              <span className="text-xs text-muted-foreground">
                {planOn
                  ? translate('components.chat.composer.planModeOn', 'On')
                  : translate('components.chat.composer.planModeOff', 'Off')}
              </span>
            </button>
          ) : null}
          {descriptors.map((descriptor) => (
            <OptionGroup
              key={descriptor.id}
              descriptor={descriptor}
              onPick={(value) => void settings.setOption(descriptor.id, value)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function OptionGroup({
  descriptor,
  onPick
}: {
  descriptor: SessionOptionDescriptor
  onPick: (value: string | boolean) => void
}): React.JSX.Element | null {
  const reason = descriptor.settable ? undefined : disabledReasonText(descriptor.disabledReason)
  if (descriptor.kind.type === 'boolean') {
    return (
      <div data-option={descriptor.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
        <span className="flex-1">{descriptor.label}</span>
        <Switch
          aria-label={descriptor.label}
          checked={descriptor.kind.currentValue}
          disabled={!descriptor.settable}
          title={reason}
          onCheckedChange={onPick}
        />
      </div>
    )
  }
  const choices = visibleChoices(descriptor)
  if (choices.length === 0) {
    return null
  }
  return (
    <div data-option={descriptor.id} role="radiogroup" aria-label={descriptor.label}>
      <p className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground" title={reason}>
        {descriptor.label}
      </p>
      {choices.map((choice) => {
        const checked =
          descriptor.kind.type === 'select' && descriptor.kind.currentValue === choice.value
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!descriptor.settable}
            title={reason ?? choice.description}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'
            )}
            onClick={() => onPick(choice.value)}
          >
            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
            {checked ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
          </button>
        )
      })}
    </div>
  )
}
