# Native browser pane page events

## Status & amendments
Written 2026-10-29 when the item resumed against the fork's `patch/webview-native-events`, which adds native page requests to Electrobun. It covers the deferred Native flows of `sa-browser-pane` SC8 to SC11 and DF2/DF6, and follows the binding decisions in `docs/loop/decisions/sa-browser-pane-native-events.md` D1 to D4. Self-reviewed against browser.md flows 7 to 9. The tech decisions are the last section; there's no separate tech spec.

## Purpose
A person browsing in a Native pane gets the page events a browser gives them, with the same prompts, policy and download shelf Watch already has. Native stays the system webview. Nothing here routes human browsing to Chrome or fakes a native answer.

## Flows in scope
1. **Dialogs.** `alert`, `confirm` and `prompt` show as the pane's prompt overlay, naming the origin. The page gets the real answer, including Unicode prompt text. One prompt per page: a second is declined at once. An unanswered prompt is declined after 120 seconds. Navigating the pane declines a pending prompt, so its answer can't reach the next page.
2. **Sign-in.** A basic, digest, NTLM or Negotiate challenge shows the sign-in overlay. Credentials go from the overlay straight to the view. They are never sent to the daemon, persisted or logged. `pane respond` can decline a Native sign-in but not complete one.
3. **Certificates.** A certificate the system doesn't trust shows the certificate overlay. Proceed is offered and accepted only for loopback, `localhost` and `.localhost` hosts. A remote host can't proceed, even through the API. Trusted certificates never prompt, and there's no global TLS bypass.
4. **External apps.** A link the webview can't load itself shows an origin-naming prompt when three things hold: it came from a user gesture, its scheme is allow-listed (`mailto`, `tel`, `sms`, `facetime`, `facetime-audio`, `zoommtg`, `zoomus`, `msteams`, `slack`), and the browser UI accepts it. Only then does the OS open it. `javascript:`, `data:` and `file:` are WebKit-handled and can never reach this path.
5. **Downloads.** The daemon reserves a collision-free name in the OS Downloads directory before the view writes anything. The shelf shows name, bytes and state (downloading, completed, canceled, error). Cancel affects that download only. A completed file can Open or Show in folder, and Dismiss removes only the shelf entry. The page never chooses a path.
6. **Popups.** An HTTP(S) popup opens in a small host-owned window titled by its origin, at most four every two seconds per pane. It is the page WebKit created for the opener, so `window.opener`, the target name and a form's POST body survive. The popup's `window.close()` closes the window, and closing the main window closes its popups.

## Non-goals
- `beforeunload` prompts: WKWebView has no public API for them.
- Native hard reload: owned by `sa-browser-pane-native-host-controls`.
- Linux and Windows. The fork reports native page requests unsupported there (`deferred: platform`).
- Page requests inside an adopted popup. They keep WebKit's defaults, see D12.

## Scenarios
- **SC-1** Given a Native pane whose page calls `prompt('Name?', 'x')`, when `pane respond --accept --text 'héllo 世界'` runs, then the page receives `héllo 世界` and the prompt leaves pane state.
- **SC-2** Given a pending Native confirm, when 120 seconds pass with no answer, then the page receives `false` and a late answer is rejected.
- **SC-3** Given a Native sign-in prompt, when the CLI sends credentials, then the daemon refuses them. When the overlay accepts, the view gets the typed credentials and pane state never contains them.
- **SC-4** Given certificate prompts for `example.test` and `127.0.0.1`, only the loopback one can proceed.
- **SC-5** Given an existing `report.pdf` in Downloads, a Native download of `../../report.pdf` is written as `report (1).pdf` in Downloads, and cancelling a second download leaves the first running.
- **SC-6** Given five popups within two seconds, four open and the fifth is declined. A `javascript:` popup is declined.

## Decisions locked (tech)
- **Layers.** The fork adds `BrowserView.setNativeRequestHandling`, its request events, `respondToNativeRequest`, `cancelDownload` and `popupRequestId` adoption. The desktop host enables every kind on the claimed view and relays the events over the shell RPC. `packages/ui` exposes them through generic `NativeBrowserOptions`/`NativeBrowserHandle` members, and `quirky.browser` applies the policy. Plugin API 1.1.0 adds those optional members.
- **Daemon is the policy owner.** The pane window relays each request with `paneNativeRequest` and gets either a visible prompt ID or an immediate answer. The daemon sends answers back as the `paneNative` event, keyed by native request ID, and the window applies them to its handle. Expiry and download progress come back through `paneNativeUpdate`. Both relay methods accept only the UI role.
- **Two deadlines.** The daemon fails a prompt closed at 120 seconds. The host gives native requests 125 seconds, so the daemon's answer normally lands first and the native deadline is the backstop if the renderer goes away.
- **Popups are hosted by the desktop host.** The plugin decides allow or decline; the host adopts the parked WebKit page into a `BrowserView` in its own `BrowserWindow`.
