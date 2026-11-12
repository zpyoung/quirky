import { randomUUID } from 'node:crypto'
import type { PluginContext } from '@quirky/protocol'
import { avatarMigrations } from '../store-migrations'
import type {
  AgentKind, AvatarApp, AvatarBusEvent, AvatarServices, AvatarSettings, AvatarStore, JournalKind, Level, NeedsQueue, ReportModel
} from './contracts'
import { createAvatarStore } from './store'

const UNAVAILABLE = 'unavailable'
const LEVELS: readonly Level[] = ['shadow', 'local', 'own-branch', 'full']
const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'pi', 'omp']

const emptyReport = (): ReportModel => ({
  needsYou: [],
  stories: [],
  summary: { decisions: 0, allowed: 0, denied: 0, held: 0, guesses: 0, sleeps: [], keptAwake: false },
  topSkippedCalls: []
})

/**
 * Services that answer every call with an unavailable or empty result and never throw. Each module
 * replaces its own entry in `app.services` when it registers, so a module can run and be tested
 * against stubs of the others.
 */
export function createStubServices(): AvatarServices {
  return {
    gate: {
      classifyContext: async () => null,
      decideCall: async () => ({ outcome: 'retry', reason: 'the avatar gate is not available', encoded: '' }),
      writeMarker() {},
      removeMarker() {},
      gateCheck: async () => ({ ok: false, reason: UNAVAILABLE }),
      approveOnce() {},
      resolveInFlight() {},
      noteObservedCall() {},
      hasReceipt: () => false
    },
    handoff: {
      handoff: async (items) => items.map((item) => ({ worktreeId: item.worktreeId, ok: false, error: UNAVAILABLE })),
      takeBack: async (selection) =>
        'worktreeIds' in selection ? selection.worktreeIds.map((worktreeId) => ({ worktreeId, ok: false, handedBackWith: [] })) : [],
      eligibility: async () => [],
      mandate: () => null,
      active: () => [],
      setState() {},
      resolveNeed: async () => ({ ok: false, error: UNAVAILABLE })
    },
    brain: {
      judge: async () => UNAVAILABLE,
      wake() {},
      ready: () => false
    },
    supervisor: {
      send: async () => ({ sent: false, reason: UNAVAILABLE }),
      stepIn: async () => ({ sent: false, reason: UNAVAILABLE }),
      startSession: async () => ({ sessionId: null, error: UNAVAILABLE }),
      restartWorker: async () => ({ sessionId: null, error: UNAVAILABLE }),
      park() {},
      recordDenial() {}
    },
    shipping: {
      runDoneWhen: async () => ({ pass: false, output: UNAVAILABLE }),
      startReview: async () => ({ started: false, reason: UNAVAILABLE }),
      judgeFinding: async () => {},
      openPr: async () => ({ ok: false, reason: UNAVAILABLE }),
      merge: async () => ({ ok: false, reason: UNAVAILABLE }),
      mergeMainIn: async () => ({ ok: false, reason: UNAVAILABLE }),
      reconcileOutbox: async () => {},
      cancelOutbox: () => 0
    },
    report: {
      report: emptyReport,
      status: () => ({ handoffs: [], needsYouCount: 0 }),
      sidebarStatus: () => ({})
    }
  }
}

function lines(value: unknown): string[] {
  return typeof value === 'string' ? value.split('\n').map((line) => line.trim()).filter((line) => line !== '') : []
}

function readSettings(context: PluginContext): AvatarSettings {
  const level = context.getSetting('default-level')
  const agent = context.getSetting('brain-agent')
  const model = context.getSetting('brain-model')
  const timeout = context.getSetting('judgment-timeout-seconds')
  return {
    defaultLevel: LEVELS.includes(level as Level) ? (level as Level) : 'full',
    switches: {
      messaging: context.getSetting('switch-messaging') === true,
      historyRewrite: context.getSetting('switch-history-rewrite') === true,
      deploys: context.getSetting('switch-deploys') === true
    },
    houseRules: lines(context.getSetting('house-rules')),
    allowCommands: lines(context.getSetting('allow-commands')),
    denyCommands: lines(context.getSetting('deny-commands')),
    deployCommands: lines(context.getSetting('deploy-commands')),
    brainAgent: AGENTS.includes(agent as AgentKind) ? (agent as AgentKind) : 'claude',
    brainModel: typeof model === 'string' && model.trim() !== '' ? model.trim() : null,
    judgmentTimeoutSeconds: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : 55
  }
}

/**
 * Builds the avatar's shared state: the store, the event bus, the journal writer, the needs queue,
 * the settings reader and stub services for every module. `store` defaults to the plugin's own
 * SQLite store.
 */
export function createApp(context: PluginContext, store?: AvatarStore): AvatarApp {
  const avatarStore = store ?? createAvatarStore(context.openStore(avatarMigrations))
  const listeners = new Set<(event: AvatarBusEvent) => void>()

  const emit = (event: AvatarBusEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        context.log(`avatar bus listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const needs: NeedsQueue = {
    add(item) {
      const created = { ...item, id: randomUUID(), createdAt: app.now(), resolvedAt: null, resolution: null }
      avatarStore.needs.put(created)
      emit({ type: 'needs-changed' })
      return created
    },
    list(opts = {}) {
      return avatarStore.needs
        .list(opts.worktreeId === undefined ? {} : { worktreeId: opts.worktreeId })
        .filter((item) => opts.open === undefined || (item.resolvedAt === null) === opts.open)
    },
    close(id, resolution) {
      const item = avatarStore.needs.get(id)
      if (item === null || item.resolvedAt !== null) return
      avatarStore.needs.put({ ...item, resolvedAt: app.now(), resolution })
      emit({ type: 'needs-changed' })
    }
  }

  const app: AvatarApp = {
    context,
    store: avatarStore,
    settings: () => readSettings(context),
    services: createStubServices(),
    journal(worktreeId, kind: JournalKind, data) {
      const entry = avatarStore.appendJournal({ at: app.now(), worktreeId, kind, data })
      emit({ type: 'journal', entry })
      return entry
    },
    needs,
    on(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    emit,
    now: () => Date.now()
  }
  return app
}
