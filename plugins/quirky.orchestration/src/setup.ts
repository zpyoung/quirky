import type { PluginCaller, PluginContext } from '@quirky/protocol'
import type { OrchestrationPolicy, OrchestrationSkillInstallParams, OrchestrationSkillStatus } from './ui-contracts'
import type { OrchestrationWorkerCore } from './worker-integration'
import { installOrchestrationSkill, inspectOrchestrationSkill, renderOrchestrationSkill, type DetectedSkillAgent } from './skill'
import { saveNestedWorkerMaxDepth } from './store'

const INSTALL_COMMAND = 'quirky orchestration skill-install'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentList(raw: unknown): DetectedSkillAgent[] {
  if (!isObject(raw) || !Array.isArray(raw.agents)) throw new Error('quirky.agents/list returned an invalid agent listing')
  const detected: DetectedSkillAgent[] = []
  for (const entry of raw.agents) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.label !== 'string' || typeof entry.installed !== 'boolean') {
      throw new Error('quirky.agents/list returned an invalid agent entry')
    }
    if (entry.installed) detected.push({ id: entry.id, label: entry.label })
  }
  return detected
}

function detectionError(error: unknown): OrchestrationSkillStatus {
  return {
    state: 'error',
    agents: [],
    installCommand: INSTALL_COMMAND,
    text: `Could not detect agent CLIs: ${errorText(error)}. Retry or re-check after restoring the Agents service.`
  }
}

async function detectedAgents(context: PluginContext): Promise<DetectedSkillAgent[]> {
  return agentList(await context.call('quirky.agents/list', {}))
}

/** Allow only unbound first-party operator clients; role strings do not establish authority. */
export function canChangePolicy(caller: PluginCaller): boolean {
  return caller.role !== 'plugin' && caller.role !== 'mobile' &&
    caller.sessionId === undefined && caller.sessionAuthority === undefined && caller.deviceId === undefined
}

function requireOperator(context: PluginContext, caller: PluginCaller): void {
  if (!canChangePolicy(caller)) {
    throw context.error('invalid-params', 'Nested worker depth can only be changed by an unbound operator client.')
  }
}

export function createSetup(context: PluginContext, core: Pick<OrchestrationWorkerCore, 'store' | 'nestedWorkerMaxDepth'>) {
  return {
    skillShow() {
      return { skill: renderOrchestrationSkill() }
    },

    async skillStatus(): Promise<OrchestrationSkillStatus> {
      try {
        return inspectOrchestrationSkill(await detectedAgents(context))
      } catch (error) {
        return detectionError(error)
      }
    },

    async skillInstall(raw: unknown): Promise<OrchestrationSkillStatus> {
      if (!isObject(raw)) throw context.error('invalid-params', 'skillInstall params must be an object.')
      const params = raw
      if (Object.keys(params).some((key) => key !== 'agents')) {
        throw context.error('invalid-params', 'skillInstall accepts only an optional agents array.')
      }
      const rawAgents = params.agents
      if (rawAgents !== undefined && (!Array.isArray(rawAgents) || rawAgents.some((agent) => typeof agent !== 'string'))) {
        throw context.error('invalid-params', 'agents must be an array of detected agent IDs.')
      }
      const requested = rawAgents as OrchestrationSkillInstallParams['agents']
      let agents: DetectedSkillAgent[]
      try {
        agents = await detectedAgents(context)
      } catch (error) {
        return detectionError(error)
      }
      const selected = requested
      if (selected !== undefined) {
        const detected = new Set(agents.map((agent) => agent.id))
        const unknown = selected.filter((agent) => !detected.has(agent))
        if (unknown.length > 0) {
          throw context.error('invalid-params', `agents must be detected agent IDs; not detected: ${unknown.join(', ')}`)
        }
      }
      return installOrchestrationSkill(agents, selected)
    },

    policyShow(_params: unknown, caller: PluginCaller): OrchestrationPolicy {
      return { nestedWorkerMaxDepth: core.nestedWorkerMaxDepth, canChange: canChangePolicy(caller) }
    },

    policySet(raw: unknown, caller: PluginCaller): OrchestrationPolicy {
      requireOperator(context, caller)
      if (!isObject(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'nestedWorkerMaxDepth')) {
        throw context.error('invalid-params', 'policySet accepts only nestedWorkerMaxDepth.')
      }
      const value = raw.nestedWorkerMaxDepth
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw context.error('invalid-params', 'nestedWorkerMaxDepth must be an integer greater than or equal to 1.')
      }
      saveNestedWorkerMaxDepth(core.store, value)
      return { nestedWorkerMaxDepth: core.nestedWorkerMaxDepth, canChange: true }
    }
  }
}
