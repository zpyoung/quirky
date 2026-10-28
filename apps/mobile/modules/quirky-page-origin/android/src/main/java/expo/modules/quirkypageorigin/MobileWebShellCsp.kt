package expo.modules.quirkypageorigin

/**
 * Sent as a response header on the document and nowhere else: a served document must never carry
 * its own policy, so there is no meta tag to find and no bundle change that can relax it. Kept in
 * step with the iOS copy.
 */
internal val MOBILE_WEB_SHELL_CSP = listOf(
  "default-src 'none'",
  "script-src 'self'",
  // Images and previews come from the activated generation or authenticated RPC bytes, never the network.
  "img-src 'self' data: blob:",
  "font-src 'none'",
  // The origin is one read-only directory behind the manifest map, so 'self' reaches nothing the
  // page cannot already read, and the bootstrap page reads ./manifest.json through it. This is the
  // fence for fetch and XMLHttpRequest; the document-start script covers only the two things the
  // native layer cannot see.
  "connect-src 'self'",
  // Media previews play bytes downloaded through authenticated RPC, never a network URL.
  "media-src blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  // `about:` only, so a chat visual's srcdoc frame (which inherits this) keeps its own
  // `about:srcdoc` base and in-page links stay in it; no network base can apply.
  "base-uri about:",
  "form-action 'none'",
  "frame-ancestors 'none'"
).joinToString("; ")
