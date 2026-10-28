import { useEffect, useState } from 'react'
import type { TasksSurfaceProps, ItemTarget } from '../contracts'

type ComposerRequest = {
  requestId: string
  target: ItemTarget
  repoId: string
  repoName: string
  name: string
  title: string
  prompt: string
  setup: 'run' | 'skip' | 'inherit'
  agent: string | null
  setupDecisionRequired?: boolean
  trustScript?: string
  trustChanged?: boolean
  error?: string
}
type WorkspaceComposerState = { open: boolean; request: ComposerRequest | null; busy: boolean; error: string | null }
type WorkspaceComposerProps = TasksSurfaceProps & { report?(state: WorkspaceComposerState): void }
type AgentOption = { id: string; label: string; isDefault: boolean }

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

function parseRequest(value: unknown): ComposerRequest | null {
  const raw = object(value)
  const target = parseTarget(raw?.target)
  if (!raw || !target || typeof raw.requestId !== 'string' || typeof raw.repoId !== 'string' || typeof raw.repoName !== 'string' || typeof raw.name !== 'string' || typeof raw.title !== 'string' || typeof raw.prompt !== 'string') return null
  const setup = raw.setup === 'run' || raw.setup === 'skip' ? raw.setup : 'inherit'
  return {
    requestId: raw.requestId,
    target,
    repoId: raw.repoId,
    repoName: raw.repoName,
    name: raw.name,
    title: raw.title,
    prompt: raw.prompt,
    setup,
    agent: typeof raw.agent === 'string' ? raw.agent : null,
    ...(raw.setupDecisionRequired === true ? { setupDecisionRequired: true } : {}),
    ...(typeof raw.trustScript === 'string' ? { trustScript: raw.trustScript } : {}),
    ...(raw.trustChanged === true ? { trustChanged: true } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {})
  }
}

function eventRequest(event: unknown): ComposerRequest | null {
  const rawEvent = object(event)
  if (rawEvent?.type !== 'quirky.tasks/workspaceComposer') return null
  const data = object(rawEvent.data)
  return parseRequest(data?.request)
}

async function loadAgents(context: TasksSurfaceProps['context']): Promise<AgentOption[]> {
  try {
    const result = object(await context.call('quirky.agents/list', {}))
    const values = Array.isArray(result?.agents) ? result.agents : []
    const defaultAgent = typeof result?.defaultAgent === 'string' && result.defaultAgent !== 'auto' && result.defaultAgent !== 'shell' ? result.defaultAgent : null
    return values.flatMap((entry) => {
      const agent = object(entry)
      if (!agent || agent.installed !== true || agent.enabled !== true || typeof agent.id !== 'string') return []
      return [{ id: agent.id, label: typeof agent.label === 'string' ? agent.label : agent.id, isDefault: agent.isDefault === true || agent.id === defaultAgent }]
    })
  } catch {
    return []
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WorkspaceComposer({ context, refresh, report }: WorkspaceComposerProps) {
  const [request, setRequest] = useState<ComposerRequest | null>(null)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [setup, setSetup] = useState<'run' | 'skip' | 'inherit'>('inherit')
  const [agent, setAgent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    report?.({ open: request !== null, request, busy, error })
  }, [report, request, busy, error])

  useEffect(() => {
    let live = true
    let eventSeen = false
    const unsubscribe = context.subscribe((event) => {
      if (object(event)?.type !== 'quirky.tasks/workspaceComposer') return
      eventSeen = true
      const parsed = eventRequest(event)
      setRequest(parsed)
      setError(parsed?.error ?? null)
    })
    void context.call('quirky.tasks/workspaceComposerState', {}).then((value) => {
      if (live && !eventSeen) {
        const parsed = parseRequest(value)
        setRequest(parsed)
        setError(parsed?.error ?? null)
      }
    }).catch((cause) => {
      if (live && !eventSeen) setError(messageOf(cause))
    })
    void loadAgents(context).then((loaded) => live && setAgents(loaded))
    return () => {
      live = false
      unsubscribe()
    }
  }, [context])

  useEffect(() => {
    if (!request) return
    setName(request.name)
    setPrompt(request.prompt)
    setSetup(request.setup)
    setAgent(request.agent ?? agents.find((candidate) => candidate.isDefault)?.id ?? '')
    setError(request.error ?? null)
  }, [request?.requestId, request?.setupDecisionRequired, request?.trustScript, agents])

  const cancel = async () => {
    if (!request) return
    setBusy(true)
    try {
      await context.call('quirky.tasks/workspaceComposerCancel', { requestId: request.requestId })
      setRequest(null)
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (trustSetup = false, setupOverride?: 'run' | 'skip') => {
    if (!request || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = object(await context.call('quirky.tasks/workspace', {
        target: request.target,
        action: 'start',
        newWorkspace: true,
        composerRequestId: request.requestId,
        name: name.trim(),
        prompt,
        setup: setupOverride ?? setup,
        ...(agent ? { agent } : {}),
        ...(trustSetup ? { trustSetup: true } : {})
      }))
      if (result?.kind === 'created') {
        const worktree = object(result.worktree)
        context.toast('Workspace created', typeof worktree?.name === 'string' ? worktree.name : request.name)
        setRequest(null)
        setError(null)
        void refresh().catch((cause) => context.toast('Tasks refresh failed', messageOf(cause)))
        return
      }
      const updated = parseRequest(result)
      if (updated) {
        setRequest(updated)
        setError(updated.error ?? null)
      } else if (result?.kind !== 'composer') {
        setError('The workspace request did not return a creation result.')
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const openSource = () => {
    if (!request?.target.url) return
    void context.executeCommand('command:quirky.tasks/open-link', { url: request.target.url }).catch((cause) => setError(messageOf(cause)))
  }

  if (!request) return null
  const title = request.target.kind === 'issue' ? 'Create workspace from issue' : 'Create workspace from pull request'
  const setupChoiceRequired = request.setupDecisionRequired === true
  const trustRequired = typeof request.trustScript === 'string'
  const style = {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 10000,
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(0, 0, 0, .5)',
    padding: 20
  }
  const panel = {
    width: 'min(720px, 100%)',
    maxHeight: '90vh',
    overflow: 'auto',
    border: '1px solid var(--border, #444)',
    borderRadius: 12,
    background: 'var(--surface, #202124)',
    color: 'var(--text, #f4f4f5)',
    padding: 20,
    boxShadow: '0 18px 60px rgba(0,0,0,.45)'
  }
  const field = { display: 'grid', gap: 6, marginBlock: 14 }
  const input = { width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', color: 'inherit', background: 'var(--surface-raised, #2b2c30)', border: '1px solid var(--border, #555)', borderRadius: 6 }

  return (
    <div style={style}>
      <section role="dialog" aria-modal="true" aria-labelledby="tasks-workspace-title" style={panel}>
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'start' }}>
          <div>
            <h2 id="tasks-workspace-title" style={{ margin: '0 0 4px' }}>{title}</h2>
            <div style={{ opacity: .75 }}>{request.repoName} · #{request.target.number} · {request.title}</div>
          </div>
          <button type="button" aria-label="Close workspace composer" onClick={() => void cancel()} disabled={busy}>×</button>
        </header>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBlock: 14 }}>
          <span>{request.target.kind === 'issue' ? 'Issue' : 'Pull request'} context</span>
          {request.target.url ? <button type="button" onClick={openSource}>Open on GitHub</button> : null}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <label style={field}>
            <span>Workspace name</span>
            <input style={input} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={200} />
          </label>
          <label style={field}>
            <span>Initial prompt</span>
            <textarea style={{ ...input, minHeight: 110, resize: 'vertical' }} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} />
          </label>
          <label style={field}>
            <span>Agent (optional)</span>
            <select style={input} value={agent} onChange={(event) => setAgent(event.currentTarget.value)}>
              <option value="">Create without starting an agent</option>
              {agents.map((option) => <option key={option.id} value={option.id}>{option.label}{option.isDefault ? ' · default' : ''}</option>)}
            </select>
          </label>
          {setupChoiceRequired || trustRequired ? (
            <label style={field}>
              <span>Repository setup</span>
              <select style={input} value={setup} onChange={(event) => setSetup(event.currentTarget.value as 'run' | 'skip' | 'inherit')}>
                <option value="inherit" disabled>Choose whether to run setup</option>
                <option value="run">Run setup</option>
                <option value="skip">Skip setup</option>
              </select>
            </label>
          ) : <p style={{ opacity: .75 }}>Repository setup will follow the project policy.</p>}
          {trustRequired ? (
            <details style={{ marginBlock: 12 }} open>
              <summary>Setup script needs your approval{request.trustChanged ? ' (script changed)' : ''}</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', padding: 10, background: 'var(--surface-raised, #2b2c30)' }}>{request.trustScript}</pre>
            </details>
          ) : null}
          {error ? <p role="alert" style={{ color: 'var(--error, #ff7676)' }}>{error}</p> : null}
          <footer style={{ display: 'flex', justifyContent: 'end', gap: 8, marginTop: 18 }}>
            <button type="button" onClick={() => void cancel()} disabled={busy}>Cancel</button>
            {trustRequired ? (
              <>
                <button type="button" onClick={() => void submit(false, 'skip')} disabled={busy}>Skip setup</button>
                <button type="button" onClick={() => void submit(true, 'run')} disabled={busy}>Run setup once</button>
              </>
            ) : (
              <button type="submit" disabled={busy || (setupChoiceRequired && setup === 'inherit')}>{busy ? 'Creating…' : 'Create workspace'}</button>
            )}
          </footer>
        </form>
      </section>
    </div>
  )
}
