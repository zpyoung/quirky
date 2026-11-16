# Approach research (Phase B, 2026-11-09)

## A. Quiet single tree
- Linear's 2026-03-12 refresh dimmed the nav sidebar so content stands out. https://linear.app/changelog/2026-03-12-ui-refresh
- Linear still has containers: Favorites section above Teams, only starred views reach the sidebar. https://linear.app/docs/favorites , https://linear.app/docs/custom-views
- 30+ items: collapsible groups plus search, persisted collapse state (practitioner opinion). https://www.setproduct.com/blog/sidebar-navigation-ui-design
- WCAG 1.4.1: color can't be the only cue; amber/red marks need shape or text. https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- Pitfalls: idle-based hiding makes items vanish (Slack "Active only"); collapsed headers can hide attention; a soft tint may not survive nesting, so pair it with weight. https://slack.com/help/articles/212596808-Manage-your-sidebar

## B. Attention shelf
- Ad-like strips draw almost no fixations (NN/g, 2007, web pages). https://www.nngroup.com/articles/banner-blindness-original-eyetracking/
- Superhuman makes duplication opt-in; Gmail Starred-first is a partition, not a duplicate. https://help.superhuman.com/hc/en-us/articles/46005636204941-Custom-Split-Inbox , https://support.google.com/mail/answer/18522?hl=en
- Slack Activity and GitHub notifications use view tabs and saved filters, not a pinned shelf. https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack , https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox
- Cursor encodes attention as row dot color (amber blocked, blue unread, red error); a bug report shows a stuck subagent with no badge. Conductor groups by lifecycle status. https://forum.cursor.com/t/background-subagent-can-get-stuck-when-permission-prompt-disappears-and-the-agent-list-does-not-show-that-attention-is-required/161539 , https://www.conductor.build/changelog/0.35.0-workspace-status
- Users with parallel sessions ask "what is pending in each one", not for a second list (one thread). https://www.reddit.com/r/ClaudeCode/comments/1xqrroq/

## C. Section blocks
- Arc Spaces are contexts (theme, profile), not card styling; Arc shuts down 2026-12-22. https://en.wikipedia.org/wiki/Arc_(web_browser)
- At 240px about 22 characters fit at 14px; indent 12-16px per level, three levels max. https://www.setproduct.com/blog/sidebar-navigation-ui-design
- Accessible pattern: nested lists in nav with aria-expanded disclosure buttons. https://accessibility.build/guides/accessible-tree-view
- Card evidence is thin; one project folded a flat list into groups because it "took up most of the height". https://github.com/Kirmalix/flixypix/pull/16
- Pitfalls: block headers and padding cost rows and label width; collapse can hide attention.
