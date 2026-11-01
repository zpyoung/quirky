# Feedback mode

Feedback mode lets anyone point at part of Quirky's own UI, write a comment, and turn those comments into a block of text for a coding agent or a GitHub issue draft. Quirky never sends anything by itself.

## Conceptual model

Quirky developers notice UI problems while using the app, then lose time describing where the problem is. Orca solves this in dev builds with `react-grab`. Quirky needs the same flow in the builds people actually use, so a comment has to identify its code even when the app is minified.

The mode has three parts:

- **Selection** picks an element in the main window. While selecting, clicks don't reach the app.
- **The tray** keeps comments until they're cleared, including across restarts.
- **Output** is one of two actions. Copy produces Markdown for any agent. File issue opens a GitHub draft for people who have no checkout.

It ships as a new `quirky.feedback` plugin rather than as part of Browser, because Browser is optional and turning it off must not remove feedback mode.

## How a comment moves

When someone selects an element and adds a comment, Quirky captures the element's context once and stores it with the comment. The stored comment stays readable if the UI later changes, and it's never re-resolved to a new element. Each comment records its owning plugin, element path, visible text, React component name when available, app version, and intent. Dev builds add file and line when the lookup succeeds.

Copy turns every stored comment into one Markdown block. File issue builds a draft for each destination repository, leaving out on-screen text, and opens it in the default browser. A person reviews and submits it on GitHub.

## Behavior and scenarios

1. **SC-1 Turning the mode on**
   - **Given** the feedback setting is on
   - **When** someone chooses View → Feedback Mode, the palette command, or the shortcut
   - **Then** the mode turns on, the View item shows a checkmark, a banner explains Option and Esc, and the tray appears
   - **Screen states:**

     | Element | Mode off | Mode on |
     |---|---|---|
     | View → Feedback Mode | ✓ shown, unchecked | ✓ shown, checked |
     | Banner | ✗ hidden | ✓ "Feedback mode on · Option uses the app · Esc exits" |
     | Tray | ✗ hidden | ✓ shown |
     | Numbered dots | ✗ hidden | ✓ shown where the element can be found |

2. **SC-2 Setting off**
   - **Given** the feedback setting is off
   - **When** someone opens the View menu or presses the shortcut
   - **Then** there's no menu item, the palette command isn't offered, and the shortcut does nothing

3. **SC-3 Adding a comment**
   - **Given** the mode is on
   - **When** someone clicks an element, chooses Change or Question, types a comment and adds it
   - **Then** the click doesn't reach the app, and the tray count goes up by one and the element gets a numbered dot
   - While composing, the card names the target by its safe accessible name or visible text, falling back to its tag or pane name. The selected target stays outlined, and the card opens near it without extending beyond the viewport.
   - The floating hover tag is hidden while the selected target's comment card is open. It returns when the card is cancelled or saved.
   - Long target names wrap within the comment card, including names without spaces.
   - **Data before:** **Tray**: 2 comments
   - **Walkthrough:**
     1. The person clicks the Commit button; Quirky highlights it and opens the comment card
     2. The person picks Change and types "Label is too vague"
     3. The person chooses Add
   - **Data after:** **Tray**: ✓ 3 comments; **Comment 3**: Change, "Label is too vague", owner Source control

4. **SC-4 Using the app while the mode is on**
   - **Given** the mode is on
   - **When** someone holds Option and clicks a menu, then lets go and clicks an item in it
   - **Then** the first click reaches the app and opens the menu, and the second selects the item without activating it

5. **SC-5 Leaving with Esc**
   - **Given** the mode is on
   - **When** someone presses Esc
   - **Then** (a) with a comment card open and empty, the card closes and the mode stays on; (b) with text in the card, the first Esc warns that the text will be lost and the second closes the card without saving; (c) with no card open, the mode turns off

6. **SC-6 Commenting on a terminal**
   - **Given** the mode is on
   - **When** someone clicks inside a terminal pane
   - **Then** the whole pane is selected, and no terminal text is captured, copied or stored

7. **SC-7 Commenting on a browser pane**
   - **Given** the mode is on and a Native browser pane is visible
   - **When** someone looks at the pane
   - **Then** a chip on the pane offers Comment on this pane and Annotate this page
   - **Then** Comment on this pane selects the pane, and Annotate this page turns feedback mode off and starts Browser Annotate on that pane
   - **Screen states:**

     | Browser plugin | Chip |
     |---|---|
     | Enabled, pane open | ✓ both actions shown |
     | Disabled | ✗ no pane and no chip |

8. **SC-8 Restarting**
   - **Given** the tray has comments
   - **When** Quirky restarts and someone turns the mode on
   - **Then** every comment is still in the tray, dots return where the element can be found, and other rows say the element is no longer on screen

9. **SC-9 Copying**
   - **Given** the tray has comments
   - **When** someone chooses Copy
   - **Then** all comments reach the clipboard as one Markdown block in Browser Annotate's format, with plugin and app version lines added, and they stay in the tray
   - **Data before:** **Tray**: 2 comments
   - **Walkthrough:**
     1. The person chooses Copy
     2. Quirky writes the block and confirms only after the clipboard write succeeds
   - **Data after:** **Clipboard**: ✓ one block with 2 numbered comments; **Tray**: ✓ still 2 comments

10. **SC-10 Filing an issue**
    - **Given** the tray has comments
    - **When** someone chooses File issue
    - **Then** Quirky opens a GitHub draft per destination repository, with each comment's text, plugin, element path and app version, and no visible text, nearby text or attributes
    - **Then** the comments stay in the tray, because Quirky can't tell whether the draft was submitted
    - **Data before:** **Tray**: 1 comment about Source control; 1 comment about "Acme plugin", which declares a repository*; 1 comment about "Other plugin", which doesn't
    - **Walkthrough:**
      1. The person chooses File issue
      2. Quirky opens a draft on zpyoung/quirky for the Source control comment
      3. Quirky opens a draft on Acme's repository for its comment
      4. Quirky tells the person to use Copy for the "Other plugin" comment
    - **Data after:** **Drafts**: ✓ 2 opened; ✗ none for "Other plugin"; **Tray**: ✓ still 3 comments

11. **SC-11 A draft that won't fit**
    - **Given** the comments for one repository won't all fit in one draft
    - **When** someone chooses File issue
    - **Then** the draft includes as many whole comments as fit, and the tray says how many are left

12. **SC-12 Tray limit**
    - **Given** the tray holds 50 comments
    - **When** someone selects another element
    - **Then** Quirky refuses the new comment with a message and doesn't drop an older one

13. **SC-13 Editing and clearing**
    - **Given** the tray has comments
    - **When** someone edits or deletes a row, or chooses Clear and confirms
    - **Then** the change is saved immediately, and Clear removes every comment

14. **SC-14 Dev build source lookup**
    - **Given** a dev build and a selected element
    - **When** the source lookup succeeds
    - **Then** the comment also records component and file:line
    - **When** the lookup fails
    - **Then** the comment is still added, without those lines and without an error

## Key decisions and rationale

- **Build from Quirky's own parts.** `react-grab` documents dev-only installs and no replacement for its toolbar or Cmd+C, which conflicts with a custom tray, a rebindable shortcut and release-build support. It also adds about 99 KB gzipped.
- **A separate plugin.** Browser can be disabled, and this mode must keep working without it.
- **No automatic send.** Copy is enough for the first version, and it also reaches agents running outside Quirky.
- **Location never blocks a comment.** Every build can name the plugin and element, so file and line are an addition rather than a requirement.

**Success:** in an installed build, a fresh agent in a Quirky checkout finds the correct file from the copied text alone for at least 8 of 10 elements across different plugins. Selecting must never trigger an app action.

**Biggest risks:**

- Dev file and line may not work in WebKit. The fallback is that those lines don't appear.
- Overlay slots load their plugin at startup today, so loading nothing until first use may need a small host change.

## Scope and non-goals

The first version leaves out:

- Direct send to an agent
- Screenshots
- A hosted feedback service
- CLI access to comments
- The phone app
- The separate Settings window
- Selecting inside browser pages from this mode, which Browser Annotate already covers

## Decisions Locked

**Availability**

- Audience is Quirky developers, plugin authors and anyone using Quirky.
- It's included in dev and installed builds, behind a setting.
- The setting is on by default in every build, changed from the earlier on-in-dev-only choice.
- It costs nothing until first use.

**Selecting and commenting**

- The mode turns on from View → Feedback Mode, the palette command, or a rebindable shortcut. The View and palette entries appear only when the setting is on.
- The default shortcut is Cmd+Option+K.
- A click selects, and holding Option uses the app.
- Comments go in a comment card and a collapsible tray, matching Browser Annotate. The tray shows only while the mode is on.
- Terminals are selected as a whole pane. Browser pages get a chip that hands off to Browser Annotate.
- Comments stay on disk until cleared, readable only by the user's account.
- The tray holds 50 comments of up to 2,000 characters each, and refuses new ones at the limit.
- It covers the main window only.

**Handing off**

- The tray offers Copy and File issue, with no direct send.
- Copy and File issue don't clear comments.
- Issue drafts for built-in plugins go to zpyoung/quirky. Third-party plugins use their declared repository, or Copy without one.
- Plugin manifests gain an optional `repository` field, which adds to the public plugin API.

**What the agent receives**

- Every comment has plugin, element path, visible text and app version. Dev builds add component and file:line when available.
- Copy uses Browser Annotate's Markdown.
- There are no screenshots in the first version.
- Issue drafts leave out on-screen text.
- Terminal text is never captured.

**Approach**

- New `quirky.feedback` plugin reusing the overlay layer, shared selection overlay, plugin tags and Annotate's Markdown, moved somewhere both plugins can use it.

## Industry Insights

- Every element-to-source tool checked gets source location only in dev builds, and agentation's docs treat selector and position as the production path. ([agentation](https://github.com/benjitaylor/agentation), [PR #222](https://github.com/benjitaylor/agentation/pull/222))
- React 19 removed `_debugSource`. Tools read `_debugStack`, which exists only in development and needs source maps to reach file:line. ([React #32574](https://github.com/react/react/issues/32574))
- WebKit stack frames use a different format, and I found no evidence that existing tools parse them reliably. ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/stack))
- Pickers should rank `elementsFromPoint` results rather than trust the event target, and must stop the app's own handlers on a pick. ([annotate-dom #5](https://github.com/FreeRikato/annotate-dom/issues/5), [Tag Master](https://tagmaster.dev/blog/visual-element-picker))
- `react-grab` has open reports about its copy shortcut and fixed toolbar, and its open-file fallback sends local paths to its site. ([#525](https://github.com/aidenybai/react-grab/issues/525), [#550](https://github.com/aidenybai/react-grab/issues/550), [#632](https://github.com/aidenybai/react-grab/issues/632))

## Deferred Ideas

- Direct send to an agent through `quirky.agents/deliver`, with a picker across worktrees.
- Screenshots, once a window capture method is confirmed.
- A hosted feedback service for users without a GitHub account.
- CLI access to the tray.

## Glossary

- **Comment:** a person's note plus the element context captured with it.
- **Tray:** the collapsible list of stored comments, shown while the mode is on.
- **Owner:** the plugin whose UI contains the element, or Quirky for host chrome.
- **Issue draft:** a GitHub new-issue page opened with prefilled text, which isn't filed until the person submits it.
- **Chip:** the small control drawn on a Native browser pane while the mode is on.

## Status & amendments

**Status:** Design approved. The user directed execution to begin without a separate review of this written spec. Tech spec: warranted, because the work crosses plugin and host boundaries and touches more than three source files.

**Amendments:**

- 2026-10-30, cost until first use: every plugin UI module loads when the window connects, so a small stub loads then. Selection, the tray and the plugin's daemon code still load on first use. This replaces "It costs nothing until first use" and needs no host change for overlays.
- 2026-10-30, dev source lookup: dev builds write source attributes at build time rather than reading React's stack, which removes the WebKit risk. Component names are recorded in dev builds only, because release names are minified.
- 2026-10-30, leaving the mode: Esc can't reach Quirky while focus is inside a Native browser page, so the banner also has an Exit button. The View item and shortcut still turn the mode off.
- 2026-10-30, browser panes: the chip appears on Native panes only, because Browser Annotate's public command refuses Watch panes. Watch panes are selected as a whole pane, like terminals.
- 2026-10-30, default shortcut: Cmd+Shift+K is already bound by `quirky.terminal-dock`, so the claim that it was unused was wrong. The default is Cmd+Option+K, which is free, and it works from a focused terminal. It can't work while focus is inside a Native browser page, because that page doesn't forward keys. The View item still works there.
- 2026-10-30, plugin API: the `repository` field and new `whenSetting` uses raise the plugin API version to 1.2.0. Existing plugins are unaffected.
- 2026-10-30, app version: comments record the version and commit stamped at build time, because the daemon's own version is a fixed 0.1.0.
