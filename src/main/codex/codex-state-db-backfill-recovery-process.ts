import type { ChildProcessHandle } from '@quirky/process-host/process-spec'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { terminateCodexProbeChild } from '../rate-limits/codex-probe-termination'
import {
  createProviderSpawnSpec,
  type ProviderCloseRequest
} from '../provider-process/provider-process-supervisor'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import { stopSupervisedChildProcess } from '../provider-process/supervised-child-process-stop'
import { guardSupervisedProviderGroup } from '../provider-process/provider-group-orphan-guard'

const BACKFILL_RECOVERY_KILL_SITE = 'codex-state-db-backfill-recovery'
// Codex drains on its stdin end, as the Codex connection's root-only close asks; one value
// for the spawn spec (a gone Quirky) and the stop (Quirky stopping it), so they cannot drift.
const BACKFILL_RECOVERY_CLOSE_REQUEST: ProviderCloseRequest = 'stdin-end'

export type CodexBackfillRecoveryProcess = {
  child: ChildProcessHandle
  supervised: boolean
}

/** Starts the read-only app-server whose presence lets Codex finish its own backfill. */
export function spawnCodexBackfillRecoveryProcess(
  codexHomePath: string,
  spawnProcess: CodexAppServerSpawn,
  resolveCommand: () => string
): CodexBackfillRecoveryProcess {
  const command = resolveCommand()
  // Kept alive up to an hour; on POSIX the supervisor stops it with Quirky, however Quirky exits.
  const spawnSpec = createProviderSpawnSpec(
    { command, args: [...CODEX_READ_ONLY_APP_SERVER_ARGS], cwd: codexHomePath },
    withCliRuntimeOnPath(command, {
      ...process.env,
      CODEX_HOME: codexHomePath
    }),
    process.platform,
    { lifetime: 'session', closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST }
  )
  const child = spawnProcess(spawnSpec.program, spawnSpec.args, {
    cwd: codexHomePath,
    stdio: ['pipe', 'ignore', 'ignore', ...spawnSpec.groupReportStdio],
    windowsHide: true,
    env: spawnSpec.env,
    ...(spawnSpec.supervised ? { detached: true } : {})
  })
  guardSupervisedProviderGroup(child, {
    site: BACKFILL_RECOVERY_KILL_SITE,
    supervised: spawnSpec.supervised
  })
  return { child, supervised: spawnSpec.supervised }
}

export async function stopCodexBackfillRecoveryProcess(
  child: ChildProcessHandle,
  supervised: boolean
): Promise<void> {
  if (supervised) {
    // A session supervisor turns stdin end into its group stop, as a Codex connection close does.
    await stopSupervisedChildProcess(child, {
      site: BACKFILL_RECOVERY_KILL_SITE,
      closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST
    })
    return
  }
  await terminateCodexProbeChild(child)
}
