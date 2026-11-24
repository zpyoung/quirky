import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'

export type PreflightRuntimeContext = {
  wslDistro?: string | null
  wslDefault?: boolean
  projectRuntime?: ProjectExecutionRuntimeResolution
}
