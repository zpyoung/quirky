/** Serves the window's own react/jsx-runtime to runtime-loaded plugin modules through the import map. */
import * as JsxRuntime from 'react/jsx-runtime'

// `export *` from this CommonJS package drops names in the bundle, so each is bound explicitly
export const { Fragment, jsx, jsxs } = JsxRuntime

export default JsxRuntime
