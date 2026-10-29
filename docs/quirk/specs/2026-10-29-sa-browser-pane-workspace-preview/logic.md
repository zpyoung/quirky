# Workspace document preview in the browser pane

## Status & amendments
Approved autonomously on 2026-10-29 for the requeued `sa-browser-pane-workspace-preview` item, built
against the fork patch `patch/isolated-preview-view` (Electrobun fork spec
`docs/quirk/specs/2026-10-29-electrobun-fork/logic.md`). One spec, with the technical decisions in
the last section. The item's decision log is
`docs/loop/decisions/sa-browser-pane-workspace-preview.md` (D1–D7 from the blocked iteration, D8 on).

## Purpose and conceptual model
A person reading an agent-written HTML report in the worktree wants to see it rendered, with its
scripts, styles and images, without that page being able to reach the internet, the person's
browsing profile, their devices or their Downloads folder. A browser pane page is one of two kinds:

- **A web page**, shown by an ordinary Native browsing guest in the pane's profile partition.
- **A workspace document page**, shown by an isolated preview guest. Its identity is one canonical
  HTML file inside the pane's worktree. It is served from `quirky-preview://<grant>/<path>` by the
  desktop host, never by the daemon's origin.

A **grant** is read authority for one mount of a document page: the document's folder, or only the
file itself when it sits at the worktree root. Grants are minted per mount and never persisted, so
a grant URL can't leak into history, storage or another session.

A **conversion** replaces the page with the other kind. Guest history can't survive it, because the
guest is replaced. The page keeps one level of provenance like Orca's `convertedFrom` and
`convertedTo` (browser.md section 1 item 10): Back first walks the guest's own history, then crosses
`convertedFrom`; Forward re-crosses `convertedTo`.

## Scope and non-goals
In scope: converting a Native pane to a document page, Back and Forward across the conversion,
converting back by typing an address, the isolation guarantees below, restore after restart, and
the API, CLI and pane UI for all of it.

Not in scope:
- Watch mode. Document previews run only in the Native browser; Watch refuses them.
- Converting by pasting a bare path into the address bar. Explicit `file://` and path navigation keep
  the direct local-file browsing sa-browser-pane D17 locked; conversion is the explicit
  `panePreview` method, CLI command and pane button.
- Linux, Windows and the plain web client: they show the existing unavailable state (D7, fork SC-11).
- Remote or SSH-owned worktrees. Grants read the local disk.

## Isolation guarantees
Every guarantee is enforced by the desktop host's WebKit configuration through the fork's public
Electrobun API, before any document content loads. CSP is a second line only.

1. Documents and assets load only from the preview scheme and only inside the grant. Traversal,
   symlinks, dotfiles and other grants get 404.
2. Each preview mount has its own nonpersistent website data store, shared with no browsing profile
   and no other preview.
3. Outbound network is blocked: a content rule list blocks every load outside the preview scheme,
   and Lockdown Mode removes WebRTC.
4. Camera, microphone, location and file-picker requests are denied without a prompt.
5. Downloads, popups and navigation off the grant are cancelled, with no event Quirky could act on.
6. The guest has no RPC bridge and no access to `views://` or `appdata://`.

## Scenarios
1. **SC1: Preview a workspace HTML document.** A Native pane on `https://example.com/start` runs
   `panePreview({pane, path:'report/index.html'})`. The pane becomes a document page:
   `document.path` is the canonical file, the grant reads `report/`, `url` is the grant URL,
   `convertedFrom` is `{kind:'url', url:'https://example.com/start'}`, and the pane queues navigation
   to the grant URL. Chrome never starts.
2. **SC2: In-grant links and guest history.** The page links to `second.html`; the guest reports the
   in-grant URL and `canGoBack:true`. Back walks guest history and stays on the document page.
3. **SC3: Back crosses the conversion.** With no guest history left, Back returns to
   `https://example.com/start` in a new browsing guest, with `convertedTo` set to the document.
4. **SC4: Forward re-crosses.** Forward mints a fresh grant for the same document and sets
   `convertedFrom` back to the web page.
5. **SC5: Typing an address leaves the document.** Navigating a document page converts it back to a
   web page with `convertedFrom` set to the document.
6. **SC6: Refusals.** A file outside the worktree, a non-HTML file, a file in a hidden folder, a
   missing file and a Watch pane are refused with an error and no state change.
7. **SC7: Root documents read only themselves.** A document at the worktree root gets an
   entry-only grant: its siblings, including `.env`, are unreadable.
8. **SC8: Restore.** Storage holds only `document.path` and `about:blank`. On the next `paneState`
   the pane gets a fresh grant, or a clear error if the file is gone.
9. **SC9: Unavailable host.** Where the host can't enforce isolation, the document page shows
   "Workspace document preview is unavailable here" and mounts nothing; Back still returns. The
   daemon can't see the host, so `panePreview` still converts the pane, and the pane offers no
   preview button there.
10. **SC10: A page can't break out.** A previewed page that fetches, beacons, opens WebSockets,
    gathers WebRTC candidates, submits forms, opens popups, downloads or navigates off-grant reaches
    no network listener and changes nothing outside the guest. (Native-only; see the handoff file.)

## Defect regressions
- A guest report of an address outside its grant is rejected (`browser_tab_changed`), so a page
  can't make the pane record an arbitrary URL.
- No grant URL appears in history, persisted pane rows or `convertedFrom`/`convertedTo`.
- The isolated preview never falls back to an ordinary view: an empty or invalid scheme fails
  creation in the SDK (fork review fix).

## Technical decisions
- **Electrobun API.** `BrowserView` option `isolatedPreview: { scheme, handler }`, tag attribute
  `isolated-preview`, `BrowserView.setIsolatedPreviewHandler`, `BrowserView.isIsolatedPreviewSupported()`.
  The desktop pins the private test devkit `2.0.5-quirky.0-isolated-preview-view` while this branch is
  developed; the pin moves to the released `2.0.5-quirky.N` when the fork releases.
- **Protocol** (`packages/protocol/src/native-browser.ts`): `NATIVE_BROWSER_PREVIEW_SCHEME`,
  preview navigation rules, `NativeBrowserPreviewGrant`, `nativeBrowserPreviewUrl`,
  `isNativeBrowserPreviewGrant`, `isNativeBrowserPreviewUrl`; `NativeBrowserOptions.preview` and
  `NativeBrowserCapability.previewAvailable`. Additive plugin API growth.
- **Renderer adapter** (`packages/ui/src/native-browser.ts`): a preview mount creates the tag with
  `isolated-preview="quirky-preview"`, no partition and preview rules, claims with the grant, and
  accepts only about:blank and in-grant URLs for mounts, requests and guest reports.
- **Desktop host** (`apps/desktop/src/bun/native-browser.ts`, `workspace-preview.ts`): the claim
  accepts a grant only for an SDK isolated-preview child, installs preview rules, then attaches a
  handler bound to that grant. The handler serves GET/HEAD from the grant root with realpath
  containment, rejects symlinks, dotfiles and other grants, caps files at 50 MB, and sends a CSP,
  `no-store` and `nosniff`.
- **Pane service** (`plugins/quirky.browser/src/pane-service.ts`): `PaneTab.document`,
  `convertedFrom`, `convertedTo`; `panePreview`; conversion in `convertPane`; Back/Forward cross
  only when the guest reports no history in that direction; reports validated against the grant;
  persistence strips the grant.
- **API and CLI:** `quirky.browser/panePreview({pane, path})` and `quirky browser pane preview
  --pane --path`, declared in the manifest with the conversion fields on every pane result.
- **Tests:** `apps/desktop/test/workspace-preview.test.ts`,
  `plugins/quirky.browser/test/pane-preview.test.ts`, additions to `packages/ui/test/native-browser*.test.ts`
  and `plugins/quirky.browser/test/window-model.test.ts`. Native-only scenarios are in
  `docs/loop/native/sa-browser-pane-workspace-preview.json`.

## Glossary
- **Grant:** per-mount read authority over a document's folder, or the document alone at the root.
- **Conversion:** replacing a pane's page with the other kind (web page or document page).
- **Isolated preview guest:** the fork's sandboxed, nonpersistent WKWebView served by one scheme.
