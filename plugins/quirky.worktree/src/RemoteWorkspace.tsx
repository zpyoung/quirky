import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { UiPluginContext, Worktree } from '@quirky/protocol'
import { Button, ListRow, SectionHeader, SelectField, StatusDot, TextField } from '@quirky/ui'
import type { RemoteCleanupPreview, RemoteWorkspaceMirror } from './remote-types'
import { isRecord } from './loop-status'
import { recordOf } from './values'

type Props = { context: UiPluginContext; workspace: string }
type RemoteSession = { id: string; agent: string; title: string; status: string; worktreeId: string }
type GitArea = 'conflicts' | 'staged' | 'unstaged' | 'untracked'
type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'
type GitChange = { path: string; area: GitArea; status: GitChangeStatus; oldPath?: string }
type GitFile = { path: string; index: string; worktree: string; untracked: boolean; origPath?: string }
type GitStatus = { entries: GitChange[]; files: GitFile[]; branch: string | null; operation: 'merge' | 'rebase' | 'cherry-pick' | 'none' }
type Diff = { path: string; original: string; modified: string; binary: boolean; kind?: string }
type ReadScreen = { lines: string[]; cols: number; rows: number; alt: boolean }
type HostStatus = { id: string; runtime: { id: string; name: string; endpoint: string; grantId: string }; identity: { hostId: string; generation: string }; connected: boolean; error: string | null }
type Preview = RemoteCleanupPreview

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionsOf(value: unknown, worktreeId: string): RemoteSession[] {
  if (!Array.isArray(value)) throw new Error('The remote session owner returned an invalid session list.')
  return value.map((item, index) => {
    const record = isRecord(item) ? item : null
    if (
      !record || typeof record.id !== 'string' || record.worktreeId !== worktreeId ||
      typeof record.agent !== 'string' || typeof record.title !== 'string' || typeof record.status !== 'string'
    ) throw new Error(`The remote session owner returned incomplete or misbound session data at row ${index + 1}.`)
    return { id: record.id, worktreeId: record.worktreeId, agent: record.agent, title: record.title, status: record.status }
  })
}

function changesOf(value: unknown): GitChange[] {
  if (!Array.isArray(value)) throw new Error('The remote Git owner returned an incomplete change list.')
  return value.map((item, index) => {
    const row = isRecord(item) ? item : null
    if (
      !row || typeof row.path !== 'string' ||
      !['conflicts', 'staged', 'unstaged', 'untracked'].includes(String(row.area)) ||
      !['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked'].includes(String(row.status)) ||
      (row.oldPath !== undefined && typeof row.oldPath !== 'string')
    ) throw new Error(`The remote Git owner returned incomplete change data at row ${index + 1}.`)
    return {
      path: row.path,
      area: row.area as GitArea,
      status: row.status as GitChangeStatus,
      ...(typeof row.oldPath === 'string' ? { oldPath: row.oldPath } : {})
    }
  })
}

function filesOf(value: unknown): GitFile[] {
  if (!Array.isArray(value)) throw new Error('The remote Git owner returned an incomplete legacy file list.')
  return value.map((item, index) => {
    const row = isRecord(item) ? item : null
    if (
      !row || typeof row.path !== 'string' || typeof row.index !== 'string' ||
      typeof row.worktree !== 'string' || typeof row.untracked !== 'boolean' ||
      (row.origPath !== undefined && typeof row.origPath !== 'string')
    ) throw new Error(`The remote Git owner returned incomplete legacy file data at row ${index + 1}.`)
    return {
      path: row.path,
      index: row.index,
      worktree: row.worktree,
      untracked: row.untracked,
      ...(typeof row.origPath === 'string' ? { origPath: row.origPath } : {})
    }
  })
}

function statusOf(value: unknown): GitStatus {
  const record = isRecord(value) ? value : null
  if (
    !record || (record.branch !== null && typeof record.branch !== 'string') ||
    (record.operation !== 'merge' && record.operation !== 'rebase' && record.operation !== 'cherry-pick' && record.operation !== 'none')
  ) throw new Error('The remote Git owner returned an incomplete status snapshot.')
  return {
    entries: changesOf(record.entries),
    files: filesOf(record.files),
    branch: record.branch,
    operation: record.operation
  }
}

function screenOf(value: unknown): ReadScreen | null {
  const record = isRecord(value) ? value : null
  if (
    !record || !Array.isArray(record.lines) || !record.lines.every((line) => typeof line === 'string') ||
    typeof record.cols !== 'number' || typeof record.rows !== 'number' || typeof record.alt !== 'boolean'
  ) return null
  return { lines: record.lines, cols: record.cols, rows: record.rows, alt: record.alt }
}

function asMirror(value: unknown): RemoteWorkspaceMirror | null {
  const record = isRecord(value) ? value : null
  const worktree = isRecord(record?.worktree) ? record.worktree : null
  const identity = isRecord(record?.identity) ? record.identity : null
  if (
    !record || typeof record.id !== 'string' || typeof record.hostId !== 'string' ||
    !identity || typeof identity.hostId !== 'string' || typeof identity.generation !== 'string' ||
    !worktree || typeof worktree.id !== 'string' || typeof worktree.name !== 'string' ||
    typeof worktree.path !== 'string' || typeof worktree.instanceId !== 'string' ||
    (worktree.kind !== 'git' && worktree.kind !== 'folder') ||
    typeof record.connected !== 'boolean' || typeof record.fingerprint !== 'string'
  ) return null
  return record as unknown as RemoteWorkspaceMirror
}

function hostOf(value: unknown): HostStatus | null {
  const record = isRecord(value) ? value : null
  const runtime = isRecord(record?.runtime) ? record.runtime : null
  const identity = isRecord(record?.identity) ? record.identity : null
  if (
    !record || typeof record.id !== 'string' || !runtime ||
    typeof runtime.id !== 'string' || typeof runtime.name !== 'string' ||
    typeof runtime.endpoint !== 'string' || typeof runtime.grantId !== 'string' ||
    !identity || typeof identity.hostId !== 'string' || typeof identity.generation !== 'string' ||
    typeof record.connected !== 'boolean' || (record.error !== null && typeof record.error !== 'string')
  ) return null
  return record as unknown as HostStatus
}

function changeKey(change: GitChange): string {
  return `${change.area}\\0${change.path}`
}

function changeList(status: GitStatus): GitChange[] {
  const seen = new Set<string>()
  return status.entries.filter((change) => {
    const key = changeKey(change)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Owner-fenced view over one exact remote worktree mirror. */
export function RemoteWorkspace({ context, workspace }: Props) {
  const [mirror, setMirror] = useState<RemoteWorkspaceMirror | null>(null)
  const [host, setHost] = useState<HostStatus | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [selectedSession, setSelectedSession] = useState('')
  const [screen, setScreen] = useState<ReadScreen | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [cleanup, setCleanup] = useState<Preview | null>(null)
  const [terminalInput, setTerminalInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const files = useMemo(() => status ? changeList(status) : [], [status])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const shown = asMirror(await context.call('quirky.worktree/remoteShow', { workspace }))
      if (!shown) throw new Error('The remote workspace owner returned an invalid mirror.')
      setMirror(shown)
      const currentHost = hostOf(await context.call('quirky.worktree/remoteHostStatus', { host: shown.hostId }))
      if (!currentHost) throw new Error('The remote host owner returned an incomplete registration.')
      setHost(currentHost)
      if (!shown.connected || !currentHost.connected) {
        setStatus(null)
        setSessions([])
        setScreen(null)
        setDiff(null)
        setCleanup(null)
        setError(currentHost.error ?? 'This owner or workspace instance is unavailable. Refresh before using remote data.')
        return
      }
      const [rawStatus, rawSessions, rawTerminal] = await Promise.all([
        shown.worktree.kind === 'git' ? context.call('quirky.worktree/remoteCall', { workspace, operation: 'changes' }) : null,
        context.call('quirky.worktree/remoteCall', { workspace, operation: 'sessions' }),
        context.call('quirky.worktree/remoteCall', { workspace, operation: 'terminalWorkspace' })
      ])
      const nextSessions = sessionsOf(rawSessions, shown.worktree.id)
      const terminal = isRecord(rawTerminal) && isRecord(rawTerminal.workspace) ? rawTerminal.workspace : null
      if (!terminal || terminal.id !== shown.worktree.id) throw new Error('The remote terminal owner returned a workspace layout for a different or incomplete remote instance.')
      setStatus(rawStatus === null ? null : statusOf(rawStatus))
      setSessions(nextSessions)
      setSelectedSession((selected) => nextSessions.some((session) => session.id === selected) ? selected : nextSessions[0]?.id ?? '')
      setNotice('Remote terminal workspace is available.')
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }, [context, workspace])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      return true
    } catch (caught) {
      setError(messageOf(caught))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const refresh = async () => {
    await run(async () => {
      const current = mirror ?? asMirror(await context.call('quirky.worktree/remoteShow', { workspace }))
      if (!current) throw new Error('The remote workspace selection is no longer available.')
      await context.call('quirky.worktree/remoteRefresh', { host: current.hostId })
      await load()
    })
  }

  const showDiff = async (change: GitChange) => {
    if (!mirror) return
    await run(async () => {
      const source = change.area === 'staged' ? 'staged' : 'unstaged'
      const value = recordOf(await context.call('quirky.worktree/remoteCall', {
        workspace,
        operation: 'diff',
        path: change.path,
        source
      }))
      if (!value || typeof value.original !== 'string' || typeof value.modified !== 'string' || typeof value.binary !== 'boolean') {
        throw new Error('The remote Git owner returned an incomplete diff.')
      }
      setDiff(value as unknown as Diff)
    })
  }

  const createSession = async () => {
    await run(async () => {
      const result = recordOf(await context.call('quirky.worktree/remoteCall', { workspace, operation: 'terminalCreate', title: 'Remote Shell' }))
      if (!result || typeof result.id !== 'string' || result.worktreeId !== mirror?.worktree.id) throw new Error('The remote session owner returned a session for a different or unknown workspace.')
      setSelectedSession(result.id)
      await load()
      setNotice(`Started remote terminal session ${result.id}.`)
    })
  }

  const readTerminal = async () => {
    if (!selectedSession) return
    await run(async () => {
      const value = screenOf(await context.call('quirky.worktree/remoteCall', {
        workspace,
        operation: 'terminalRead',
        session: selectedSession,
        lines: 200
      }))
      if (!value) throw new Error('The remote terminal owner returned an incomplete screen.')
      setScreen(value)
    })
  }

  const writeTerminal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedSession || terminalInput.length === 0) return
    const data = terminalInput.endsWith('\n') || terminalInput.endsWith('\r') ? terminalInput : `${terminalInput}\r`
    const succeeded = await run(async () => {
      await context.call('quirky.worktree/remoteCall', {
        workspace,
        operation: 'terminalWrite',
        session: selectedSession,
        data
      })
      setTerminalInput('')
      setNotice('Input was sent to the remote terminal.')
    })
    if (succeeded) await readTerminal()
  }

  const previewCleanup = async () => {
    if (!mirror) return
    await run(async () => {
      const result = recordOf(await context.call('quirky.worktree/remoteCleanupPreview', { workspace }))
      if (
        !result ||
        typeof result.workspace !== 'string' ||
        typeof result.hostId !== 'string' ||
        !isRecord(result.identity) ||
        typeof result.identity.hostId !== 'string' ||
        typeof result.identity.generation !== 'string' ||
        typeof result.instanceId !== 'string' ||
        typeof result.generatedAt !== 'number' || !Number.isFinite(result.generatedAt) ||
        !('candidate' in result)
      ) throw new Error('The canonical owner returned an incomplete cleanup preview.')
      if (result.candidate !== null) {
        const candidate = isRecord(result.candidate) ? result.candidate : null
        if (
          !candidate ||
          typeof candidate.worktreeId !== 'string' ||
          typeof candidate.name !== 'string' ||
          typeof candidate.fingerprint !== 'string' ||
          typeof candidate.reason !== 'string' ||
          typeof candidate.ignored !== 'boolean' ||
          typeof candidate.eligible !== 'boolean' ||
          !Array.isArray(candidate.blockers) ||
          candidate.blockers.some((item) => !isRecord(item) || typeof item.code !== 'string' || typeof item.detail !== 'string')
        ) throw new Error('The canonical owner returned an incomplete cleanup candidate.')
      }
      setCleanup(result as unknown as Preview)
    })
  }

  const removeWorkspace = async () => {
    if (!mirror || !await context.confirm({
      title: `Remove remote workspace ${mirror.worktree.name}?`,
      body: 'The canonical owner will recheck this exact filesystem instance and refuse if live terminal sessions or unsafe state remain.',
      confirmLabel: 'Remove Remote Workspace'
    })) return
    await run(async () => {
      await context.call('quirky.worktree/remoteRemove', {
        workspace,
        fingerprint: mirror.fingerprint,
        confirmed: true
      })
      setNotice('The remote owner removed the selected workspace.')
    })
    setMirror((current) => current ? { ...current, connected: false } : current)
  }

  const removeCleanup = async () => {
    const candidate = cleanup?.candidate
    if (!mirror || !candidate || !candidate.eligible || !await context.confirm({
      title: `Remove ${mirror.worktree.name} through remote cleanup?`,
      body: 'The canonical owner will compare the live cleanup fingerprint and filesystem instance before deleting it.',
      confirmLabel: 'Remove Remote Workspace'
    })) return
    await run(async () => {
      await context.call('quirky.worktree/remoteCleanupRemove', {
        workspace,
        fingerprint: candidate.fingerprint,
        confirmed: true
      })
      setNotice('The canonical owner removed the cleanup suggestion.')
    })
    setMirror((current) => current ? { ...current, connected: false } : current)
  }

  const connected = mirror?.connected === true && host?.connected === true
  const disabled = busy || loading || !connected

  return (
    <main aria-label="Remote workspace" className="remote-workspace">
      <header className="remote-workspace__header">
        <div className="remote-workspace__identity">
          <h1 className="remote-workspace__title">{mirror?.worktree.name ?? 'Remote workspace'}</h1>
          <div className="ui-text-muted">
            {host ? `${host.runtime.name} · ${host.identity.hostId} · generation ${host.identity.generation}` : 'Checking owner identity…'}
          </div>
        </div>
        <div className="ui-cluster">
          <span className="remote-workspace__state" role="status" aria-live="polite">
            <StatusDot status={connected ? 'working' : 'needs-you'} />
            {connected ? 'Connected' : 'Unavailable'}
          </span>
          <Button disabled={busy} onClick={() => { void refresh() }}>Refresh Remote Data</Button>
        </div>
      </header>

      {error && <p className="ui-error-text" role="alert">{error}</p>}
      {notice && <p className="ui-text-muted" role="status">{notice}</p>}
      {loading && <p className="ui-text-muted" role="status">Loading the owner-bound workspace…</p>}

      {mirror && (
        <section aria-label="Remote workspace details" className="remote-workspace__section">
          <SectionHeader title="Remote workspace details" />
          <dl className="remote-details">
            <dt>Host</dt><dd className="ui-text-mono">{mirror.hostId}</dd>
            <dt>Project</dt><dd>{mirror.worktree.repoId}</dd>
            <dt>Remote path</dt><dd className="ui-text-mono">{mirror.worktree.path}</dd>
            <dt>Branch</dt><dd>{mirror.worktree.kind === 'folder' ? 'Not applicable' : mirror.worktree.branch ?? 'Detached'}</dd>
            <dt>HEAD</dt><dd className="ui-text-mono">{mirror.worktree.kind === 'folder' ? 'Not applicable' : mirror.worktree.head}</dd>
            <dt>Instance</dt><dd className="ui-text-mono">{mirror.worktree.instanceId}</dd>
          </dl>
          {!mirror.connected && <p className="ui-text-muted" role="status">This is a saved snapshot only; remote reads and actions are blocked until the exact owner and instance are available.</p>}
          <div className="ui-cluster">
            <Button variant="destructive" disabled={disabled} onClick={() => { void removeWorkspace() }}>Remove Remote Workspace…</Button>
            <Button disabled={disabled} onClick={() => { void previewCleanup() }}>Preview Canonical Cleanup</Button>
          </div>
        </section>
      )}

      <section aria-label="Remote changes" className="remote-workspace__section">
        <SectionHeader title="Changes" />
        {mirror?.worktree.kind === 'folder' ? <p className="ui-text-muted">Folder workspaces do not have Git changes.</p> : <>
          <div className="ui-text-muted">Branch: {status?.branch ?? mirror?.worktree.branch ?? 'Unknown'} · Operation: {status?.operation ?? (connected ? 'unknown' : 'unavailable')}</div>
          {files.length === 0 ? <p className="ui-text-muted">{connected ? 'No changed files were reported.' : 'Remote changes are unavailable.'}</p> : (
            <ul className="remote-changes">{files.map((change) => (
              <li key={changeKey(change)}>
                <ListRow
                  compact
                  title={<span className="ui-text-mono">{change.path}</span>}
                  trailing={<span className="remote-fact">{[change.area, change.status].filter(Boolean).join(' · ')}</span>}
                  disabled={disabled}
                  onClick={() => { void showDiff(change) }}
                />
              </li>
            ))}</ul>
          )}
          {diff && (
            <div aria-label={`Diff for ${diff.path}`} className="remote-diff">
              <h3 className="remote-diff__path ui-text-mono">{diff.path}{diff.binary ? ' (binary)' : ''}</h3>
              {!diff.binary && <div className="remote-diff__panes">
                <pre className="remote-pre">{diff.original}</pre>
                <pre className="remote-pre">{diff.modified}</pre>
              </div>}
            </div>
          )}
        </>}
      </section>

      <section aria-label="Remote terminal controls" className="remote-workspace__section">
        <SectionHeader title="Remote terminal" />
        <div className="ui-cluster remote-terminal__controls">
          <SelectField label="Session" value={selectedSession} onChange={(event) => setSelectedSession(event.currentTarget.value)} disabled={disabled}>
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.title ?? session.agent ?? session.id} · {session.status ?? 'unknown'}</option>)}
          </SelectField>
          <Button disabled={disabled} onClick={() => { void createSession() }}>New Remote Shell</Button>
          <Button disabled={disabled || !selectedSession} onClick={() => { void readTerminal() }}>Read Screen</Button>
        </div>
        <form className="remote-terminal__input" onSubmit={(event) => { void writeTerminal(event) }}>
          <TextField
            label="Send input to selected remote session"
            value={terminalInput}
            onChange={(event) => setTerminalInput(event.currentTarget.value)}
            disabled={disabled || !selectedSession}
          />
          <Button type="submit" disabled={disabled || !selectedSession || terminalInput.length === 0}>Send</Button>
        </form>
        {screen && (
          <pre aria-label="Remote terminal screen" className="remote-pre remote-pre--screen">
            {screen.lines.join('\n')}
          </pre>
        )}
        {!selectedSession && <p className="ui-text-muted">No remote terminal session is attached to this workspace.</p>}
      </section>

      {cleanup && (
        <section aria-label="Canonical cleanup preview" className="remote-workspace__section">
          <SectionHeader title="Canonical cleanup preview" />
          <p>Owner generation: {cleanup.identity.generation} · filesystem instance: <span className="ui-text-mono">{cleanup.instanceId}</span></p>
          {!cleanup.candidate ? <p className="ui-text-muted">No canonical cleanup suggestion exists for this workspace.</p> : (
            <>
              <p>{cleanup.candidate.reason} · {cleanup.candidate.eligible ? 'eligible' : 'blocked'}</p>
              {cleanup.candidate.blockers.length > 0 && <ul className="remote-blockers">{cleanup.candidate.blockers.map((blocker, index) => <li key={`${blocker.code}:${index}`}>{blocker.detail}</li>)}</ul>}
              <div className="ui-cluster">
                <Button variant="destructive" disabled={disabled || !cleanup.candidate.eligible} onClick={() => { void removeCleanup() }}>
                  Remove Canonical Cleanup Suggestion…
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </main>
  )
}
