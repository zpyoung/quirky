import type { PiAgentKind } from '../../shared/pi-agent-kind'

export const QUIRKY_PI_PREFILL_EXTENSION_FILE = 'quirky-prefill.ts'

// Why: prefill-without-submit needs an env-var the bundled `quirky-prefill.ts`
// extension can read on session_start. Each kind owns its own variable so an
// OMP PTY never honors a Pi draft (or vice versa).
type PrefillAgentKind = Exclude<PiAgentKind, 'prime-agent'>

const PREFILL_ENV_VAR_BY_KIND: Record<PrefillAgentKind, string> = {
  pi: 'QUIRKY_PI_PREFILL',
  omp: 'QUIRKY_OMP_PREFILL'
}

export function getPiPrefillExtensionSource(kind: PrefillAgentKind): string {
  return ['export default function (pi) {', ...getPiPrefillHandlerSourceLines(kind), '}', ''].join(
    '\n'
  )
}

export function getPiPrefillHandlerSourceLines(
  kind: PrefillAgentKind,
  wrapInStatusOwner = false
): string[] {
  const envVar = PREFILL_ENV_VAR_BY_KIND[kind]
  const register = wrapInStatusOwner && kind === 'omp' ? 'onStatus' : 'pi.on'
  return [
    `  ${register}('session_start', async (event, ctx) => {`,
    '    if (!process.env.QUIRKY_PANE_KEY || ctx?.hasUI === false) return',
    ...(kind === 'pi' ? ["    if (event.reason !== 'startup') return"] : []),
    `    const prefill = process.env.${envVar}`,
    "    if (!prefill || typeof ctx?.ui?.setEditorText !== 'function') return",
    `    delete process.env.${envVar}`,
    '    try {',
    '      ctx.ui.setEditorText(prefill)',
    '    } catch {}',
    '  })'
  ]
}
