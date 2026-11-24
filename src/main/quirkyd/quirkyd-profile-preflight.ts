import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preflightProfileStateRuntime } from '../persistence/profile-state/profile-state-runtime-preflight'
import {
  QUIRKYD_STARTUP_PREFLIGHT_FLAG,
  QUIRKYD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseQuirkydProfilePreflight,
  quirkydProfilePreflightResponseSchema,
  type QuirkydProfilePreflightResponse
} from '../../shared/quirkyd-profile-preflight'
import { readQuirkydArtifactIdentity } from './quirkyd-artifact-identity'
import { QUIRKYD_EXIT_CONFIGURATION } from './quirkyd-configuration-exit'
import {
  QUIRKYD_SERVER_ENTRY_FILENAME,
  QUIRKYD_VERSION_FILENAME
} from '../../shared/quirkyd-artifacts'
import { QUIRKYD_NODE_RUNTIME_IDENTITY } from '../../shared/quirkyd-node-runtime-identity'
import { runProcess } from '@quirky/process-host'
import { preflightQuirkydNativeRuntime } from './quirkyd-runtime-native-preflight'
import { quirkydCompileCacheEnv } from './quirkyd-compile-cache'
import {
  isRunningAsBundledQuirkydRuntime,
  QuirkydBundledRuntimeError,
  resolveBundledQuirkydSlot
} from './quirkyd-bundled-runtime'

/** Check every packaged start before a profile index, data-root lock or import is touched. */
export async function preflightBundledQuirkydStartup(): Promise<void> {
  const directory = resolveBundledQuirkydSlot()
  if (!isRunningAsBundledQuirkydRuntime(directory)) {
    return
  }
  const identity = await readInstalledVersion(directory)
  const nonce = randomUUID()
  // Keep disposable SQLite ownership and native state out of the serving process.
  const result = await runProcess({
    program: process.execPath,
    args: [join(directory, QUIRKYD_SERVER_ENTRY_FILENAME), QUIRKYD_STARTUP_PREFLIGHT_FLAG, nonce],
    // The preflight compiles the same bundle again, so it shares the server's code cache.
    env: { ...process.env, QUIRKY_BACKGROUND_LAUNCH: '1', ...quirkydCompileCacheEnv(directory) },
    timeoutMs: QUIRKYD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const Failure = result.code === QUIRKYD_EXIT_CONFIGURATION ? QuirkydBundledRuntimeError : Error
    throw new Failure(`The bundled Quirky runtime failed readiness: ${result.stderr}`)
  }
  try {
    parseQuirkydProfilePreflight(result.stdout, nonce, QUIRKYD_NODE_RUNTIME_IDENTITY, identity)
  } catch (cause) {
    throw new QuirkydBundledRuntimeError(
      'The bundled runtime returned invalid readiness identity',
      {
        cause
      }
    )
  }
}

/** Only disposable state is opened; no server, profile index or host adapters are installed. */
export async function runQuirkydProfilePreflight(
  nonce: string | undefined,
  options: { nativeFeatures?: boolean } = {}
): Promise<void> {
  const checkedNonce = z.string().uuid().parse(nonce)
  const directory = resolveBundledQuirkydSlot()
  let artifactVersion: string
  try {
    artifactVersion = await readQuirkydArtifactIdentity(directory)
  } catch (cause) {
    throw new QuirkydBundledRuntimeError('The bundled Quirky artifacts are incomplete or altered', {
      cause
    })
  }
  const result = await preflightProfileStateRuntime()
  // Why only inside the pinned runtime: a host Node rollback launcher never serves this slot.
  if (isRunningAsBundledQuirkydRuntime(directory)) {
    await preflightQuirkydNativeRuntime(options)
  }
  const response: QuirkydProfilePreflightResponse = {
    type: 'quirky_profile_state_ready',
    nonce: checkedNonce,
    runtime: 'node',
    runtimeVersion: process.versions.node,
    artifactVersion,
    ...result
  }
  console.log(JSON.stringify(response))
}

async function readInstalledVersion(directory: string): Promise<string> {
  try {
    return quirkydProfilePreflightResponseSchema.shape.artifactVersion.parse(
      (await readFile(join(directory, QUIRKYD_VERSION_FILENAME), 'utf8')).trim()
    )
  } catch (cause) {
    throw new QuirkydBundledRuntimeError(
      'The installed Quirky artifact version is missing or invalid',
      {
        cause
      }
    )
  }
}
