import { useId } from 'react'
import { Button, FormRow, SelectField, TextArea, TextField } from '@quirky/ui'
import type { LoopConfig, LoopCreateInput, LoopSnapshot } from '../src/types'
import type { ConfigFieldsProps, DraftValidation, LoopDraft } from './contracts'

const PRESET_LABELS = {
  'until-done': 'Until done',
  interval: 'On an interval',
  queue: 'Queue'
} as const

const wholeNumberError = 'Enter a whole number of at least 1.'
const costError = 'Enter an amount above 0.'
const timeoutError = 'Enter 1 to 600 seconds.'
const queueError = 'Queue prompts cannot be blank.'

export function initialDraft(): LoopDraft {
  return {
    name: '',
    agent: 'claude',
    preset: 'until-done',
    prompt: '',
    queueItems: [],
    repeatQueue: false,
    pacingKind: 'on-idle',
    intervalMinutes: '30',
    anchor: 'from-end',
    sessionPolicy: 'fresh',
    maxIterations: '10',
    checkCommand: '',
    checkTimeout: '300',
    checkWhen: 'every-iteration',
    evaluatorCondition: '',
    maxActiveMinutes: '',
    maxCostUsd: '',
    protectedPaths: '',
    noProgress: true,
    checkpointCommits: false,
    askBeforeNext: false,
    resumeAtLimitReset: false,
    advanced: false
  }
}

export function draftFromLoop(loop: LoopSnapshot): LoopDraft {
  const config = loop.config
  const queueItems = loop.queueItems.map((item) => item.body)
  const check = config.done.check
  return {
    name: loop.name,
    agent: loop.agent,
    preset: loop.preset,
    prompt: config.promptSource.kind === 'repeat' ? config.promptSource.body : '',
    queueItems,
    repeatQueue: config.promptSource.kind === 'queue' ? config.promptSource.repeatQueue : false,
    pacingKind: config.pacing.kind,
    intervalMinutes: config.pacing.kind === 'interval' ? String(config.pacing.minutes) : '30',
    anchor: config.pacing.kind === 'interval' ? config.pacing.anchor : 'from-end',
    sessionPolicy: config.sessionPolicy,
    maxIterations: config.caps.maxIterations === undefined ? '' : String(config.caps.maxIterations),
    checkCommand: check?.command ?? '',
    checkTimeout: check === undefined ? '300' : String(check.timeoutSeconds),
    checkWhen: check?.runWhen ?? 'every-iteration',
    evaluatorCondition: config.done.evaluator?.condition ?? '',
    maxActiveMinutes: config.caps.maxActiveMinutes === undefined ? '' : String(config.caps.maxActiveMinutes),
    maxCostUsd: config.caps.maxCostUsd === undefined ? '' : String(config.caps.maxCostUsd),
    protectedPaths: (config.protectedPaths ?? []).join('\n'),
    noProgress: config.noProgress,
    checkpointCommits: config.checkpointCommits,
    askBeforeNext: config.askBeforeNext,
    resumeAtLimitReset: config.resumeAtLimitReset,
    advanced: false
  }
}

function parsePositiveInteger(value: string): number | undefined | null {
  if (value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && Number.isInteger(number) && number >= 1 ? number : null
}

function parsePositiveNumber(value: string): number | undefined | null {
  if (value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function firstPromptLine(draft: LoopDraft): string {
  const source = draft.preset === 'queue' ? draft.queueItems[0] ?? '' : draft.prompt
  return source.split(/\r?\n/, 1)[0]?.trim().slice(0, 48) ?? ''
}

function autoName(draft: LoopDraft): string {
  const explicit = draft.name.trim()
  return explicit || firstPromptLine(draft) || PRESET_LABELS[draft.preset]
}

export function validateDraft(
  draft: LoopDraft,
  options: { workspaceKind: 'git' | 'folder'; showCost: boolean; editing?: boolean }
): DraftValidation {
  const errors: Record<string, string> = {}
  if (draft.preset !== 'queue' && draft.prompt.trim() === '') {
    errors.prompt = 'Enter a prompt to start the loop.'
  }
  if (draft.preset === 'queue') {
    if (draft.queueItems.length === 0) errors.queueItems = 'Add at least one prompt to the queue.'
    draft.queueItems.forEach((body, index) => {
      if (body.trim() === '') errors[`queueItems.${index}`] = queueError
    })
  }

  const pacingKind = options.editing
    ? draft.pacingKind
    : draft.preset === 'interval' ? 'interval' : 'on-idle'
  if (options.editing && pacingKind !== 'on-idle' && pacingKind !== 'interval') {
    errors.pacingKind = 'Choose a pacing option.'
  }
  const usesInterval = pacingKind === 'interval'
  const intervalMinutes = usesInterval ? parsePositiveInteger(draft.intervalMinutes) : undefined
  if (usesInterval && (intervalMinutes === undefined || intervalMinutes === null)) {
    errors.intervalMinutes = wholeNumberError
  }
  const maxIterations = parsePositiveInteger(draft.maxIterations)
  if (maxIterations === null) errors.maxIterations = wholeNumberError
  const maxActiveMinutes = parsePositiveInteger(draft.maxActiveMinutes)
  if (maxActiveMinutes === null) errors.maxActiveMinutes = wholeNumberError

  const hasCheck = draft.checkCommand.trim() !== ''
  const checkTimeout = hasCheck ? parsePositiveInteger(draft.checkTimeout) : undefined
  if (hasCheck && (checkTimeout === undefined || checkTimeout === null || checkTimeout > 600)) {
    errors.checkTimeout = timeoutError
  }
  const maxCostUsd = options.showCost ? parsePositiveNumber(draft.maxCostUsd) : undefined
  if (options.showCost && maxCostUsd === null) errors.maxCostUsd = costError

  if (draft.agent !== 'claude' && draft.agent !== 'codex') errors.agent = 'Choose an installed Claude or Codex agent.'
  if (!['until-done', 'interval', 'queue'].includes(draft.preset)) errors.preset = 'Choose a loop preset.'

  if (Object.keys(errors).length > 0) return { errors, config: null, input: null }

  const promptSource: LoopConfig['promptSource'] = draft.preset === 'queue'
    ? { kind: 'queue', repeatQueue: draft.repeatQueue }
    : { kind: 'repeat', body: draft.prompt }
  const pacing: LoopConfig['pacing'] = usesInterval && typeof intervalMinutes === 'number'
    ? { kind: 'interval', minutes: intervalMinutes, anchor: draft.anchor }
    : { kind: 'on-idle' }
  const check = hasCheck && typeof checkTimeout === 'number'
    ? { command: draft.checkCommand, timeoutSeconds: checkTimeout, runWhen: draft.checkWhen }
    : undefined
  const evaluator = draft.evaluatorCondition.trim() === '' ? undefined : { condition: draft.evaluatorCondition }
  const protectedPaths = draft.protectedPaths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean)
  const capIterations = typeof maxIterations === 'number' ? maxIterations : undefined
  const activeMinutes = typeof maxActiveMinutes === 'number' ? maxActiveMinutes : undefined
  const costUsd = typeof maxCostUsd === 'number' ? maxCostUsd : undefined
  const config: LoopConfig = {
    promptSource,
    pacing,
    sessionPolicy: draft.sessionPolicy,
    done: {
      ...(check === undefined ? {} : { check }),
      ...(evaluator === undefined ? {} : { evaluator })
    },
    caps: {
      ...(capIterations === undefined ? {} : { maxIterations: capIterations }),
      ...(activeMinutes === undefined ? {} : { maxActiveMinutes: activeMinutes }),
      ...(costUsd === undefined ? {} : { maxCostUsd: costUsd })
    },
    noProgress: draft.noProgress,
    ...(protectedPaths.length === 0 ? {} : { protectedPaths }),
    checkpointCommits: options.workspaceKind === 'git' && draft.checkpointCommits,
    askBeforeNext: draft.askBeforeNext,
    resumeAtLimitReset: draft.resumeAtLimitReset
  }
  const input: Omit<LoopCreateInput, 'worktree' | 'worktreeId'> = {
    name: autoName(draft),
    agent: draft.agent,
    preset: draft.preset,
    config,
    ...(draft.preset === 'queue' ? { queueItems: draft.queueItems.map((body) => ({ body })) } : {})
  }
  return {
    errors,
    config,
    input: options.editing ? null : input
  }
}

export function ConfigFields(props: ConfigFieldsProps) {
  const checkboxId = useId()
  const { draft, onChange, errors, workspaceKind, showCost, editing, disabled } = props
  const isDisabled = disabled === true
  return (
    <section className="ui-stack" aria-label="Loop settings">
      {editing ? (
        <SelectField
          label="Pacing"
          aria-label="Pacing"
          value={draft.pacingKind}
          disabled={isDisabled}
          onChange={(event) => onChange({ pacingKind: event.currentTarget.value as LoopDraft['pacingKind'] })}
        >
          <option value="on-idle">As soon as the agent is idle</option>
          <option value="interval">On an interval</option>
        </SelectField>
      ) : (
        <SelectField
          label="Run"
          aria-label="Run"
          value={draft.preset}
          disabled={isDisabled}
          onChange={(event) => onChange({ preset: event.currentTarget.value as LoopDraft['preset'] })}
        >
          <option value="until-done">Until done</option>
          <option value="interval">On an interval</option>
          <option value="queue">Queue</option>
        </SelectField>
      )}
      {(editing ? draft.pacingKind === 'interval' : draft.preset === 'interval') && (
        <div className="ui-stack">
          <TextField
            label="Run every (minutes)"
            aria-label="Run every (minutes)"
            type="text"
            inputMode="numeric"
            value={draft.intervalMinutes}
            disabled={isDisabled}
            error={errors.intervalMinutes}
            onChange={(event) => onChange({ intervalMinutes: event.currentTarget.value })}
          />
          <SelectField
            label="Counted from"
            aria-label="Counted from"
            value={draft.anchor}
            disabled={isDisabled}
            onChange={(event) => onChange({ anchor: event.currentTarget.value as LoopDraft['anchor'] })}
          >
            <option value="from-end">End of the last iteration</option>
            <option value="wall-clock">The clock</option>
          </SelectField>
        </div>
      )}
      <SelectField
        label="Session"
        aria-label="Session"
        value={draft.sessionPolicy}
        disabled={isDisabled}
        onChange={(event) => onChange({ sessionPolicy: event.currentTarget.value as LoopDraft['sessionPolicy'] })}
      >
        <option value="fresh">Fresh</option>
        <option value="continue">Continue</option>
      </SelectField>
      {editing && draft.preset === 'queue' && (
        <FormRow label="Start over when the queue is empty" htmlFor={`${checkboxId}-repeat-queue`}>
          <input
            id={`${checkboxId}-repeat-queue`}
            type="checkbox"
            checked={draft.repeatQueue}
            disabled={isDisabled}
            onChange={(event) => onChange({ repeatQueue: event.currentTarget.checked })}
          />
        </FormRow>
      )}
      <TextField
        label="Maximum iterations"
        aria-label="Maximum iterations"
        type="text"
        inputMode="numeric"
        value={draft.maxIterations}
        disabled={isDisabled}
        error={errors.maxIterations}
        onChange={(event) => onChange({ maxIterations: event.currentTarget.value })}
      />
      <Button
        aria-expanded={draft.advanced}
        disabled={isDisabled}
        onClick={() => onChange({ advanced: !draft.advanced })}
      >
        <span aria-hidden="true">{draft.advanced ? '▾' : '▸'}</span> Advanced
      </Button>
      {draft.advanced && (
        <div className="ui-stack">
          <TextField
            label="Done check command"
            aria-label="Done check command"
            type="text"
            value={draft.checkCommand}
            placeholder="Runs in the workspace. Exit code 0 means the work is done."
            disabled={isDisabled}
            onChange={(event) => onChange({ checkCommand: event.currentTarget.value })}
          />
          {draft.checkCommand.trim() !== '' && (
            <div className="ui-stack">
              <TextField
                label="Check timeout (seconds)"
                aria-label="Check timeout (seconds)"
                type="text"
                inputMode="numeric"
                value={draft.checkTimeout}
                disabled={isDisabled}
                error={errors.checkTimeout}
                onChange={(event) => onChange({ checkTimeout: event.currentTarget.value })}
              />
              <SelectField
                label="Run the check"
                aria-label="Run the check"
                value={draft.checkWhen}
                disabled={isDisabled}
                onChange={(event) => onChange({ checkWhen: event.currentTarget.value as LoopDraft['checkWhen'] })}
              >
                <option value="every-iteration">After every iteration</option>
                <option value="on-claim">When the agent says it is done</option>
              </SelectField>
            </div>
          )}
          <TextArea
            label="Done condition"
            aria-label="Done condition"
            value={draft.evaluatorCondition}
            placeholder="A second agent reads the changes and judges whether this is true."
            rows={2}
            disabled={isDisabled}
            onChange={(event) => onChange({ evaluatorCondition: event.currentTarget.value })}
          />
          <TextField
            label="Maximum active minutes"
            aria-label="Maximum active minutes"
            type="text"
            inputMode="numeric"
            value={draft.maxActiveMinutes}
            disabled={isDisabled}
            error={errors.maxActiveMinutes}
            onChange={(event) => onChange({ maxActiveMinutes: event.currentTarget.value })}
          />
          {showCost && (
            <TextField
              label="Maximum cost (USD)"
              aria-label="Maximum cost (USD)"
              type="text"
              inputMode="decimal"
              value={draft.maxCostUsd}
              disabled={isDisabled}
              error={errors.maxCostUsd}
              onChange={(event) => onChange({ maxCostUsd: event.currentTarget.value })}
            />
          )}
          <TextArea
            label="Protected paths"
            aria-label="Protected paths"
            value={draft.protectedPaths}
            placeholder="One path or glob per line"
            rows={2}
            disabled={isDisabled}
            onChange={(event) => onChange({ protectedPaths: event.currentTarget.value })}
          />
          <FormRow label="Pause after 3 iterations with no changes" htmlFor={`${checkboxId}-no-progress`}>
            <input
              id={`${checkboxId}-no-progress`}
              type="checkbox"
              checked={draft.noProgress}
              disabled={isDisabled}
              onChange={(event) => onChange({ noProgress: event.currentTarget.checked })}
            />
          </FormRow>
          {workspaceKind === 'git' && (
            <FormRow label="Commit a checkpoint after each iteration" htmlFor={`${checkboxId}-checkpoint-commits`}>
              <input
                id={`${checkboxId}-checkpoint-commits`}
                type="checkbox"
                checked={draft.checkpointCommits}
                disabled={isDisabled}
                onChange={(event) => onChange({ checkpointCommits: event.currentTarget.checked })}
              />
            </FormRow>
          )}
          <FormRow label="Ask before each new iteration" htmlFor={`${checkboxId}-ask-before-next`}>
            <input
              id={`${checkboxId}-ask-before-next`}
              type="checkbox"
              checked={draft.askBeforeNext}
              disabled={isDisabled}
              onChange={(event) => onChange({ askBeforeNext: event.currentTarget.checked })}
            />
          </FormRow>
          <FormRow label="Resume when the usage limit resets" htmlFor={`${checkboxId}-resume-at-limit-reset`}>
            <input
              id={`${checkboxId}-resume-at-limit-reset`}
              type="checkbox"
              checked={draft.resumeAtLimitReset}
              disabled={isDisabled}
              onChange={(event) => onChange({ resumeAtLimitReset: event.currentTarget.checked })}
            />
          </FormRow>
        </div>
      )}
    </section>
  )
}
