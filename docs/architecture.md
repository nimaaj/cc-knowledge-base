# Architecture

## Process boundaries

The system is split into five process boundaries:

1. The daemon owns durable state, scheduling, approvals, managed execution, and integration lifecycles.
2. The MCP bridge is spawned by Claude Code over stdio and forwards typed requests to the daemon.
3. The browser dashboard reads and changes the same state through the daemon API.
4. The developer CLI provides human-readable and JSON state control through that API.
5. An optional Chrome extension and macOS watcher act as narrow, authenticated edge adapters.

The split allows reminders, session monitoring, and managed agents to survive the end of an individual Claude Code session.

SQLite is not a public mutation interface. Every writer uses the daemon so validation, optimistic revisions, audit events, and live subscriptions remain consistent. Developers can use `cca api` when they need low-level access to an authenticated endpoint.

## Trust boundaries

- MCP clients and the dashboard authenticate to the daemon.
- Ability commands use manifest validation, shell-free argument arrays, allowed working-directory roots, stripped secret environment variables, and one-time approvals.
- Browser content is untrusted even when it comes from a signed-in work account.
- A trigger may propose a sensitive operation but cannot approve it.
- Account tokens remain in the macOS Keychain or the owning browser profile.

## Google Calendar constraint

The work calendar does not provide API access. Calendar integration will therefore use visible browser interaction.

The implementation executes narrow jobs in an unpacked Chrome extension against already signed-in tabs. Read-only jobs can queue directly. Calendar creation and Slack sending are represented as browser runs and require persisted approval before dispatch. A closed tab, changed selector, login screen, or account confirmation fails the job; it is never interpreted as an empty calendar.

Calendar observations feed the assistant's own durable reminder scheduler. The browser session is not the reminder engine.

## Persisted entities

The database contains `tasks`, `sessions`, `runs`, `run_logs`, `approvals`, `schedules`, `notifications`, `memories`, `memory_revisions`, `memory_links`, a memory FTS5 index, `abilities`, `browser_jobs`, and append-only `events`.

All mutable entities use revisions or leases where concurrent actors may update them.

Memory has a provider boundary in the daemon. The first provider is SQLite-backed lexical retrieval; a later provider can add semantic ranking without moving ownership out of the daemon or changing MCP, CLI, and web mutation rules. Memory text is always untrusted data. It may be returned as context, but it is never interpreted as daemon commands or tool instructions.

## State transitions

Commands and browser writes start in `waiting_approval`. Approval resolution is durable and auditable; command execution uses `spawn(executable, args, { shell: false })`. Managed Claude runs use the Agent SDK permission callback, which parks a tool request until its approval is resolved. Agent runs that are interrupted by a daemon restart are failed and their unserviceable approvals expire. Browser jobs use a short claim lease so an extension shutdown does not strand them.

Schedules store their next fire time in SQLite. One-time triggers disable after firing; interval triggers compute the next timestamp; notification triggers stay enabled and enforce a cooldown. Reminder delivery always enters the web inbox even if native desktop delivery fails.
