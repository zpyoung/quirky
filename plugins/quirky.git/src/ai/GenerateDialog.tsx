import { useId, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, Dialog, EmptyState, FormRow, InlineError, NoticeLine } from '@quirky/ui'
import { generators, hasCustomCommand, initialAgent, type Agents } from './agents'
import { CUSTOM_AGENT, DEFAULT_TEMPLATE } from './types'

type Props = {
  context: UiPluginContext
  agents: Agents
  onClose(): void
  /** Runs one generation with these values; nothing is saved. */
  onGenerate(choice: { agent: string; template: string }): void
}

/**
 * "Generate Commit Message", opened from the ✦ menu's "Choose agent…": picks the agent and
 * command template for this one run. The choice is never saved.
 */
export function GenerateDialog({ context, agents, onClose, onGenerate }: Props) {
  const choices = agents.list === null ? [] : generators(agents.list)
  const options = [...choices.map((agent) => ({ id: agent.id, label: agent.label })), ...(hasCustomCommand(context) ? [{ id: CUSTOM_AGENT, label: 'Custom command' }] : [])]
  const [picked, setPicked] = useState<string | null>(null)
  const agent = picked ?? ((agents.list === null ? '' : initialAgent(agents.list, choices)) || (options[0]?.id ?? ''))
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  const agentId = useId()
  const templateId = useId()

  return (
    <Dialog
      open
      title="Generate Commit Message"
      onClose={onClose}
      actions={
        <>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" disabled={agent === ''} onClick={() => onGenerate({ agent, template })}>
            Generate
          </Button>
        </>
      }
    >
      <div className="ui-stack">
        <p className="ui-text-muted">Choose the agent and command template for this run.</p>
        {agents.error !== null && (
          <InlineError message={`Could not read the agents: ${agents.error}`} action={{ label: 'Retry', onAction: agents.retry }} />
        )}
        {!agents.settled && <div role="status"><NoticeLine>Detecting agents...</NoticeLine></div>}
        {agents.settled && agents.error === null && options.length === 0 && <EmptyState message="No enabled agents" />}
        {options.length > 0 && (
          <FormRow label="Agent" htmlFor={agentId}>
            <select
              id={agentId}
              className="ui-text-field__input"
              aria-label="Agent"
              value={agent}
              onChange={(event) => setPicked(event.target.value)}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormRow>
        )}
        <FormRow label="Command template" htmlFor={templateId}>
          <textarea
            id={templateId}
            className="ui-text-field__input"
            aria-label="Command template"
            rows={6}
            spellCheck={false}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          />
        </FormRow>
      </div>
    </Dialog>
  )
}
