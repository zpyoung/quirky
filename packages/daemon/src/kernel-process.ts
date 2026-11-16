import { createProcessRunner, type OwnedProcessRunner } from '@quirky/process'

/** The runner for subprocesses the daemon itself starts; killed by stopAllProcesses on daemon stop. */
export const kernelProcess: OwnedProcessRunner = createProcessRunner({ owner: 'kernel' })
