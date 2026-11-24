import { RuntimeClientError } from '../../runtime-client'

export function resolveCompatibilityCliCommand(): 'quirky' | 'quirky-ide' | 'quirky-dev' {
  const configured = process.env.QUIRKY_CLI_COMMAND
  if (configured === 'quirky' || configured === 'quirky-ide' || configured === 'quirky-dev') {
    return configured
  }
  return process.platform === 'linux' ? 'quirky-ide' : 'quirky'
}

export function resolvePackagedWindowsCompatibilityCommand(): 'quirky' | 'quirky-ide' | undefined {
  if (process.env.QUIRKY_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.QUIRKY_CLI_COMMAND
  if (command === 'quirky' || command === 'quirky-ide') {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged Quirky launcher did not provide a valid resume command. No question was created.'
  )
}

export async function flushOrchestrationStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function isDevCliInvocation(): boolean {
  return (
    process.env.QUIRKY_DEV_CLI_INVOCATION === '1' ||
    (process.env.QUIRKY_USER_DATA_PATH?.includes('quirky-dev') ?? false)
  )
}
