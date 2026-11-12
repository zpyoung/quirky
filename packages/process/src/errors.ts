/** Reports that a command exited but its output stream did not finish within the stall window. */
export class ProcessStalledError extends Error {
  constructor(readonly command: string, readonly attempts: number) {
    super(`${command} exited but its output did not end`)
    this.name = 'ProcessStalledError'
  }
}

/** Reports that a disposed process runner was asked to start another command. */
export class ProcessRunnerDisposedError extends Error {
  constructor(owner: string) {
    super(`process runner "${owner}" is disposed`)
    this.name = 'ProcessRunnerDisposedError'
  }
}
