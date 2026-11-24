// The one read of the QUIRKY_LAYOUT_OWNER build switch: 'main' turns on the dark path where main
// decides every layout change. Off in every shipped build; deleted with the old path (phase F).
// Every switch point branches on QUIRKY_LAYOUT_OWNER_IS_MAIN, so grep finds them all.

/** Substituted by electron.vite.config.ts; absent (off) in tests, the CLI and the web client. */
declare const QUIRKY_LAYOUT_OWNER: 'window' | 'main' | undefined

export const QUIRKY_LAYOUT_OWNER_IS_MAIN =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  typeof QUIRKY_LAYOUT_OWNER !== 'undefined' && QUIRKY_LAYOUT_OWNER === 'main'
