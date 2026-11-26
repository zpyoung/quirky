import type { DestructiveSpec, PublicMethodSpec } from './public-method-spec'
import { publicSpecForMethod } from './public-methods'

/**
 * How an RPC method relates to the public CLI/API surface. Every method the runtime registers is
 * classified, so a new method cannot ship without deciding whether agents may reach it.
 */
export type MethodClass =
  | { kind: 'public'; spec: PublicMethodSpec }
  | { kind: 'internal'; reason: string }
  | { kind: 'legacy-cli'; family: string }
  | { kind: 'unstable'; destructive?: DestructiveSpec }

function legacy(family: string): MethodClass {
  return { kind: 'legacy-cli', family }
}

function internal(reason: string): MethodClass {
  return { kind: 'internal', reason }
}

const UNSTABLE: MethodClass = { kind: 'unstable' }

function destructive(category: DestructiveSpec['category']): MethodClass {
  return { kind: 'unstable', destructive: { category } }
}

const DESKTOP_VIEW_SYNC = 'desktop and mobile view synchronization'
const CHAT_STREAM = 'desktop and mobile chat view subscription'
const UI_PREFERENCE_SYNC = 'renderer UI preference sync'

/** Exact names win over namespace defaults. Public specs are never listed here. */
export const METHOD_CLASSIFICATION: Readonly<Record<string, MethodClass>> = {
  'status.get': legacy('status'),

  'ui.get': internal(UI_PREFERENCE_SYNC),
  'ui.set': internal(UI_PREFERENCE_SYNC),
  'ui.setCollapsed': internal(UI_PREFERENCE_SYNC),
  'ui.recordFeatureInteraction': internal('feature usage telemetry from the renderer'),
  'ui.getJiraQuickFilters': internal(UI_PREFERENCE_SYNC),
  'ui.setJiraQuickFilters': internal(UI_PREFERENCE_SYNC),
  'ui.getJiraSavedFilters': internal(UI_PREFERENCE_SYNC),
  'ui.mutateJiraSavedFilters': internal(UI_PREFERENCE_SYNC),

  'git.discard': destructive('file-overwrite-delete'),
  'git.bulkDiscard': destructive('file-overwrite-delete'),
  'git.push': destructive('file-overwrite-delete'),

  'agentSession.rewind': destructive('chat-discard-rewind'),
  'agentSession.respondToApproval': destructive('permission-answers'),
  'agentSession.respondToQuestion': destructive('permission-answers'),
  'agentSession.subscribe': internal(CHAT_STREAM),
  'agentSession.subscribeAvailability': internal(CHAT_STREAM),
  'agentSession.subscribeStatus': internal(CHAT_STREAM),
  'agentSession.subscribeTurnCompletions': internal(CHAT_STREAM),
  'agentSession.unsubscribe': internal(CHAT_STREAM),

  'session.tabs.subscribe': internal(DESKTOP_VIEW_SYNC),
  'session.tabs.subscribeAll': internal(DESKTOP_VIEW_SYNC),
  'session.tabs.unsubscribe': internal(DESKTOP_VIEW_SYNC),
  'session.tabs.unsubscribeAll': internal(DESKTOP_VIEW_SYNC),

  'folderWorkspace.list': legacy('agent'),
  'folderWorkspace.update': legacy('reference'),
  'folderWorkspace.delete': destructive('workspace-delete'),

  'ssh.getState': legacy('host'),
  'ssh.listTargetSummaries': legacy('host'),

  'plugins.list': UNSTABLE,
  'plugins.setEnabled': UNSTABLE,

  'network.browserTunnel': internal('browser network tunnel between the host and a client'),

  'notifications.registerPush': internal('mobile push registration'),
  'notifications.unregisterPush': internal('mobile push registration'),
  'notifications.testPush': internal('mobile push registration'),
  'notifications.subscribe': internal('desktop and mobile notification stream'),
  'notifications.unsubscribe': internal('desktop and mobile notification stream'),
  'notifications.getMissedSince': internal('desktop and mobile notification stream')
}

/**
 * Longest prefix wins, and each prefix ends where a method name segment ends. There is no bare
 * `ui.` entry, because new `ui.*` methods are classified by exact name or by a public spec.
 */
export const NAMESPACE_DEFAULTS: Readonly<Record<string, MethodClass>> = {
  // Namespaces a hand-written CLI family already wraps.
  'accounts.': legacy('account'),
  'agent.': legacy('agent'),
  'agentTeams.': legacy('claude-teams'),
  'aiVault.': legacy('search'),
  'ask.': legacy('ask'),
  'automation.': legacy('automations'),
  'browser.': legacy('browser'),
  'clipboard.': legacy('clipboard'),
  'computer.': legacy('computer'),
  'diagnostics.': legacy('diagnostics'),
  'emulator.': legacy('emulator'),
  'files.': legacy('file'),
  'heimdall:': legacy('heimdall'),
  'host.': legacy('host'),
  'jira.': legacy('jira'),
  'ledger.': legacy('ledger'),
  'linear.': legacy('linear'),
  'loops:': legacy('loop'),
  'managedServer.': legacy('environment'),
  'orchestration.': legacy('orchestration'),
  'project.': legacy('project'),
  'projectHostSetup.': legacy('project'),
  'reference.': legacy('reference'),
  'repo.': legacy('repo'),
  'runtime.automaticWork.': legacy('serve'),
  'skills.': legacy('skills'),
  'speech.': legacy('speech'),
  'terminal.': legacy('terminal'),
  'terminalDaemon.': legacy('terminal-daemon'),
  'worktree.': legacy('worktree'),

  // Desktop and mobile plumbing an agent has no reason to call.
  'agentSessionAttachment.': internal('chat attachment upload for desktop and mobile clients'),
  'desktopBrowserBridge.': internal('desktop browser bridge handshake'),
  'layout.': internal('window layout stream and commands'),
  'mobileRelay.': internal('mobile relay projection'),
  'mobileWeb.': internal('phone web bundle delivery'),
  'nativeChat.': internal(CHAT_STREAM),
  'pairing.': internal('device pairing'),
  'plugins.': internal('plugin panel host'),
  'quirkyd.': internal('quirkyd migration and census'),
  'runtime.clientCapabilities.': internal('client capability negotiation'),
  'runtime.clientEvents.': internal('desktop and mobile client event stream'),
  'sidebarInputs.': internal('sidebar input feed'),
  'sidebarSession.': internal('sidebar input feed'),
  'updater.': internal('desktop app updater'),

  // Reachable only through `quirky rpc`.
  'agentSession.': UNSTABLE,
  'folderWorkspace.': UNSTABLE,
  'git.': UNSTABLE,
  'github.': UNSTABLE,
  'gitlab.': UNSTABLE,
  'hostedReview.': UNSTABLE,
  'managedRuntime.': UNSTABLE,
  'markdown.': UNSTABLE,
  'preflight.': UNSTABLE,
  'projectGroup.': UNSTABLE,
  'session.tabs.': UNSTABLE,
  'settings.': UNSTABLE,
  'ssh.': UNSTABLE,
  'stats.': UNSTABLE,
  'workspacePorts.': UNSTABLE
}

const PREFIXES_LONGEST_FIRST = Object.keys(NAMESPACE_DEFAULTS).sort(
  (a, b) => b.length - a.length
)

/**
 * A public spec first, then the exact entry, then the longest namespace prefix. `undefined` means
 * the method is unclassified, which the coverage test reports as a failure.
 */
export function classifyMethod(name: string): MethodClass | undefined {
  const spec = publicSpecForMethod(name)
  if (spec) {
    return { kind: 'public', spec }
  }
  const exact = Object.hasOwn(METHOD_CLASSIFICATION, name) ? METHOD_CLASSIFICATION[name] : undefined
  if (exact) {
    return exact
  }
  const prefix = PREFIXES_LONGEST_FIRST.find((candidate) => name.startsWith(candidate))
  return prefix === undefined ? undefined : NAMESPACE_DEFAULTS[prefix]
}
