import type { QuirkyRuntimeService } from '../quirky-runtime'

export type WorkerTerminalReleaseRuntime = Pick<
  QuirkyRuntimeService,
  | 'retireStructuredAgentSessionTabFromSnapshot'
  | 'forgetStructuredSessionMail'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'getOrchestrationFleetAgentStatusSnapshot'
  | 'getOrchestrationDb'
  | 'showTerminal'
  | 'resolveTerminalHandleByProcessIncarnation'
  | 'getTerminalPaneKey'
  | 'getTerminalProcessIncarnation'
  | 'getTerminalLivenessVerdict'
  | 'checkTerminalAgentPresence'
  | 'getOrchestrationDispatchAuthority'
  | 'ensureStructuredAgentSessionHost'
  | 'inspectTerminalProcessIncarnationLiveness'
  | 'closeTerminal'
  | 'getExactWorkerProviderSession'
  | 'readTerminal'
  | 'notifyMessageArrived'
>
