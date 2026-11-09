import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { ActivityMark, Button, ContextMenu, EmptyState, IconButton, SectionHeader, SelectField, StatusDot, TextField, type ContextMenuItem, type UiActivityMarkState } from '@quirky/ui'
import { isRecord } from './loop-status'
import { VmRecipeSelector, type VmRecipeSelection } from './VmRecipeSelector'
import { currentWindowId } from './actions'

type Project = { id: string; name: string }
type VmRow = {
  id: string; name: string; vmName: string; instanceId: string; state: string
  backendState: string; error: string | null; remoteWorkspace: { id: string } | null
}

type OpenMenu = { x: number; y: number; label: string; items: ContextMenuItem[]; returnFocusTo?: HTMLElement }

const transientStates = new Set(['creating', 'suspending', 'resuming', 'destroying', 'retiring'])

function markState(state: string): UiActivityMarkState {
  if (transientStates.has(state)) return 'running'
  if (state === 'failed' || state === 'interrupted') return 'error'
  return 'asleep'
}

function LifecycleMark({ state }: { state: string }) {
  return state === 'running'
    ? <StatusDot status="working" label={`Lifecycle: ${state}`} />
    : <ActivityMark state={markState(state)} label={`Lifecycle: ${state}`} />
}

function readEnvironments(value: unknown): VmRow[] {
  if (!isRecord(value) || !Array.isArray(value.environments)) throw new Error('Invalid VM environment inventory.')
  return value.environments.map((vm: unknown) => {
    if (!isRecord(vm) || typeof vm.id !== 'string' || typeof vm.name !== 'string' || typeof vm.vmName !== 'string' ||
      typeof vm.instanceId !== 'string' || typeof vm.state !== 'string' || typeof vm.backendState !== 'string' ||
      (vm.error !== null && typeof vm.error !== 'string') ||
      (vm.remoteWorkspace !== null && (!isRecord(vm.remoteWorkspace) || typeof vm.remoteWorkspace.id !== 'string'))) {
      throw new Error('Invalid VM lifecycle state or attachment identity.')
    }
    return {
      id: vm.id, name: vm.name, vmName: vm.vmName, instanceId: vm.instanceId,
      state: vm.state, backendState: vm.backendState, error: vm.error,
      remoteWorkspace: vm.remoteWorkspace === null ? null : { id: vm.remoteWorkspace.id as string }
    }
  })
}

/** Provisioning and destructive lifecycle use the same public methods as the CLI. */
export function VmEnvironments({ context, initialRepo }: { context: UiPluginContext; initialRepo?: string }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [repo, setRepo] = useState(initialRepo ?? '')
  const [recipe, setRecipe] = useState<VmRecipeSelection | null>(null)
  const [name, setName] = useState('')
  const [environments, setEnvironments] = useState<VmRow[]>([])
  const [doctor, setDoctor] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const mounted = useRef(false)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    const [rawProjects, rawEnvironments, diagnostics] = await Promise.all([
      context.call('quirky.repo/list'), context.call('quirky.worktree/vmList'), context.call('quirky.worktree/vmDoctor')
    ])
    if (!Array.isArray(rawProjects)) throw new Error('Invalid project inventory.')
    const nextProjects = rawProjects.flatMap((project: unknown) => isRecord(project) && project.kind === 'git' &&
      typeof project.id === 'string' && typeof project.name === 'string' ? [{ id: project.id, name: project.name }] : [])
    const nextEnvironments = readEnvironments(rawEnvironments)
    if (mounted.current) {
      setProjects(nextProjects)
      setRepo((selected) => selected || nextProjects[0]?.id || '')
      setEnvironments(nextEnvironments)
      setDoctor(diagnostics)
    }
  }, [context])

  useEffect(() => {
    mounted.current = true
    void load().catch((failure: unknown) => { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { mounted.current = false }
  }, [load])
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => {
      void context.call('quirky.worktree/vmList').then((value) => {
        const next = readEnvironments(value)
        if (mounted.current) setEnvironments(next)
      }).catch((failure: unknown) => {
        if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, 2000)
    return () => clearInterval(timer)
  }, [busy, context])

  async function run(action?: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try { await action?.() }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally {
      try { await load() }
      catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function openWorkspace(workspace: string) {
    await context.call('quirky.worktree/remoteNavigate', { workspace, window: await currentWindowId(context) })
  }

  async function create() {
    if (!recipe?.approved || repo === '') throw new Error('Select a project and approve its exact lifecycle commands.')
    await context.call('quirky.worktree/vmCreate', {
      repo, recipe: recipe.id, trustHash: recipe.trustHash,
      ...(recipe.checkoutMode === 'orca-worktree' && name.trim() !== '' ? { name: name.trim() } : {})
    })
    if (mounted.current) setRecipe(null)
  }

  async function lifecycle(vm: VmRow, method: 'vmSuspend' | 'vmResume' | 'vmDestroy') {
    if (method === 'vmDestroy' && !await context.confirm({
      title: `Destroy VM ${vm.vmName}?`, body: 'This permanently destroys the exact recorded Lima instance and detaches its remote workspace. Guest data may be lost.', confirmLabel: 'Destroy VM'
    })) return
    await context.call(`quirky.worktree/${method}`, { vm: vm.id, instanceId: vm.instanceId, ...(method === 'vmDestroy' ? { yes: true } : {}) })
  }

  function openRowMenu(vm: VmRow, x: number, y: number, returnFocusTo: HTMLElement) {
    const live = !busy && vm.state !== 'destroyed'
    const items: ContextMenuItem[] = []
    if (vm.remoteWorkspace) {
      const workspace = vm.remoteWorkspace.id
      items.push({ id: 'open', label: 'Open guest workspace', enabled: !busy, onSelect: () => { void run(() => openWorkspace(workspace)) } })
    }
    items.push(
      { id: 'suspend', label: 'Suspend', enabled: live, onSelect: () => { void run(() => lifecycle(vm, 'vmSuspend')) } },
      { id: 'resume', label: 'Resume / reconcile', enabled: live, onSelect: () => { void run(() => lifecycle(vm, 'vmResume')) } },
      { id: 'destroy', label: 'Destroy VM', danger: true, separatorBefore: true, enabled: live, onSelect: () => { void run(() => lifecycle(vm, 'vmDestroy')) } }
    )
    setMenu({ x, y, returnFocusTo, label: `Actions for ${vm.vmName}`, items })
  }

  return <main className="vm-environments" aria-label="VM environments">
    <SectionHeader
      title="VM environments"
      actions={<Button type="button" disabled={busy} onClick={() => { void run() }}>Refresh lifecycle state</Button>}
    />
    <p className="ui-text-muted">Recipes provision real Lima guests. A timed-out create may still be running: inspect its existing record before starting another VM.</p>
    {doctor !== null && <details className="vm-diagnostics"><summary>VM backend diagnostics</summary><pre className="vm-diagnostics__body">{JSON.stringify(doctor, null, 2)}</pre></details>}
    {error && <p className="ui-error-text" role="alert">{error}</p>}
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void run(create) }}>
      <SelectField id="vm-project" label="Project" aria-label="VM project" value={repo} disabled={busy} onChange={(event) => { setRepo(event.currentTarget.value); setRecipe(null) }}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </SelectField>
      {repo !== '' && <VmRecipeSelector context={context} repo={repo} value={recipe} disabled={busy} onChange={setRecipe} />}
      {recipe?.checkoutMode === 'orca-worktree' && <TextField label="Guest worktree name (optional)" aria-label="Guest worktree name" value={name} disabled={busy} onChange={(event) => setName(event.currentTarget.value)} />}
      <Button type="submit" variant="primary" disabled={busy || !recipe?.approved || repo === ''}>Create VM</Button>
    </form>
    <SectionHeader title="Recorded environments" />
    {environments.length === 0
      ? <EmptyState message="No VM environments recorded" action={{ label: 'Create VM', onAction: () => document.getElementById('vm-project')?.focus() }} />
      : <table className="vm-table">
        <thead>
          <tr>
            <th scope="col">Environment</th>
            <th scope="col">VM</th>
            <th scope="col">Lifecycle</th>
            <th scope="col">Backend</th>
            <th scope="col"><span className="vm-table__sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {environments.map((vm) => <tr key={vm.id} aria-label={vm.vmName} className="vm-row">
            <td>
              <span className="vm-table__name">{vm.name}</span>
              {vm.error && <span className="ui-error-text vm-table__error" role="status">{vm.error}</span>}
            </td>
            <td><code className="ui-text-mono">{vm.vmName}</code></td>
            <td><span className="vm-lifecycle"><LifecycleMark state={vm.state} />{vm.state}</span></td>
            <td className="ui-text-muted">{vm.backendState}</td>
            <td className="vm-table__actions">
              <span className="vm-reveal">
                <IconButton
                  label={`Actions for ${vm.vmName}`}
                  aria-haspopup="menu"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect()
                    openRowMenu(vm, box.left, box.bottom, event.currentTarget)
                  }}
                >
                  ⋯
                </IconButton>
              </span>
            </td>
          </tr>)}
        </tbody>
      </table>}
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
  </main>
}
