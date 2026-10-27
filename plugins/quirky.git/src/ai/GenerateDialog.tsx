import { useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Dialog } from '../panel/Dialog'
import { generators, hasCustomCommand, initialAgent, type AgentList } from './agents'
import { CUSTOM_AGENT, DEFAULT_TEMPLATE } from './types'

type Props = {
  context: UiPluginContext
  agents: AgentList | null
  onClose(): void
  /** Runs one generation with these values; nothing is saved. */
  onGenerate(choice: { agent: string; template: string }): void
}

/**
 * "Generate Commit Message": the first generation, before any recipe exists, picks the agent and
 * command template for this one run. The choice is never saved.
 */
export function GenerateDialog({ context, agents, onClose, onGenerate }: Props) {
  const choices = agents === null ? [] : generators(agents)
  const options = [...choices.map((agent) => ({ id: agent.id, label: agent.label })), ...(hasCustomCommand(context) ? [{ id: CUSTOM_AGENT, label: 'Custom command' }] : [])]
  const [agent, setAgent] = useState(() => (agents === null ? '' : initialAgent(agents, choices)) || (options[0]?.id ?? ''))
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)

  return (
    <Dialog title="Generate Commit Message" onClose={onClose}>
      <p className="muted">Choose the agent and command template for this run.</p>
      <div className="form">
        <label>
          Agent
          <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)}>
            {options.length === 0 && <option value="">No enabled agents</option>}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Command template
          <textarea
            className="scm-ai-template"
            aria-label="Command template"
            rows={6}
            spellCheck={false}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          />
        </label>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={agent === ''} onClick={() => onGenerate({ agent, template })}>
          Generate
        </button>
      </div>
    </Dialog>
  )
}
