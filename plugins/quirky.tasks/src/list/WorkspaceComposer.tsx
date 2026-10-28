import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, FormRow, TextField } from '@quirky/ui'
import type { TasksSurfaceProps, ItemTarget, WorkspaceComposerRequest } from '../contracts'

type WorkspaceComposerState = { open: boolean; request: WorkspaceComposerRequest | null; busy: boolean; error: string | null }
type WorkspaceComposerProps = TasksSurfaceProps & { report?(state: WorkspaceComposerState): void }
type SetupChoice = WorkspaceComposerRequest['setup']
type IssueCommandChoice = NonNullable<WorkspaceComposerRequest['issueCommand']>
type AgentOption = { id: string; label: string }
type AgentSelection = { options: AgentOption[]; defaultAgent: string | null }
type ConsentAction = { kind: 'setup' | 'issue'; choice: 'run' | 'skip' }

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseTarget(value: unknown): ItemTarget | null {
  const raw = object(value)
  if (!raw || typeof raw.worktree !== 'string' || typeof raw.number !== 'number' || (raw.kind !== 'issue' && raw.kind !== 'pullRequest')) return null
  return {
    worktree: raw.worktree,
    kind: raw.kind,
    number: raw.number,
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(typeof raw.host === 'string' ? { host: raw.host } : {}),
    ...(typeof raw.owner === 'string' ? { owner: raw.owner } : {}),
    ...(typeof raw.repo === 'string' ? { repo: raw.repo } : {}),
    ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
    ...(typeof raw.itemId === 'string' ? { itemId: raw.itemId } : {})
  }
}

function parseRequest(value: unknown): WorkspaceComposerRequest | null {
  const raw = object(value)
  const target = parseTarget(raw?.target)
  if (!raw || !target || typeof raw.requestId !== 'string' || typeof raw.repoId !== 'string' || typeof raw.repoName !== 'string' || typeof raw.name !== 'string' || typeof raw.title !== 'string' || typeof raw.prompt !== 'string') return null
  const setup: SetupChoice = raw.setup === 'run' || raw.setup === 'skip' ? raw.setup : 'inherit'
  const issueCommand: IssueCommandChoice = raw.issueCommand === 'run' || raw.issueCommand === 'skip' ? raw.issueCommand : 'inherit'
  return {
    requestId: raw.requestId,
    target,
    repoId: raw.repoId,
    repoName: raw.repoName,
    name: raw.name,
    title: raw.title,
    prompt: raw.prompt,
    setup,
    issueCommand,
    agent: typeof raw.agent === 'string' && raw.agent.length > 0 ? raw.agent : null,
    ...(raw.setupDecisionRequired === true ? { setupDecisionRequired: true } : {}),
    ...(raw.trustKind === 'setup' || raw.trustKind === 'issue' ? { trustKind: raw.trustKind } : {}),
    ...(typeof raw.trustScript === 'string' ? { trustScript: raw.trustScript } : {}),
    ...(typeof raw.trustHash === 'string' && raw.trustHash.length > 0 ? { trustHash: raw.trustHash } : {}),
    ...(raw.trustChanged === true ? { trustChanged: true } : {}),
    ...(typeof raw.trustSetupHash === 'string' && raw.trustSetupHash.length > 0 ? { trustSetupHash: raw.trustSetupHash } : {}),
    ...(typeof raw.trustIssueCommandHash === 'string' && raw.trustIssueCommandHash.length > 0 ? { trustIssueCommandHash: raw.trustIssueCommandHash } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {})
  }
}

function eventRequest(event: unknown): WorkspaceComposerRequest | null {
  const rawEvent = object(event)
  if (rawEvent?.type !== 'quirky.tasks/workspaceComposer') return null
  const data = object(rawEvent.data)
  return parseRequest(data?.request)
}

async function loadAgents(context: TasksSurfaceProps['context']): Promise<AgentSelection> {
  const [listingValue, pickedValue] = await Promise.all([
    context.call('quirky.agents/list', {}).catch(() => null),
    context.call('quirky.agents/pick', { forAgentTab: true }).catch(() => null)
  ])
  const listing = object(listingValue)
  const values = Array.isArray(listing?.agents) ? listing.agents : []
  const options = values.flatMap((entry) => {
    const agent = object(entry)
    if (!agent || agent.installed !== true || agent.enabled !== true || typeof agent.id !== 'string') return []
    return [{ id: agent.id, label: typeof agent.label === 'string' ? agent.label : agent.id }]
  })
  const picked = object(pickedValue)
  const pickedId = typeof picked?.agent === 'string' && picked.agent !== 'shell' && options.some((agent) => agent.id === picked.agent)
    ? picked.agent
    : null
  return { options, defaultAgent: pickedId }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createdMessage(result: Record<string, unknown>, fallback: string, promptWasProvided: boolean): string {
  const details: string[] = []
  if (result.agentPending === true) {
    details.push('Agent start is pending repository setup; prompt delivery is not confirmed.')
  } else if (typeof result.agentSessionId === 'string') {
    if (result.promptDelivery === null) {
      details.push(promptWasProvided ? 'Prompt delivery status is unconfirmed.' : 'Agent started without an initial prompt.')
    } else {
      switch (result.promptDelivery) {
        case 'command-line':
          details.push('Prompt was passed on agent launch.')
          break
        case 'pending':
          details.push('Prompt delivery is pending.')
          break
        case 'pasted':
          details.push('Prompt was delivered after the agent signaled ready.')
          break
        case 'unconfirmed':
          details.push('Prompt delivery is unconfirmed; it was sent without confirming readiness.')
          break
        case 'not-delivered':
          details.push('Prompt was not delivered.')
          break
        default:
          details.push(promptWasProvided ? 'Prompt delivery status is unconfirmed.' : 'Agent started without an initial prompt.')
          break
      }
    }
  }
  const setupOutcome = object(result.setup)
  if (setupOutcome?.timedOut === true) details.push('Repository setup timed out.')
  else if (typeof setupOutcome?.exitCode === 'number' && setupOutcome.exitCode !== 0) details.push(`Repository setup exited with code ${setupOutcome.exitCode}.`)
  else if (setupOutcome?.ran === 'terminal') details.push('Repository setup was launched in a terminal.')
  const issueOutcome = object(result.issueCommand)
  if (issueOutcome?.timedOut === true) details.push('The issue command timed out.')
  else if (typeof issueOutcome?.exitCode === 'number' && issueOutcome.exitCode !== 0) details.push(`The issue command exited with code ${issueOutcome.exitCode}.`)
  else if (issueOutcome?.ran === 'terminal') details.push('The issue command was launched in a terminal.')
  if (Array.isArray(result.warnings)) {
    for (const warning of result.warnings) if (typeof warning === 'string' && warning.length > 0) details.push(warning)
  }
  return details.length > 0 ? details.join('\n') : fallback
}

export function WorkspaceComposer({ context, refresh, report }: WorkspaceComposerProps) {
  const [request, setRequest] = useState<WorkspaceComposerRequest | null>(null)
  const [agentSelection, setAgentSelection] = useState<AgentSelection>({ options: [], defaultAgent: null })
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [setup, setSetup] = useState<SetupChoice>('inherit')
  const [issueCommand, setIssueCommand] = useState<IssueCommandChoice>('inherit')
  const [agent, setAgent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef<string | null>(null)
  const initializedRequest = useRef<string | null>(null)
  const agentTouched = useRef(false)
  const submitInFlight = useRef(false)

  useEffect(() => {
    report?.({ open: request !== null, request, busy, error })
  }, [report, request, busy, error])

  useEffect(() => {
    let live = true
    let eventSeen = false
    const accept = (parsed: WorkspaceComposerRequest | null) => {
      requestId.current = parsed?.requestId ?? null
      setRequest(parsed)
      setError(parsed?.error ?? null)
    }
    const unsubscribe = context.subscribe((event) => {
      if (object(event)?.type !== 'quirky.tasks/workspaceComposer') return
      eventSeen = true
      accept(eventRequest(event))
    })
    void context.call('quirky.tasks/workspaceComposerState', {}).then((value) => {
      if (live && !eventSeen) accept(parseRequest(value))
    }).catch((cause) => {
      if (live && !eventSeen) setError(messageOf(cause))
    })
    void loadAgents(context).then((selection) => live && setAgentSelection(selection))
    return () => {
      live = false
      unsubscribe()
    }
  }, [context])

  useEffect(() => {
    if (!request) {
      initializedRequest.current = null
      agentTouched.current = false
      return
    }
    if (initializedRequest.current === request.requestId) return
    initializedRequest.current = request.requestId
    agentTouched.current = false
    setName(request.name)
    setPrompt(request.prompt)
    setSetup(request.setup)
    setIssueCommand(request.issueCommand ?? 'inherit')
    setAgent(request.agent ?? '')
    setError(request.error ?? null)
  }, [request?.requestId])

  useEffect(() => {
    if (!request || request.agent !== null || agentTouched.current || !agentSelection.defaultAgent) return
    setAgent((current) => current.length === 0 ? agentSelection.defaultAgent! : current)
  }, [request?.requestId, request?.agent, agentSelection.defaultAgent])

  const cancel = async () => {
    if (!request || submitInFlight.current) return
    const submittedRequestId = request.requestId
    submitInFlight.current = true
    setBusy(true)
    try {
      const value = await context.call('quirky.tasks/workspaceComposerCancel', { requestId: submittedRequestId })
      if (requestId.current === submittedRequestId) {
        const active = parseRequest(value)
        requestId.current = active?.requestId ?? null
        setRequest(active)
        setError(active?.error ?? null)
      }
    } catch (cause) {
      if (requestId.current === submittedRequestId) setError(messageOf(cause))
    } finally {
      submitInFlight.current = false
      setBusy(false)
    }
  }

  const submit = async (decision?: ConsentAction) => {
    if (!request || submitInFlight.current) return
    const submittedRequest = request
    const submittedRequestId = request.requestId
    const setupChoice = decision?.kind === 'setup' ? decision.choice : setup
    const issueCommandChoice = decision?.kind === 'issue' ? decision.choice : issueCommand
    const displayedHash = submittedRequest.trustHash
    if (decision?.choice === 'run' && (!displayedHash || typeof submittedRequest.trustScript !== 'string')) {
      setError(`The creator did not provide a content hash for this ${decision.kind === 'issue' ? 'issue command' : 'setup'} script, so it cannot be approved once.`)
      return
    }

    submitInFlight.current = true
    setBusy(true)
    setError(null)
    if (decision?.kind === 'setup') setSetup(decision.choice)
    if (decision?.kind === 'issue') setIssueCommand(decision.choice)
    const setupApprovalHash = setupChoice === 'run'
      ? decision?.kind === 'setup' && decision.choice === 'run' ? displayedHash : submittedRequest.trustSetupHash
      : undefined
    const issueCommandApprovalHash = issueCommandChoice === 'run'
      ? decision?.kind === 'issue' && decision.choice === 'run' ? displayedHash : submittedRequest.trustIssueCommandHash
      : undefined

    try {
      const result = object(await context.call('quirky.tasks/workspace', {
        target: submittedRequest.target,
        action: 'start',
        newWorkspace: true,
        composerRequestId: submittedRequestId,
        name: name.trim(),
        prompt,
        setup: setupChoice,
        ...(submittedRequest.target.kind === 'issue' ? { issueCommand: issueCommandChoice } : {}),
        agent,
        ...(setupApprovalHash ? { trustSetup: true, trustSetupHash: setupApprovalHash } : {}),
        ...(issueCommandApprovalHash ? { trustIssueCommand: true, trustIssueCommandHash: issueCommandApprovalHash } : {})
      }))
      if (result?.kind === 'created') {
        const worktree = object(result.worktree)
        context.toast('Workspace created', createdMessage(result, typeof worktree?.name === 'string' ? worktree.name : submittedRequest.name, prompt.trim().length > 0))
        if (requestId.current === submittedRequestId) {
          requestId.current = null
          setRequest(null)
          setError(null)
        }
        void refresh().catch((cause) => context.toast('Tasks refresh failed', messageOf(cause)))
        return
      }
      if (requestId.current !== submittedRequestId) return
      const updated = parseRequest(result)
      if (updated) {
        requestId.current = updated.requestId
        setRequest(updated)
        setError(updated.error ?? null)
      } else {
        setError('The workspace request did not return a creation result.')
      }
    } catch (cause) {
      if (requestId.current === submittedRequestId) setError(messageOf(cause))
    } finally {
      submitInFlight.current = false
      setBusy(false)
    }
  }

  const openSource = () => {
    if (!request?.target.url) return
    void context.executeCommand('command:quirky.tasks/open-link', { url: request.target.url }).catch((cause) => {
      if (requestId.current === request.requestId) setError(messageOf(cause))
    })
  }

  if (!request) return null
  const title = request.target.kind === 'issue' ? 'Create workspace from issue' : 'Create workspace from pull request'
  const setupChoiceRequired = request.setupDecisionRequired === true
  const trustKind = request.trustKind === 'setup' || request.trustKind === 'issue' ? request.trustKind : null
  const trustRequired = trustKind !== null && typeof request.trustScript === 'string'
  const trustLabel = trustKind === 'issue' ? 'Issue command' : 'Repository setup'
  const consentLabel = trustKind === 'setup' ? 'setup' : 'issue command'
  return (
    <Dialog open title={title} closeOnBackdrop={false} onClose={() => void cancel()}>
      <div className="tasks-composer">
        <div className="tasks-composer__context">{request.repoName} · #{request.target.number} · {request.title}</div>
        <div className="tasks-composer__source">
          <span>{request.target.kind === 'issue' ? 'Issue' : 'Pull request'} context</span>
          {request.target.url ? <Button type="button" onClick={openSource}>Open on GitHub</Button> : null}
        </div>
        <form className="tasks-composer__form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <TextField label="Workspace name" value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={200} />
          <FormRow label="Initial prompt" htmlFor="tasks-workspace-prompt">
            <textarea id="tasks-workspace-prompt" className="ui-text-field__input tasks-composer__textarea" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} />
          </FormRow>
          <FormRow label="Agent (optional)" htmlFor="tasks-workspace-agent">
            <select id="tasks-workspace-agent" className="ui-text-field__input" value={agent} onChange={(event) => { agentTouched.current = true; setAgent(event.currentTarget.value) }}>
              <option value="">Create without starting an agent</option>
              {agentSelection.options.map((option) => <option key={option.id} value={option.id}>{option.label}{option.id === agentSelection.defaultAgent ? ' · default' : ''}</option>)}
            </select>
          </FormRow>
          {setupChoiceRequired || trustKind === 'setup' ? (
            <FormRow label="Repository setup" htmlFor="tasks-workspace-setup">
              <select id="tasks-workspace-setup" className="ui-text-field__input" value={setup} onChange={(event) => setSetup(event.currentTarget.value as SetupChoice)}>
                <option value="inherit" disabled>Choose whether to run setup</option>
                <option value="run">Run setup</option>
                <option value="skip">Skip setup</option>
              </select>
            </FormRow>
          ) : <p className="tasks-composer__policy">Repository setup will follow the project policy.</p>}
          {request.target.kind === 'issue' ? (
            <FormRow label="Issue command" htmlFor="tasks-workspace-issue-command">
              <select id="tasks-workspace-issue-command" className="ui-text-field__input" value={issueCommand} onChange={(event) => setIssueCommand(event.currentTarget.value as IssueCommandChoice)}>
                <option value="inherit">Follow repository issue-command settings</option>
                <option value="run">Run issue command</option>
                <option value="skip">Skip issue command</option>
              </select>
            </FormRow>
          ) : null}
          {trustRequired ? (
            <details className="tasks-composer__trust" open>
              <summary>{trustLabel} script needs your approval{request.trustChanged ? ' (script changed)' : ''}</summary>
              <p>{trustLabel} content must match this displayed hash before it can run.</p>
              <code>Displayed SHA-256: {request.trustHash ?? 'Unavailable'}</code>
              <pre className="tasks-composer__trust-script">{request.trustScript}</pre>
            </details>
          ) : null}
          {error ? <p role="alert" className="tasks-composer__error">{error}</p> : null}
          <footer className="tasks-composer__actions">
            <Button type="button" onClick={() => void cancel()} disabled={busy}>Cancel</Button>
            {trustRequired && trustKind ? (
              <>
                <Button type="button" onClick={() => void submit({ kind: trustKind, choice: 'skip' })} disabled={busy}>Skip {consentLabel}</Button>
                <Button variant="primary" type="button" onClick={() => void submit({ kind: trustKind, choice: 'run' })} disabled={busy || !request.trustHash}>Run {consentLabel} once</Button>
              </>
            ) : (
              <Button variant="primary" type="submit" disabled={busy || (setupChoiceRequired && setup === 'inherit')}>{busy ? 'Creating…' : 'Create workspace'}</Button>
            )}
          </footer>
        </form>
      </div>
    </Dialog>
  )
}
