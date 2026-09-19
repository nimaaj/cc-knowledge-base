# CC Assistant

A local-first assistant control plane for Claude Code: durable state, managed agents, approvals, reminders, browser-backed work integrations, native helpers, memory, MCP, CLI, and a live web dashboard.

## What works now

- SQLite-backed tasks, runs, approvals, schedules, notifications, memories, abilities, browser jobs, sessions, and audit events.
- Optimistic revisions to prevent agents and the UI from overwriting each other.
- Append-only task events and a live SSE event stream.
- An authenticated localhost API.
- Managed Claude Agent SDK runs with turn/budget limits, optional git worktrees, streamed logs, cancellation, and tool approvals.
- Local commands executed as executable/argument arrays without a shell and only after explicit approval.
- One-shot, interval, and macOS-notification-triggered automations plus a durable reminder inbox.
- Full-text wiki memory ingest, recall, search, and revision-safe editing.
- Versioned ability manifests whose invocations use the command approval path.
- Browser-extension jobs for signed-in Google Calendar and Slack tabs; browser writes require approval.
- macOS/Linux desktop notifications and clipboard-image reads.
- Claude Code MCP tools for every capability above.
- Claude Code lifecycle hooks and live session-state tracking.
- A developer CLI for state inspection, mutation, export, and raw API calls.
- A responsive dashboard for tasks, sessions, runs, approvals, reminders, notifications, and memory capture.

## Requirements

- Node.js 24 LTS
- pnpm 11 or newer
- Claude Code 2.1.80 or newer

## Start the development app

```bash
pnpm install
pnpm build
pnpm dev
```

The daemon listens on `127.0.0.1:4317` and the dashboard on [http://127.0.0.1:4318](http://127.0.0.1:4318).

On first launch, the daemon generates `.data/access-token`. Paste its contents into the dashboard login screen. The browser receives an HTTP-only, same-site cookie; the token is not stored in browser JavaScript storage.

## Connect Claude Code

The committed `.mcp.json` registers the built MCP bridge for this project. Build the project and keep the daemon running, then restart Claude Code from this directory and check `/mcp`.

The MCP bridge reads the same `.data/access-token` file as the daemon. Its tools cover tasks, observed sessions, managed runs, command proposals, approvals, schedules/reminders, memory, abilities, clipboard images, Calendar, Slack, and browser-job polling. Restart Claude Code after rebuilding so it reloads the tool list.

The daemon must remain running for the tools to work. The MCP bridge is intentionally small and contains no durable state.

## Observe Claude Code sessions

Project hooks in `.claude/settings.json` forward lifecycle events to the daemon. Claude Code may ask you to approve these hooks after the configuration changes. Use `/hooks` to confirm they are loaded.

After approval, submitting a prompt or using a tool updates the **Observed sessions** strip in the dashboard. The hooks are best effort: if the daemon is unavailable they exit successfully and never interrupt Claude Code.

To observe Claude Code sessions in every project, install the same additive hooks in your user settings:

```bash
pnpm hooks:install-global
```

The installer preserves existing hooks and creates `~/.claude/settings.json.cc-assistant-backup`. Undo it with `pnpm hooks:remove-global`. Restart existing Claude sessions after installation; a session that never emits a hook cannot be discovered retroactively.

## Developer CLI

The `cca` command manipulates state through the same validated daemon API used by MCP and the dashboard. It reads `.data/access-token` automatically when `CC_ASSISTANT_DATA_DIR=.data` is set by the project script.

```bash
pnpm cca status
pnpm cca task list
pnpm cca task create "Investigate the failing build" --project assistant --priority 1
pnpm cca task focus <task-id> --revision 1
pnpm cca task update <task-id> --status blocked --description "Waiting for access"
pnpm cca session list --all
pnpm cca run agent "Investigate tests" --prompt "Find and fix the failing tests" --cwd "$PWD" --worktree
pnpm cca run command "Check git status" git status
pnpm cca approval list --status pending
pnpm cca approval approve <approval-id>
pnpm cca memory create "Project Orchid" --body "Important context" --tags project,active
pnpm cca memory ingest "Release decision" --body "Use canary releases. See [[Project Orchid]]." --source-type conversation --source-ref session-123
pnpm cca memory list --query "canary release"
pnpm cca memory get project-orchid
pnpm cca memory update project-orchid --revision 1 --body "Updated context"
pnpm cca memory history project-orchid
pnpm cca memory export --output ./memory-export --all
pnpm cca memory import ./memory-export
pnpm cca memory import ./memory-export --apply
pnpm cca schedule create "Stand up" --trigger-kind interval --trigger '{"everyMs":3600000}' --action-kind reminder --action '{"title":"Stand up","body":"Move for five minutes"}'
pnpm cca browser calendar list
pnpm cca browser slack send general "Draft status is ready"
pnpm cca native clipboard-image --output /tmp/clipboard.png
pnpm cca event list --limit 25
pnpm cca state export --json
pnpm cca api GET /api/tasks --json
```

Add `--json` to any command for scripts. `cca api` is the authenticated escape hatch for newly added daemon endpoints before they receive a dedicated CLI command.

The CLI deliberately does not write directly to SQLite. Direct database writes would bypass validation, revisions, audit events, and live dashboard updates.

## Local memory wiki

Memory pages are Markdown records stored by the daemon in SQLite. They support normalized tags and aliases, project scope, extensible kinds, provenance, active/archived status, immutable revision snapshots, and wiki links such as `[[Project Orchid]]` or `[[Project Orchid|the plan]]`. The dashboard, MCP bridge, and `cca memory` commands all use the authenticated daemon API.

The daemon generates a slug from the title when one is omitted. If that slug already exists it appends the first available numeric suffix (`project-orchid-2`, then `project-orchid-3`, and so on). Slugs do not change during edits, so wiki links remain stable. Links may point to pages that do not exist yet; they resolve automatically when the target slug is created.

Search is entirely local and uses SQLite FTS5 across title, aliases, summary, body, and tags. User queries are tokenized and quoted before reaching FTS, so punctuation or quote characters cannot become raw FTS syntax. Archived pages are removed from the active search index but remain readable through direct lookup and `--all` listings.

Tags are normalized, deduplicated, searchable, and available as exact filters across the API, CLI, and dashboard. Tags can describe subject, scope, origin, or lifecycle—for example `system settings`, `project x`, `user preferences`, `communicated style`, `completed projects`, `slack conversations`, and `meeting notes`.

SQLite remains the canonical store. `cca memory export` produces deterministic, editable Markdown files plus a JSON manifest. `cca memory import` performs a dry-run by default; `--apply` writes only validated changes whose exported revision still matches the canonical page. Malformed files and stale revisions block the import instead of partially overwriting newer memory.

Every edit requires the page's current positive `revision`. A stale edit receives HTTP 409 instead of overwriting another actor's changes. See [`docs/memory.md`](./docs/memory.md) for the model and API.

## Google Calendar and Slack through Chrome

There is deliberately no Calendar or Slack API credential path. Load [`browser-extension`](./browser-extension) as an unpacked Chrome extension, open its options, and paste `.data/access-token`. Keep signed-in `calendar.google.com` and `app.slack.com` tabs open.

Read jobs execute in the visible browser profile. Creating a calendar event or sending a Slack message first appears in the dashboard approval queue. DOM adapters are isolated because both products change markup; a missing selector fails the job rather than reporting an empty calendar or pretending a message was sent.

## macOS notification triggers

Time triggers run inside the daemon. On macOS, visible Notification Center banners can also feed trigger rules through the opt-in Accessibility watcher:

```bash
pnpm native:watch-notifications
```

macOS will request Accessibility permission for the terminal running the watcher. A `system_notification` trigger matches optional `app`, `title`, and `body` substrings and has a default 60-second cooldown. This adapter is experimental because Notification Center accessibility structure can change between macOS releases.

## Ability manifests

Version-1 ability manifests live in [`abilities`](./abilities). They declare metadata, a JSON Schema input contract, and one shell-free command template. Installing an ability does not grant execution permission; each invocation becomes a normal command approval.

## Workspace layout

```text
apps/daemon       Persistent local API, task store, and event stream
apps/cli          Developer-facing state CLI
apps/mcp          Claude Code stdio MCP bridge
apps/web          React dashboard
browser-extension Load-unpacked Chrome bridge for Calendar and Slack
native/macos      Opt-in Notification Center observer
abilities         Manifest specification and examples
packages/client   Authenticated daemon client
packages/shared   Shared schemas and domain types
docs              Architecture decisions and implementation roadmap
```

Open the [interactive architecture flowchart](./docs/cc-knowledge-base-swimlane-flow.html) for the request lifecycle, domain branches, canonical memory state, tag handling, and Markdown export/import paths. Select any node to expand its behavior and source references.

## Security properties

- The daemon binds to loopback by default and rejects unexpected Host headers.
- API access requires either the local bearer token or an HTTP-only session cookie.
- Token comparison is constant-time.
- The SQLite database contains assistant state and audit events, not account credentials or browser cookies.
- MCP and web updates include an audit source.
- Shell parsing is disabled for commands and ability invocations.
- Secret-looking environment variables are stripped from child command environments.
- Calendar/Slack writes and all local commands require a persisted one-time approval.

This is an early local build. Do not expose the daemon port through a tunnel or bind it to a LAN interface.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```
