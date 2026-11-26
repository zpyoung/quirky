import type { PublicMethodSpec } from '../public-method-spec'
import { ADMIN_PUBLIC_METHODS } from './admin'
import { CHAT_PUBLIC_METHODS } from './chat'
import { EVENT_PUBLIC_METHODS } from './events'
import { UI_PUBLIC_METHODS } from './ui'

export const PUBLIC_METHOD_SPECS: readonly PublicMethodSpec[] = [
  ...CHAT_PUBLIC_METHODS,
  ...ADMIN_PUBLIC_METHODS,
  ...UI_PUBLIC_METHODS,
  ...EVENT_PUBLIC_METHODS
]

const SPEC_BY_METHOD = new Map<string, PublicMethodSpec>()
const SPEC_BY_CLI_PATH = new Map<string, PublicMethodSpec>()

for (const spec of PUBLIC_METHOD_SPECS) {
  if (SPEC_BY_METHOD.has(spec.method)) {
    throw new Error(`duplicate_public_method:${spec.method}`)
  }
  SPEC_BY_METHOD.set(spec.method, spec)
  const pathKey = spec.cliPath.join(' ')
  if (SPEC_BY_CLI_PATH.has(pathKey)) {
    throw new Error(`duplicate_public_cli_path:${pathKey}`)
  }
  SPEC_BY_CLI_PATH.set(pathKey, spec)
}

export function publicSpecForMethod(name: string): PublicMethodSpec | undefined {
  return SPEC_BY_METHOD.get(name)
}

export function publicSpecForCliPath(path: readonly string[]): PublicMethodSpec | undefined {
  return SPEC_BY_CLI_PATH.get(path.join(' '))
}
