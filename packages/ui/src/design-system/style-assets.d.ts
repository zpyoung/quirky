/** Bun's explicit `with { type: 'text' }` imports expose stylesheet source text. */
declare module '*.css' {
  const source: string
  export default source
}
