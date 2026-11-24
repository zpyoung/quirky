import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { BudgetClock } from './budget-clock'
import type { HeimdallDatabase } from './database'
import type { EnrollmentStore } from './enrollment-store'
import type { HeimdallLedgerStore } from './ledger-store'
import type { LeaseStore } from './lease-store'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { RunnerLedgerStore } from './runner-state'

export type HeimdallKernelServiceDependencies = {
  runtime: QuirkyRuntimeService
  store: Store
  storageAuthority?: 'desktop' | 'runtime'
  database?: HeimdallDatabase
  enrollmentStore?: EnrollmentStore
  ledgerStore?: HeimdallLedgerStore
  budgetClock?: BudgetClock
  leaseStore?: LeaseStore
  orchestration?: HeimdallOrchestrationAdapter
  now?: () => number
  createId?: () => string
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  holderId?: string
  appVersion?: () => string
}

export function runnerLedgerStore(store: HeimdallLedgerStore): RunnerLedgerStore {
  return {
    read: (watcherId) => store.read(watcherId),
    append: (watcherId, entry) => {
      if (entry.watcherId !== watcherId) {
        throw new Error('Ledger watcher envelope mismatch')
      }
      store.append(entry)
    },
    appendTickTrace: (watcherId, trace) => store.appendTickTrace(watcherId, trace),
    readTickTraces: (watcherId) => store.readTickTraces(watcherId),
    releaseTickTracePin: (watcherId, seq) => store.releaseTickTracePin(watcherId, seq),
    readTerminalSummary: (watcherId) => store.readTerminalSummary(watcherId)
  }
}

export function requireLeaseStore(store: LeaseStore | null): LeaseStore {
  if (!store) {
    throw new Error('Heimdall lease store is unavailable')
  }
  return store
}
