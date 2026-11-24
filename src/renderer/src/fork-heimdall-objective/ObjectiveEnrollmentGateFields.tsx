import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  OBJECTIVE_GATES_MAX,
  OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS
} from '../../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentFieldHelp, objectiveGatesHelp } from './ObjectiveEnrollmentFieldHelp'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  ObjectiveEnrollmentDraft,
  ObjectiveEnrollmentGateDraft
} from './objective-enrollment-model'

function GateRow({
  gate,
  index,
  disabled,
  parallelUnsupported,
  onChange,
  onRemove
}: {
  gate: ObjectiveEnrollmentGateDraft
  index: number
  disabled: boolean
  parallelUnsupported: boolean
  onChange: (gate: ObjectiveEnrollmentGateDraft) => void
  onRemove: () => void
}): React.JSX.Element {
  const nameId = useId()
  const commandId = useId()
  const timeoutId = useId()
  // rows stay removable on an unsupported host so declared-but-unusable gates can be cleared
  const fieldsDisabled = disabled || parallelUnsupported

  return (
    <div className="grid grid-cols-[1fr_1fr_96px_auto] items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor={nameId}>
          {translate('fork.heimdallObjective.enrollment.gateName', 'Name')}
        </Label>
        <Input
          id={nameId}
          value={gate.name}
          disabled={fieldsDisabled}
          placeholder={translate('fork.heimdallObjective.enrollment.gateNamePlaceholder', 'lint')}
          onChange={(event) => onChange({ ...gate, name: event.currentTarget.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={commandId}>
          {translate('fork.heimdallObjective.enrollment.gateCommand', 'Command')}
        </Label>
        <Input
          id={commandId}
          value={gate.command}
          disabled={fieldsDisabled}
          onChange={(event) => onChange({ ...gate, command: event.currentTarget.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={timeoutId}>
          {translate('fork.heimdallObjective.enrollment.gateTimeout', 'Timeout (s)')}
        </Label>
        <Input
          id={timeoutId}
          type="number"
          min="10"
          max="14400"
          step="1"
          value={gate.timeoutSecondsText}
          disabled={fieldsDisabled}
          placeholder={String(OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS)}
          onChange={(event) => onChange({ ...gate, timeoutSecondsText: event.currentTarget.value })}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={translate('fork.heimdallObjective.enrollment.removeGate', 'Remove gate {{n}}', {
          n: index + 1
        })}
        onClick={onRemove}
      >
        <Trash2 aria-hidden className="size-3.5" />
      </Button>
    </div>
  )
}

export function ObjectiveEnrollmentGateFields({
  draft,
  disabled,
  parallelUnsupported,
  onDraftChange
}: {
  draft: ObjectiveEnrollmentDraft
  disabled: boolean
  parallelUnsupported: boolean
  onDraftChange: (draft: ObjectiveEnrollmentDraft) => void
}): React.JSX.Element {
  const atMax = draft.gates.length >= OBJECTIVE_GATES_MAX

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('fork.heimdallObjective.enrollment.gates', 'Gates')}
        </h3>
        <ObjectiveEnrollmentFieldHelp {...objectiveGatesHelp()} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'fork.heimdallObjective.enrollment.gatesHelpLine',
          'Gates run on the integrated branch after every plan node has merged, before review and landing. Put the full test suite and other whole-tree checks here, not in plan nodes.'
        )}
      </p>
      {parallelUnsupported ? (
        <p className="text-[11px] text-destructive" role="status">
          {translate(
            'fork.heimdallObjective.enrollment.gatesUnsupportedHost',
            "Gates are unavailable on this host's Quirky version. Remove any gates below to continue."
          )}
        </p>
      ) : null}
      {draft.gates.map((gate, index) => (
        <GateRow
          key={gate.rowKey}
          gate={gate}
          index={index}
          disabled={disabled}
          parallelUnsupported={parallelUnsupported}
          onChange={(next) =>
            onDraftChange({
              ...draft,
              gates: draft.gates.map((current, currentIndex) =>
                currentIndex === index ? next : current
              )
            })
          }
          onRemove={() =>
            onDraftChange({
              ...draft,
              gates: draft.gates.filter((_gate, currentIndex) => currentIndex !== index)
            })
          }
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || atMax || parallelUnsupported}
        onClick={() =>
          onDraftChange({
            ...draft,
            gates: [
              ...draft.gates,
              { rowKey: createBrowserUuid(), name: '', command: '', timeoutSecondsText: '' }
            ]
          })
        }
      >
        <Plus aria-hidden className="size-3.5" />
        {translate('fork.heimdallObjective.enrollment.addGate', 'Add gate')}
      </Button>
    </section>
  )
}
