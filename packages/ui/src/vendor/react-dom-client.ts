/** Serves the window's own react-dom/client to runtime-loaded plugin modules through the import map. */
import * as ReactDomClient from 'react-dom/client'

// `export *` from this CommonJS package drops names in the bundle, so each is bound explicitly
export const { createRoot, hydrateRoot, version } = ReactDomClient as typeof ReactDomClient & { version: string }

export default ReactDomClient
