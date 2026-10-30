# Localhost Worktree Labels

A localhost link opened from a worktree can open at a worktree-named address, such as
`http://feature-login.quirky.localhost:<port>/`, that really reaches that worktree's dev server in
both the Native pane and agent Chrome. This spec is for whoever maintains the Browser plugin or the
Electrobun fork patch it rests on. The feature doc row is `browser.md:127` ("Open workspace ports as
worktree-specific Orca localhost URLs", off by default). The decisions are in
`docs/loop/decisions/sa-browser-localhost-label-routing.md`.

## How a label routes

- **The label proxy** is one HTTP server the Browser plugin starts on `127.0.0.1:<ephemeral>` the
  first time a label is registered. It routes by `Host`: `<label>.quirky.localhost` goes to the
  loopback origin registered for that label, with `Host` rewritten to the dev server's own. It also
  forwards WebSocket upgrades. It never dials anything but a registered loopback target.
- **Agent Chrome** reaches the proxy directly. Chromium resolves every `*.localhost` name to
  loopback, so the label URL's port lands on the proxy.
- **The Native pane** sets an Electrobun session proxy on its profile partition before it loads a
  label URL. The proxy sends only `quirky.localhost` hosts to the label proxy, through HTTP
  `CONNECT`, and every other request in the profile still connects directly. The label proxy
  answers `CONNECT` only for registered labels. This uses `Session.setProxy` from the fork patch
  `patch/per-view-proxy` (WebKit's `proxyConfigurations`, macOS 14 or later), so Native routing
  never depends on the system resolver.
- **App Transport Security** blocks plain-http loads in an app bundle except to `localhost` and IP
  literals, so the Native pane can't load `http://<label>.quirky.localhost` by default, with or
  without the proxy. Electrobun's config can't add Info.plist keys, so the desktop app's `postBuild`
  hook (`apps/desktop/scripts/allow-label-hosts.ts`) merges an exception for `quirky.localhost` and
  its subdomains. Every other plain-http host stays blocked.
- **A label** is the worktree folder's slug, or `<project>-main` for a primary checkout. A second
  origin with the same slug gets `-2`, `-3` and so on. One worktree and origin keep their label for
  the daemon's life.

## Scenarios

1. **SC-1: A terminal localhost link opens at its worktree label.** With Link Routing and Localhost
   Worktree Labels on, `openLink` for `http://localhost:5173/login?next=1` from worktree
   `feature-login` opens a Native pane at `http://feature-login.quirky.localhost:<proxy>/login?next=1`.
2. **SC-2: The Native pane reaches the worktree's server through the label.** The page,
   its subresources and its WebSockets arrive at the dev server with `Host: localhost:5173`.
3. **SC-3: Agent Chrome reaches the same server through the same label,** including
   subresources and WebSockets.
4. **SC-4: Labels are off by default.** With the setting off, `openLink` opens the localhost URL
   unchanged and `localhostLabelRegister` fails with "Localhost Worktree Labels are off".
5. **SC-5: Only loopback http targets get labels.** `https`, a non-loopback host or a missing port
   is rejected, so the proxy is never an open proxy.
6. **SC-6: The label proxy refuses other tunnels.** `CONNECT` to anything but a registered label
   gets 403, and an unknown label gets 404.
7. **SC-7: Native routing that can't be configured is reported.** Where the host can't set a
   session proxy (macOS before 14), the Native pane refuses the label URL with an error naming the
   macOS requirement, rather than loading it without the proxy.
8. **SC-8: Labels are listed.** `quirky browser localhost-label list` shows each label, its
   worktree, its target and its URL.

API and CLI: `quirky.browser/localhostLabelRegister {url, worktree}`,
`quirky.browser/localhostLabelList {}`, and the `localhost-label register|list` CLI group. Setting:
`quirky.browser/localhostWorktreeLabelsEnabled`, in Settings > Browser > Link Routing.

## Non-goals

- Port scanning. Quirky has no workspace port registry, so labels come from links a worktree opens
  (or an explicit register call), not from a ports panel.
- https dev servers, as in Orca.
- Linux and Windows. Electrobun reports the session proxy unsupported there.
- Labels that outlive the daemon. The proxy port is ephemeral, as in Orca.

## Tech decisions

- The proxy is `node:http` in the daemon: `request` and `upgrade` handle direct clients, and
  `connect` loops a tunnel back into the same server so tunnelled requests get the same routing
  and `Host` rewrite.
- The Native adapter derives the proxy port from the label URL itself and calls the desktop RPC
  `routeNativeBrowserLabels {viewId, owner, port}`. The main process checks the view's claim and
  sets `{type: 'http', host: '127.0.0.1', port, matchDomains: ['quirky.localhost']}` on the claimed
  partition, or returns `{routed: false}` when `Session.supportsProxy` is false.
- The shared label domain is `NATIVE_BROWSER_LABEL_DOMAIN` in `@quirky/protocol`.
