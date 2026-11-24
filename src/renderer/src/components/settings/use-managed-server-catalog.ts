import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { QuirkydManagedPendingMigrationRow } from '../../../../shared/quirkyd-managed-runtime'
import {
  getQuirkydSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedQuirkydPreloadApi } from '../../../../preload/api/managed-quirkyd-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { isWebClientLocation } from '@/lib/web-client-location'
import { managedServerOutcomeLabel } from './managed-server-copy'

export type ManagedServerCatalog = {
  /** Absent in the web client, which can't reach SSH hosts. */
  api: ManagedQuirkydPreloadApi | undefined
  targets: SshTarget[]
  /** SSH hosts that don't already run, or move to, a managed server. */
  emptyTargets: SshTarget[]
  pending: QuirkydManagedPendingMigrationRow[]
  loadFailed: boolean
  resumingId: string | null
  reload: () => Promise<void>
  resume: (row: QuirkydManagedPendingMigrationRow) => Promise<void>
}

/** The managed-server API, or undefined where it can't work: the web client's fallback API stubs it. */
export function getManagedQuirkydApi(): ManagedQuirkydPreloadApi | undefined {
  return isWebClientLocation() ? undefined : window.api.runtimeEnvironments.managedQuirkyd
}

export function useManagedServerCatalog(
  environments: PublicKnownRuntimeEnvironment[],
  onChanged: () => void
): ManagedServerCatalog {
  const api = getManagedQuirkydApi()
  const mountedRef = useMountedRef()
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [pending, setPending] = useState<QuirkydManagedPendingMigrationRow[]>([])
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const reload = useCallback(async () => {
    if (!api) {
      return
    }
    const [nextTargets, nextPending] = await Promise.all([
      window.api.ssh.listTargets(),
      api.listPendingMigrations()
    ])
    if (mountedRef.current) {
      setTargets(nextTargets)
      setPending(nextPending)
      setLoadFailed(false)
    }
  }, [api, mountedRef])

  useEffect(() => {
    void reload().catch(() => mountedRef.current && setLoadFailed(true))
  }, [mountedRef, reload])

  // Why: a host that already runs, or is moving to, a managed server can't take another.
  const busyTargetIds = new Set([
    ...environments.map((environment) => getQuirkydSshDeployment(environment)?.sshTargetId),
    ...pending.map((row) => row.sshTargetId)
  ])
  const emptyTargets = targets.filter(
    (target) => !target.quirkydFence && !busyTargetIds.has(target.id)
  )

  const resume = async (row: QuirkydManagedPendingMigrationRow): Promise<void> => {
    if (!api || resumingId) {
      return
    }
    setResumingId(row.migrationId)
    try {
      const result = await api.convertSshHost({ sshTargetId: row.sshTargetId, name: row.name })
      if (result.outcome !== 'converted') {
        toast.message(managedServerOutcomeLabel(result))
      }
      onChanged()
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setResumingId(null)
      }
    }
  }

  return { api, targets, emptyTargets, pending, loadFailed, resumingId, reload, resume }
}
