# Implementation roadmap

## Stage 1: task vertical slice

- [x] Shared schemas
- [x] Persistent daemon
- [x] Authenticated task API
- [x] Event log and live updates
- [x] Claude MCP task tools
- [x] Initial dashboard
- [x] Developer CLI and raw authenticated API access

## Stage 2: execution and observation

- [x] Run, session, and approval schemas
- [x] Managed Claude Agent SDK runs
- [x] Worktree isolation
- [x] Safe local process runner
- [x] Claude Code hook receiver
- [x] Session dashboard and MCP inspection tools
- [x] Project MCP and hook packaging
- [x] Managed run dashboard

## Stage 3: personal assistant behavior

- [x] Durable one-shot and recurring scheduler
- [x] macOS notification delivery helper
- [x] Browser-job queue with claim recovery
- [x] Browser-backed Google Calendar observations and approved creation
- [x] Clipboard image helper

## Stage 4: browser and triggers

- [x] Slack unread and channel-reading workflows
- [x] Confirmed Slack sending
- [x] Trigger rules, cooldowns, and loop prevention
- [x] Experimental macOS notification observation

## Stage 5: extensibility and memory

- [x] Ability manifest and approved subprocess execution
- [x] Permission and health UI
- [x] Wiki-style memory provider contract
- [x] SQLite FTS memory implementation
- [x] Generic MCP ability discovery and invocation

## Follow-on hardening

- Package the MCP, hooks, and browser bridge as an installable Claude Code plugin.
- Add macOS launchd manifests for the daemon and notification watcher.
- Add per-adapter selector fixtures and end-to-end tests against controlled Calendar/Slack test accounts.
- Add an optional local embedding provider behind the existing memory provider boundary.
