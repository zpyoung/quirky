# Add project: a header button you can find

## Why this exists

Once you have a project, Add project is hard to find. It sits inside the Worktrees funnel popover, next to the activity filters, and a funnel suggests filtering, so nothing points you to a create action in there.

This moves Add project to its own button in the Worktrees panel header. A folder-plus icon holds the spot at rest and grows into the full labelled button when you hover or focus it.

The reader is anyone using Quirky on desktop to add a second or later project. It works if they can reach Add project without opening the popover, and the worktree rows still start right under the header.

## Key decisions and rationale

The folder-plus icon was chosen over a plain plus because each project row already has a plus for New worktree. A second plain plus would need a hover to tell the two apart.

Growing on hover keeps the header quiet, which is what the [polish pass](../2026-10-28-ui-polish-shell/logic.md) wanted, while still naming the action before you click. A permanently labelled button was the other serious option and is the more discoverable of the two, because the label doesn't depend on hover. The user chose the icon that grows, so at rest the icon alone has to signal the action.

The button grows leftward so the funnel and minimize controls never move and the button stays under the cursor.

Add project leaves the popover so it has one home. This supersedes the parts of the polish pass that put it there: S1's single header icon and S2's Add project in the popover.

## Behavior and scenarios

1. **SC-1: at rest**
   - **Given** at least one project exists
   - **When** the Worktrees panel is showing
   - **Then** a folder-plus icon sits in the panel header, left of the funnel, and its accessible name is "Add project"
   - **Screen states:**

     | Element | Shown |
     |---|---|
     | Title | ✓ Worktrees |
     | Add project | ✓ folder-plus icon, no visible text |
     | Funnel | ✓ unchanged |
     | Minimize | ✓ unchanged |

2. **SC-2: hover or keyboard focus**
   - **Given** the icon from SC-1
   - **When** the person hovers it or moves keyboard focus to it
   - **Then** it grows leftward into a primary button showing the icon and "Add project", stays grown while hovered or focused, and returns to the icon afterward; the funnel and minimize controls don't move
   - **Screen states:**

     | Element | At rest | Hovered or focused |
     |---|---|---|
     | Add project | icon | ✓ icon and "Add project" |
     | Funnel position | fixed | ✓ same position |
     | Minimize position | fixed | ✓ same position |

3. **SC-3: narrow panel**
   - **Given** the panel is too narrow to fit the title and the full button
   - **When** the button grows
   - **Then** the title truncates, down to nothing if it has to, and the button is never clipped

4. **SC-4: reduced motion**
   - **Given** the system's reduced motion setting is on
   - **When** the button changes between icon and full button
   - **Then** it changes without animating

5. **SC-5: click**
   - **Given** the button is showing, as icon or full button
   - **When** the person activates it
   - **Then** the existing Add project dialog opens, and its path, Browse, import and Open as Folder steps work as they do today

6. **SC-6: popover**
   - **Given** at least one project exists
   - **When** the person opens the funnel popover
   - **Then** Add project is not in it, and all its other controls remain

7. **SC-7: no projects**
   - **Given** loading has finished and there are no projects
   - **When** the Worktrees panel is showing
   - **Then** the empty state's Add project action is the only one and the header icon is hidden; once a project exists, SC-1 applies

8. **SC-8: still loading**
   - **Given** projects are still loading
   - **When** the Worktrees panel is showing
   - **Then** the header icon is visible, because Add project is only hidden once the list is confirmed empty

## Data flow

Nothing about adding a project changes. The new button opens the same dialog, which adds the project the same way.

## Scope and non-goals

In scope is where Add project lives and how its button behaves. That includes updating the worktree tests that open Add project through the popover and recapturing the shell screenshots.

Out of scope:

- the funnel popover's other contents
- the Add project dialog itself
- a keyboard shortcut or command palette entry

## Decisions locked

Placement:

- Icon-only button in the panel header that grows to the full button on hover (user's choice and note)
- Left of the funnel, growing leftward so the neighboring controls stay fixed

Icon:

- Folder with a plus, not a plain plus

Behavior:

- Keyboard focus grows it the same way hover does
- The title truncates on narrow panels and the button is never clipped
- Reduced motion removes the animation
- Removed from the funnel popover
- Hidden in the empty state, which keeps its own action

## Industry insights

- Hiding one or two actions behind an icon "saves no space, increases effort, and reduces discoverability", and frequently used actions shouldn't be hidden. [NN/g, contextual menus](https://www.nngroup.com/articles/contextual-menus-guidelines/)
- Hidden navigation was used in 27% of desktop tasks against 48% when visible, in a 179-person test on six sites. It's about navigation rather than create actions, so it's supporting evidence only. [NN/g, hidden navigation](https://www.nngroup.com/articles/hamburger-menus/)
- An icon-only toolbar was fixed by adding text labels rather than changing the icons, which is the risk this design accepts at rest and addresses on hover. [CXL, icon usability](https://cxl.com/blog/icon-usability-testing/)
- Fluent recommends familiar icons and short tooltips for toolbars. [Fluent 2, toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage)
- Orca's add control is in the header. A maintainer says current main has a separate, always-visible Add project button; in v1.4.198 it was only in an overflow menu below 235px wide. This comes from a summary of the issue that wasn't read directly. [Orca #19658](https://github.com/stablyai/orca/issues/19658)
- Of the other tools checked, VS Code, GitHub Desktop and Zed use menus or context menus rather than a sidebar button, so there's no single convention to copy. [VS Code](https://code.visualstudio.com/docs/editor/workspaces), [GitHub Desktop](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-a-repository-from-your-local-computer-to-github-desktop), [Zed](https://zed.dev/docs/windows-and-projects)

No source tested a grow-on-hover button directly.

## Deferred ideas

None. Discussion stayed within scope.

## Glossary

- **Funnel popover:** the "Worktrees options" popover opened by the funnel icon in the panel header.
- **Panel header:** the row holding the Worktrees title and its controls, above the project list.

## Status & amendments

**Status:** Approved 2026-10-30.

**Amendments:**

- 2026-10-30, SC-2 and SC-3: panels have no fixed minimum. Dragging stops at 160px, but a narrow window scales side panels down further (77px at a 640px window with both sides open and this panel dragged to its minimum). The full button needs 156px, so below that it stays an icon on hover and focus and only changes color, because "never clipped" outranks growing. Below 88px the header controls wrap onto extra rows, because the resting icon no longer fits on one.
