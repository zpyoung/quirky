/** Serves the window's own react-dom (portals, flushSync) to runtime-loaded plugin modules through the import map. */
import * as ReactDom from 'react-dom'

// `export *` from this CommonJS package drops names in the bundle, so each is bound explicitly
export const { createPortal, flushSync, version } = ReactDom

export default ReactDom
