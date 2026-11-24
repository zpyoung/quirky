import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { FileUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { OBJECTIVE_EXISTING_PLAN_MAX_LENGTH } from '../../../shared/fork-heimdall-objective/contract-types'
import type { CapabilityMode } from '../../../shared/fork-heimdall/watcher-types'

const EXISTING_PLAN_ACCEPT = '.md,.markdown,.txt,.json'
const EXISTING_PLAN_MAX_FILE_BYTES = OBJECTIVE_EXISTING_PLAN_MAX_LENGTH * 4
const EXISTING_PLAN_FILE_NAME_PATTERN = /\.(?:md|markdown|txt|json)$/iu

type ExistingPlanImportError = 'file-type' | 'file-too-large' | 'plan-too-long' | 'read-failed'

type ObjectiveExistingPlanInputProps = {
  value: string
  planMode: CapabilityMode
  disabled: boolean
  children: ReactNode
  onChange: (value: string) => void
}

function importErrorCopy(error: ExistingPlanImportError): string {
  switch (error) {
    case 'file-type':
      return translate(
        'fork.heimdallObjective.enrollment.existingPlanFileTypeError',
        'Choose a .md, .markdown, .txt, or .json file.'
      )
    case 'file-too-large':
      return translate(
        'fork.heimdallObjective.enrollment.existingPlanFileSizeError',
        'Choose a file no larger than 256 KB.'
      )
    case 'plan-too-long':
      return translate(
        'fork.heimdallObjective.enrollment.existingPlanLengthError',
        'Reduce the existing plan to 65,536 characters or fewer.'
      )
    case 'read-failed':
      return translate(
        'fork.heimdallObjective.enrollment.existingPlanReadError',
        'Quirky could not read that file. Choose another file or paste the plan.'
      )
  }
}

export function ObjectiveExistingPlanInput({
  value,
  planMode,
  disabled,
  children,
  onChange
}: ObjectiveExistingPlanInputProps): React.JSX.Element {
  const [open, setOpen] = useState(() => value.length > 0)
  const [importError, setImportError] = useState<ExistingPlanImportError | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const readGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const disabledRef = useRef(disabled)
  const onChangeRef = useRef(onChange)
  disabledRef.current = disabled
  onChangeRef.current = onChange
  const textareaId = useId()
  const descriptionId = useId()
  const errorId = useId()
  const planLength = value.trim().length
  const planTooLong = planLength > OBJECTIVE_EXISTING_PLAN_MAX_LENGTH
  const visibleError = planTooLong ? 'plan-too-long' : importError
  const hasPlan = planLength > 0

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      readGenerationRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (disabled) {
      readGenerationRef.current += 1
    }
  }, [disabled])

  const importFile = async (file: File): Promise<void> => {
    const readGeneration = readGenerationRef.current + 1
    readGenerationRef.current = readGeneration
    if (!EXISTING_PLAN_FILE_NAME_PATTERN.test(file.name)) {
      setImportError('file-type')
      return
    }
    if (file.size > EXISTING_PLAN_MAX_FILE_BYTES) {
      setImportError('file-too-large')
      return
    }

    let contents: string
    try {
      contents = await file.text()
    } catch {
      if (
        mountedRef.current &&
        !disabledRef.current &&
        readGeneration === readGenerationRef.current
      ) {
        setImportError('read-failed')
      }
      return
    }
    if (
      !mountedRef.current ||
      disabledRef.current ||
      readGeneration !== readGenerationRef.current
    ) {
      return
    }
    if (contents.trim().length > OBJECTIVE_EXISTING_PLAN_MAX_LENGTH) {
      setImportError('plan-too-long')
      return
    }

    setImportError(null)
    onChangeRef.current(contents)
    setOpen(true)
  }

  const removePlan = (): void => {
    readGenerationRef.current += 1
    setImportError(null)
    onChangeRef.current('')
    setOpen(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="min-w-0 basis-80 flex-1">{children}</div>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            disabled={disabled}
          >
            {open
              ? translate('fork.heimdallObjective.enrollment.hideExistingPlan', 'Hide plan')
              : hasPlan
                ? translate('fork.heimdallObjective.enrollment.editExistingPlan', 'Edit plan')
                : translate(
                    'fork.heimdallObjective.enrollment.addExistingPlan',
                    'Add existing plan'
                  )}
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent asChild>
        <div className="collapsible-height-content">
          <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <Label htmlFor={textareaId}>
                  {translate(
                    'fork.heimdallObjective.enrollment.existingPlanSource',
                    'Existing plan source'
                  )}
                </Label>
                <p id={descriptionId} className="text-xs text-muted-foreground">
                  {translate(
                    'fork.heimdallObjective.enrollment.existingPlanHelp',
                    'Paste or import Markdown, text, or JSON as source. The planner converts it into executable tasks; normal Plan approval rules still apply.'
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp aria-hidden className="size-3.5" />
                {translate('fork.heimdallObjective.enrollment.importExistingPlan', 'Import file')}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={EXISTING_PLAN_ACCEPT}
                className="hidden"
                disabled={disabled}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file) {
                    void importFile(file)
                  }
                }}
              />
            </div>

            <div className="font-mono">
              <Textarea
                id={textareaId}
                rows={9}
                value={value}
                disabled={disabled}
                aria-invalid={visibleError !== null}
                aria-describedby={`${descriptionId}${visibleError ? ` ${errorId}` : ''}`}
                className="max-h-72"
                placeholder={translate(
                  'fork.heimdallObjective.enrollment.existingPlanPlaceholder',
                  'Paste the plan the planner should normalize…'
                )}
                onChange={(event) => {
                  readGenerationRef.current += 1
                  setImportError(null)
                  onChangeRef.current(event.currentTarget.value)
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {translate(
                  'fork.heimdallObjective.enrollment.existingPlanCharacterCount',
                  '{{current}} / {{maximum}} characters',
                  {
                    current: planLength.toLocaleString(),
                    maximum: OBJECTIVE_EXISTING_PLAN_MAX_LENGTH.toLocaleString()
                  }
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={removePlan}
              >
                {translate('fork.heimdallObjective.enrollment.removeExistingPlan', 'Remove plan')}
              </Button>
            </div>

            {visibleError ? (
              <p id={errorId} className="text-xs text-destructive" role="alert">
                {importErrorCopy(visibleError)}
              </p>
            ) : null}
          </div>
        </div>
      </CollapsibleContent>

      {planMode === 'off' ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {translate(
            'fork.heimdallObjective.enrollment.existingPlanPlanOff',
            'Plan is Off. New objectives require Plan Gated or On unless this same workspace objective already has a usable approved plan. Existing plan source does not count as approval.'
          )}
        </p>
      ) : null}
    </Collapsible>
  )
}
