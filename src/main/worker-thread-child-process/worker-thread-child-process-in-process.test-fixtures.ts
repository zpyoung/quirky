import { spawnProcess } from '@quirky/process-host'
import type { WorkerThreadChildSpec } from './worker-thread-child-process-protocol'

// Mock target for suites that drive a probe's child directly: spawns in-process,
// so their own child_process/@quirky/process-host mocks still apply.
export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec) {
  return spawnProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
}
