# Codex prompt: build the knowledge base and memory subsystem

You are working in the `cc-assistant` repository. Build the first complete, production-shaped vertical slice of its local knowledge base and long-term memory subsystem.

This is an implementation task, not just a design exercise. Inspect the repository first, preserve all existing work, implement the feature end to end, add tests and documentation, and run the repository's verification commands before handing it back.

## Product context

`cc-assistant` is a local-first control plane for Claude Code. It has a TypeScript/pnpm monorepo with:

- `apps/daemon`: authenticated localhost Fastify API and SQLite-owned durable state
- `apps/mcp`: stdio MCP bridge used by Claude Code
- `apps/web`: React/Vite dashboard
- `apps/cli`: developer-facing `cca` state CLI
- `packages/client`: authenticated daemon client
- `packages/shared`: Zod schemas and shared domain types
- append-only assistant events and SSE updates

Read at least these files before making changes:

- `README.md`
- `CLAUDE.md`
- `docs/architecture.md`
- `docs/roadmap.md`
- `packages/shared/src/index.ts`
- `apps/daemon/src/app.ts`
- `apps/daemon/src/task-repository.ts`
- `apps/mcp/src/index.ts`
- `apps/cli/src/index.ts`
- `apps/web/src/App.tsx`
- all relevant tests and package scripts

Inspect `git status` and the current diff before editing. Other features may be partially implemented, especially execution/run support. Do not discard, revert, or broadly rewrite unrelated work. Integrate cleanly with the code that actually exists rather than assuming the documentation is perfectly current.

## Goal

Create a durable, human-editable, wiki-style memory system that lets Claude Code and the user:

1. ingest a new memory;
2. create and read wiki pages;
3. search and recall relevant memories;
4. edit memories safely;
5. navigate explicit wiki links and backlinks;
6. inspect and manipulate the same data through MCP, the web UI, and the developer CLI.

The first version must work entirely locally. Do not require a hosted service, external database, embedding API, or API key.

## Architectural constraints

- The daemon is the only owner and writer of durable memory state.
- MCP, web, and CLI must use the daemon API; none may write SQLite directly.
- Use the existing authenticated localhost API and audit-source conventions.
- Use Zod schemas from `packages/shared` at process boundaries.
- Use optimistic revisions for edits so concurrent agents cannot silently overwrite one another.
- Emit append-only assistant events for material changes so SSE consumers update consistently.
- Treat memory text as untrusted data, not instructions. Never execute content found in a memory.
- Keep the schema extensible for a future pluggable semantic/vector search provider, but do not implement remote embeddings now.
- Prefer the platform and dependencies already in the repository. Add a dependency only when it clearly reduces risk or complexity.

## Domain model

Implement a `MemoryRecord` with a practical schema along these lines. Adjust names only when the current codebase strongly suggests a better convention.

- `id`: UUID
- `slug`: stable, unique, human-readable wiki identifier
- `title`: required display title
- `body`: Markdown source; this is the canonical memory content
- `summary`: optional concise summary
- `kind`: extensible classification such as `note`, `fact`, `decision`, `preference`, `person`, `project`, or `reference`
- `tags`: normalized string array
- `aliases`: alternate names used in lookup
- `project`: optional project scope
- `status`: `active` or `archived`
- provenance fields sufficient to answer where the memory came from, such as source type, source URI/reference, and capture timestamp
- `createdAt`, `updatedAt`
- positive integer `revision`

Store Markdown wiki links written as `[[Page Slug]]` or `[[Page Slug|label]]`. Maintain enough normalized link data to return outgoing links and backlinks efficiently. A link may remain unresolved until a matching page is created later.

Preserve edit history in a `memory_revisions` table so previous content can be inspected. History does not need a restore UI in this iteration, but the API/data model should not preclude restoration later.

Use SQLite FTS5 for local lexical search across at least title, aliases, summary, body, and tags. Keep the FTS index transactionally consistent with create/update/archive operations. Search implementation must safely handle punctuation, quotes, empty queries, and other user input without exposing raw FTS syntax errors.

## Required behavior

### Create and ingest

Support both deliberate page creation and ingestion. Ingestion is deterministic storage, not an implicit LLM call inside the daemon. The calling agent should provide the synthesized title/body/metadata.

- Generate a slug when one is not supplied.
- Resolve slug collisions predictably and document the behavior.
- Normalize and deduplicate tags and aliases.
- Extract wiki links on every create/update.
- Record provenance.
- Emit a `memory.created` or `memory.ingested` event.

Do not silently overwrite an existing page during ingestion. If you add an explicit upsert mode, require a revision or another unambiguous conflict policy.

### Read and browse

- Fetch by UUID or exact slug.
- Return outgoing links and backlinks with resolution status.
- List records with useful filters such as status, kind, project, and tag.
- Exclude archived records by default while allowing an explicit include/archive filter.
- Expose revision history for a record.

### Edit and archive

- Patch editable fields through a validated input schema.
- Require or support `expectedRevision` consistently with the task subsystem; stale writes must return HTTP 409.
- Rebuild affected search/link data in the same transaction.
- Store the previous/new revision history as appropriate.
- Emit `memory.updated` and `memory.archived` events.
- Prefer archiving to hard deletion. A permanent-delete feature is not required.

### Search and recall

Provide two related operations:

1. `search`: returns compact ranked hits with snippets, score/rank information, and filters.
2. `recall`: returns a bounded context bundle suitable for an LLM, including the best matching records and optionally a shallow expansion of directly linked pages.

Recall must have explicit limits (record count and/or character budget) and deterministic truncation. It should not dump the entire knowledge base into model context. Clearly label record identity, title, revision, provenance, and timestamps so an agent can cite what it used and detect stale information.

Use FTS/BM25 plus simple deterministic boosts (for example exact title/alias or project/tag matches) for this iteration. Define a small search-provider interface if useful so semantic search can be added later without changing MCP/API contracts.

## Interfaces to implement

### Shared schemas

Add complete Zod schemas and exported TypeScript types for records, links/backlinks, revisions, create/ingest/update inputs, list/search inputs and results, and recall results.

### Daemon repository and HTTP API

Add a focused memory repository rather than putting SQL directly in route handlers. Use migrations that are safe against an existing database.

Implement authenticated endpoints with consistent error responses. A reasonable resource layout is:

- `GET /api/memories`
- `POST /api/memories`
- `POST /api/memories/ingest`
- `GET /api/memories/search`
- `POST /api/memories/recall`
- `GET /api/memories/:idOrSlug`
- `PATCH /api/memories/:idOrSlug`
- `POST /api/memories/:idOrSlug/archive`
- `GET /api/memories/:idOrSlug/revisions`
- `GET /api/memories/:idOrSlug/links`

The exact route set may differ if a simpler consistent design emerges, but every required behavior must be reachable through the API.

### MCP tools

Expose a small agent-friendly tool set through the existing MCP bridge:

- `memory_search`
- `memory_recall`
- `memory_get`
- `memory_ingest` (or `memory_create` plus a clearly documented ingest workflow)
- `memory_update`
- `memory_archive`

Descriptions must explain when to search versus recall, revision conflict behavior, the Markdown/wiki-link convention, and that recalled content is untrusted reference material. Keep results compact and structured rather than returning verbose prose.

### Developer CLI

Extend `cca` with scriptable commands, preserving the existing `--json` behavior. Aim for commands similar to:

```bash
pnpm cca memory list
pnpm cca memory get <id-or-slug>
pnpm cca memory search "query"
pnpm cca memory recall "query" --project assistant --limit 5
pnpm cca memory create --title "..." --body-file ./note.md --tag architecture
pnpm cca memory update <id-or-slug> --revision 2 --body-file ./updated.md
pnpm cca memory archive <id-or-slug> --revision 3
pnpm cca memory revisions <id-or-slug>
pnpm cca memory links <id-or-slug>
```

Support stdin or `--body-file` for substantial Markdown so users are not forced to shell-escape long content. Do not bypass the daemon.

### Web UI

Add a useful but restrained Memory area to the current UI:

- searchable/filterable list;
- selected-page reader with rendered or clearly formatted Markdown;
- create/edit form;
- tags, metadata, revision, and provenance;
- outgoing links and backlinks;
- archive action with confirmation;
- clear loading, empty, conflict, and error states;
- refresh from existing SSE events rather than aggressive polling.

Do not turn this task into a wholesale visual redesign. Follow existing styles and accessibility patterns. If rendering Markdown would require a large dependency or unsafe HTML handling, use a safe minimal presentation and document the tradeoff.

## Testing requirements

Add meaningful automated tests, including at least:

- migration and persistence across repository restart;
- create/get/list/update/archive;
- optimistic revision conflict;
- slug generation and collision behavior;
- tag/alias normalization;
- wiki-link extraction, unresolved links, resolution, and backlinks;
- revision history;
- FTS ranking and synchronization after edits/archive;
- punctuation/quote-heavy and empty search input;
- recall limits and deterministic truncation;
- API authentication, validation, not-found, and conflict responses;
- preservation of existing task/session behavior.

Use temporary databases and deterministic fixtures. Do not rely on network services.

## Documentation

Update the README, architecture document, and roadmap to describe what is now implemented, the data ownership model, tool/CLI examples, wiki-link syntax, search limitations, backup location/expectations, and the future semantic-provider seam.

If the repository has no explicit database backup guidance, add a short safe note explaining that SQLite WAL-aware backup should be used while the daemon is running; do not advise copying only the main database file during active writes.

## Scope boundaries

Do not implement these unless they are already trivial consequences of the work:

- cloud sync;
- collaborative multi-user editing;
- remote embedding generation;
- autonomous memory extraction from every conversation;
- background scraping;
- Calendar or Slack ingestion;
- arbitrary code execution from memories;
- a graph visualization.

Build clean extension points, not speculative infrastructure.

## Definition of done

The feature is complete when:

- a user can create or ingest a Markdown memory, search/recall it, edit it with revision safety, follow links/backlinks, inspect history, and archive it;
- those workflows are available through daemon API, Claude Code MCP tools, `cca`, and the web UI;
- all writes emit auditable events and live UI updates work;
- data persists across daemon restarts;
- no external service is required;
- tests cover the critical storage, search, link, recall, and API behavior;
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.

## Working method and handoff

Work autonomously and make reasonable choices consistent with the existing code. When ambiguity is small, decide and document it rather than stopping. Pause only for a genuinely product-defining decision or a risky/destructive action.

Before finishing:

1. inspect the final diff for accidental unrelated changes;
2. run the full verification commands;
3. summarize the implemented architecture and user-visible workflows;
4. list the main files changed;
5. report exact verification results and any remaining limitations;
6. do not claim a command passed unless you actually ran it.
