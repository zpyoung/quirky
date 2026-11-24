import { spawnProcess } from '@orca/process-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { guardSupervisedProviderGroup } from '../provider-process/provider-group-orphan-guard'
import { SOURCE_CONTROL_KILL_SITE } from './source-control-local-process'
import type {
  SourceControlAgentSpawnInput,
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

export const spawnSourceControlAgent: SpawnSourceControlAgent = (input) => {
  const spawnEnv = input.env ?? process.env
  const child = spawnSupervisedAgent(input, spawnEnv)
  if (input.stdinMode === 'ignore') {
    child.stdin?.on?.('error', () => {})
    child.stdin?.end()
  }
  return child
}

// Under the provider supervisor, an Orca that quits or dies mid-run still stops the agent's group.
function spawnSupervisedAgent(
  input: SourceControlAgentSpawnInput,
  spawnEnv: NodeJS.ProcessEnv
): SpawnedSourceControlAgentProcess {
  const spec = createProviderSpawnSpec(
    {
      command: input.binary,
      args: input.args,
      ...(input.useCwdForNative && input.cwd !== undefined ? { cwd: input.cwd } : {})
    },
    withCliRuntimeOnPath(input.binary, spawnEnv),
    process.platform,
    { lifetime: 'one-shot' }
  )
  const child = spawnProcess({
    program: spec.program,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'pipe', ...spec.groupReportStdio]
  })
  guardSupervisedProviderGroup(child, {
    site: SOURCE_CONTROL_KILL_SITE,
    supervised: spec.supervised
  })
  return Object.assign(child, { supervised: spec.supervised })
}
