# Terminal pane Fork

Agent terminal panes contribute **Fork Agent Session** to the public `quirky.terminal/pane` menu after Quick Commands. The menu is hidden on plain shell panes.

The registered command is `command:quirky.terminal/fork-agent-session({ session })`, where `session` is the exact source pane's terminal-session ID. It inspects that session through `quirky.session/get`, calls the public `quirky.session/resume({ session, fork: true })` provider resolver, verifies the distinct result still points to the source, and opens only that returned session. Missing, stale, shell or unsupported sources refuse; the command never substitutes a different session.
