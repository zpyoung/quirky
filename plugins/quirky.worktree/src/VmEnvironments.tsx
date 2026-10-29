import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { isRecord } from './loop-status'
import { VmRecipeSelector, type VmRecipeSelection } from './VmRecipeSelector'
import { currentWindowId } from './actions'

type Project = { id: string; name: string }
type VmRow = {
  id: string; name: string; vmName: string; instanceId: string; state: string
  backendState: string; error: string | null; remoteWorkspace: { id: string } | null
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

  return <main className="form" aria-label="VM environments">
    <h2>VM environments</h2>
    <p>Recipes provision real Lima guests. A timed-out create may still be running: inspect its existing record before starting another VM.</p>
    <button type="button" disabled={busy} onClick={() => { void run() }}>Refresh lifecycle state</button>
    {doctor !== null && <details><summary>VM backend diagnostics</summary><pre>{JSON.stringify(doctor, null, 2)}</pre></details>}
    {error && <p role="alert">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void run(create) }}>
      <label>Project
        <select aria-label="VM project" value={repo} disabled={busy} onChange={(event) => { setRepo(event.currentTarget.value); setRecipe(null) }}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      {repo !== '' && <VmRecipeSelector context={context} repo={repo} value={recipe} disabled={busy} onChange={setRecipe} />}
      {recipe?.checkoutMode === 'orca-worktree' && <label>Guest worktree name (optional)
        <input aria-label="Guest worktree name" value={name} disabled={busy} onChange={(event) => setName(event.currentTarget.value)} />
      </label>}
      <button type="submit" disabled={busy || !recipe?.approved || repo === ''}>Create VM</button>
    </form>
    <h3>Recorded environments</h3>
    {environments.length === 0 && <p>No VM environments recorded.</p>}
    {environments.map((vm) => <section key={vm.id} aria-label={vm.vmName}>
      <strong>{vm.name}</strong> <code>{vm.vmName}</code>
      <p>Lifecycle: {vm.state}; backend: {vm.backendState}</p>
      {vm.error && <p role="status">{vm.error}</p>}
      {vm.remoteWorkspace && <button type="button" disabled={busy} onClick={() => { void run(() => openWorkspace(vm.remoteWorkspace!.id)) }}>Open guest workspace</button>}
      <button type="button" disabled={busy || vm.state === 'destroyed'} onClick={() => { void run(() => lifecycle(vm, 'vmSuspend')) }}>Suspend</button>
      <button type="button" disabled={busy || vm.state === 'destroyed'} onClick={() => { void run(() => lifecycle(vm, 'vmResume')) }}>Resume / reconcile</button>
      <button type="button" disabled={busy || vm.state === 'destroyed'} onClick={() => { void run(() => lifecycle(vm, 'vmDestroy')) }}>Destroy VM</button>
    </section>)}
  </main>
}
