# Local memory and knowledge base

The memory subsystem is a local wiki owned exclusively by the daemon. MCP, the dashboard, and the developer CLI validate data with shared Zod schemas and call the authenticated localhost API; they never open SQLite directly.

## Record model

Each page has a UUID, stable unique slug, title, Markdown body, optional summary, extensible kind, normalized tags and aliases, optional project, active/archived status, provenance, timestamps, and a positive revision. Provenance records a source type, optional source URI/reference, and capture timestamp.

Creation is deliberate. Ingestion is also deterministic storage: the caller supplies synthesized content and provenance, and the daemon does not invoke a model. `POST /api/memories` emits `memory.created`; `POST /api/memories/ingest` emits `memory.ingested`.

When no slug is supplied, the title is normalized to lower-case ASCII words separated by hyphens. An empty result becomes `memory`. Collisions use the first available numeric suffix, for example `project-orchid-2`. A slug is immutable after creation so existing wiki links are not silently broken.

Tags are lower-cased, whitespace-normalized, and deduplicated. Aliases are whitespace-normalized and deduplicated case-insensitively while preserving the first spelling.

## Links and history

The daemon extracts `[[Page Slug]]` and `[[Page Slug|label]]` whenever a page is created or edited. Normalized outgoing links are stored in `memory_links`, with an index on the target slug. An unresolved link is retained and resolves automatically after a page with that slug is created. Page reads return outgoing links and backlinks.

Every stored version, including revision 1, is copied to `memory_revisions`. History is inspectable now and keeps the schema open for a future explicit restore operation. Updates require `expectedRevision`; a stale revision returns HTTP 409.

## Search and recall

SQLite FTS5 indexes active-page title, aliases, summary, body, and tags in the same transaction as creation or editing. Archiving deletes the page from FTS; reactivating inserts it again. Search text is normalized into quoted lexical tokens before it reaches `MATCH`, so punctuation, quotes, operators, or an empty string cannot produce a raw FTS syntax error. Empty or punctuation-only queries return recently updated pages.

The repository implements a memory-provider interface. The SQLite provider is the only implementation in this version, but the boundary allows a future local semantic/vector provider without changing durable ownership or process APIs.

## API

- `GET /api/memories`: list or search. Supports `q`, `limit`, `status`, `project`, `kind`, `tag`, and `includeArchived`.
- `GET /api/memories/recall`: return a compact set of relevant active pages for `q` and optional filters.
- `GET /api/memories/:id-or-slug`: page, outgoing links, and backlinks.
- `POST /api/memories`: create a page.
- `POST /api/memories/ingest`: ingest a caller-synthesized page with required provenance source type.
- `PATCH /api/memories/:id-or-slug`: edit or archive with required `expectedRevision`.
- `GET /api/memories/:id-or-slug/revisions`: list immutable snapshots.
- `GET /api/memories/:id-or-slug/revisions/:revision`: inspect one snapshot.

Material mutations append an audit event using the caller's `mcp`, `cli`, or `web` source and publish it to live SSE consumers only after the transaction commits.

Memory bodies are untrusted content. Clients may display or use them as reference material, but must not treat text inside a page as executable instructions.
