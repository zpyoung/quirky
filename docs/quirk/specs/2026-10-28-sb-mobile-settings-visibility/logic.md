# Settings Mobile revoke visibility

## Status & amendments
Status: autonomously approved under docs/loop/LOOP.md; tech spec requested by the loop.

**Amendments:** None.

## Conceptual model
Settings > Mobile and the standalone Mobile page are two clients of the existing pairing/device API. Long Settings content belongs inside the host's scrolling content area. A device-revoke action must be reachable at a 1280×720 viewport without resizing the window or switching to the standalone page.

## Scope & non-goals
Investigate the exact unresolved observation in sb-mobile-daemon D22: guarded scroll/PageDown did not bring Settings' paired-device revoke control fully above the status bar. Distinguish host clipping from incorrect scroll/focus targeting. Repair only a demonstrated app defect. All other mobile feature flows, phone/native UI, transport/security changes, general shell redesign and driver implementation changes are excluded.

## Data flow
A fresh isolated daemon generates a pairing offer. A real encrypted peer authenticates it, creating a device. Settings reads the device list. A user navigates the host scroll area, activates Revoke device, and sees the updated list/feedback; the daemon disconnects the paired peer through the existing revoke API.

## Behavior & scenarios
### A1: Reach a paired device using scrolling
Before: 1280×720 viewport, Settings > Mobile open, one paired device, no generated QR expanded in Settings. Walkthrough: observe the screen, move over the actual Settings content, scroll downward. After: the complete Revoke device control is visible above the status bar and can be clicked without changing views or viewport. Record before/after scroll ownership and geometry, not just an accessibility-tree match.

### A2: Keyboard access with the pairing QR expanded
Before: same viewport, Settings pairing QR expanded, paired device remains. Walkthrough: focus a visible Settings control and use normal Tab/PageDown navigation as appropriate, distinguishing focused input behavior from scrolling the host. After: the paired-device action can receive visible focus; a long QR cannot make the bottom permanently unreachable. A PageDown sent to an input is not by itself proof of broken scrolling.

### A3: Revoke from Settings
Before: the complete device action is visible, with a live encrypted peer created by this run. Walkthrough: activate Revoke device from Settings. After: the row disappears, feedback reports success and the peer disconnects. No real device is revoked. Verify the public device-list API separately as integration evidence.

## Decisions locked
- Layout/style and density: preserve existing controls, order and styling unless the viewport reproduction proves their host scroll contract is broken.
- Interaction: test real wheel and keyboard paths; never use programmatic scrollIntoView to claim user accessibility.
- Loading, empty and error states: retain current behavior; A3 uses the existing empty list and feedback.
- Authentication: use a real isolated encrypted peer, never fabricate a device row or mutate the device registry.
- Evidence: distinguish guarded-driver limitations from app failures; if the app already works, land investigation evidence without speculative code or permanent tests.

## Key decisions & rationale
Recommended: diagnose the actual host and preserve behavior if reachable. Rejected: add a Mobile-only nested scrollbar before reproducing (two competing scroll owners); move revoke to the top (changes information order without fixing the cause); declare success from the shorter Mobile page (does not exercise Settings).

## Industry insights
Repository-grounded investigation, not external research: sb-mobile-daemon D22 expressly leaves the origin unresolved; packages/ui/src/styles.css declares host overflow. The source feature's desktop flows 2 and 10 require a reachable device list and immediate revoke. The feature doc's phone Tasks keyboard clipping defect is not this desktop flow.

## Deferred ideas
None; discussion stayed within this queue item's boundary.

## Glossary
Host: core UI plugin-slot container. Guarded driver: using-apps-like-a-user web action wrapper. Peer: run-owned encrypted Mobile test client, not a user's phone.
