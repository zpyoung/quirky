// The one read of the QUIRKY_SIDEBAR_INPUTS build switch: 'main' turns on the dark path where main
// produces the sidebar's inputs. Off in every shipped build; deleted once the sidebar reads main.
// Every switch point branches on QUIRKY_SIDEBAR_INPUTS_IS_MAIN, so grep finds them all. A new main
// producer is a runtime field, `QUIRKY_SIDEBAR_INPUTS_IS_MAIN ? new Producer() : null` (a layer class
// only if it must override runtime hooks); its RPC joins SIDEBAR_INPUT_METHODS and its domain joins
// the feed the window's sidebar reads (sidebar-inputs-feed-domains.ts).

/** Substituted by electron.vite.config.ts; absent (off) in tests, the CLI and the web client. */
declare const QUIRKY_SIDEBAR_INPUTS: 'window' | 'main' | undefined

export const QUIRKY_SIDEBAR_INPUTS_IS_MAIN =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  typeof QUIRKY_SIDEBAR_INPUTS !== 'undefined' && QUIRKY_SIDEBAR_INPUTS === 'main'
