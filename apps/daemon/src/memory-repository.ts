import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AssistantEventSchema,
  CreateMemorySchema,
  IngestMemorySchema,
  MemoryBacklinkSchema,
  MemoryDetailSchema,
  MemoryLinkSchema,
  MemoryRevisionSchema,
  MemorySchema,
  MemoryTagSchema,
  UpdateMemorySchema,
  type AssistantEvent,
  type CreateMemoryInput,
  type Memory,
  type MemoryBacklink,
  type MemoryDetail,
  type MemoryLink,
  type MemoryRevision,
  type MemoryStatus,
  type MemoryTag,
  type UpdateMemoryInput,
} from "@cc-assistant/shared";

type Row = Record<string, unknown>;
type AuditSource = "mcp" | "cli" | "web" | "api";

export interface MemoryListOptions {
  query?: string | undefined;
  limit?: number | undefined;
  status?: MemoryStatus | undefined;
  project?: string | undefined;
  kind?: string | undefined;
  tag?: string | undefined;
  includeArchived?: boolean | undefined;
}

export interface MemoryProvider {
  create(input: CreateMemoryInput, source?: AuditSource): MemoryDetail;
  ingest(input: unknown, source?: AuditSource): MemoryDetail;
  get(idOrSlug: string): MemoryDetail | undefined;
  list(options?: MemoryListOptions): Memory[];
  exportAll(includeArchived?: boolean): Memory[];
  listTags(includeArchived?: boolean): MemoryTag[];
  update(idOrSlug: string, input: UpdateMemoryInput, source?: AuditSource): MemoryDetail;
  history(idOrSlug: string): MemoryRevision[];
  revision(idOrSlug: string, revision: number): MemoryRevision | undefined;
}

export class MemoryNotFoundError extends Error {}
export class MemoryRevisionConflictError extends Error {}

function parseStringArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function mapMemory(row: Row): Memory {
  return MemorySchema.parse({
    id: row.id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    summary: row.summary,
    kind: row.kind,
    tags: parseStringArray(row.tags_json),
    aliases: parseStringArray(row.aliases_json),
    project: row.project,
    status: row.status,
    provenance: {
      sourceType: row.source_type,
      sourceUri: row.source_uri,
      sourceRef: row.source_ref,
      capturedAt: row.captured_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  });
}

function mapRevision(row: Row): MemoryRevision {
  const memory = mapMemory({ ...row, id: row.memory_id });
  return MemoryRevisionSchema.parse({
    ...memory,
    memoryId: row.memory_id,
    recordedAt: row.recorded_at,
  });
}

function normalizeTags(values: string[]): string[] {
  const normalized = values.map((value) => value.trim().replace(/\s+/g, " ").toLowerCase());
  return [...new Set(normalized)].filter(Boolean);
}

function normalizeAliases(values: string[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const alias = raw.trim().replace(/\s+/g, " ");
    const key = alias.toLocaleLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

export function slugifyMemoryTitle(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "");
  return slug || "memory";
}

function extractLinks(body: string): Array<{ slug: string; label: string }> {
  const links: Array<{ slug: string; label: string }> = [];
  const seen = new Set<string>();
  const pattern = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
  for (const match of body.matchAll(pattern)) {
    const target = match[1]?.trim();
    if (!target) continue;
    const link = { slug: slugifyMemoryTitle(target), label: match[2]?.trim() || target };
    const key = `${link.slug}\u0000${link.label.toLocaleLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push(link);
    }
  }
  return links;
}

function ftsQuery(query: string): string | undefined {
  const tokens = query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

export class SqliteMemoryRepository implements MemoryProvider {
  readonly #db: DatabaseSync;
  readonly #onEvent: ((event: AssistantEvent) => void) | undefined;

  constructor(databasePath: string, onEvent?: (event: AssistantEvent) => void) {
    this.#db = new DatabaseSync(databasePath);
    this.#onEvent = onEvent;
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        body TEXT NOT NULL, tags_json TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, source TEXT NOT NULL,
        occurred_at TEXT NOT NULL, entity_type TEXT, entity_id TEXT, payload_json TEXT NOT NULL
      );
    `);

    const columns = new Set(
      (this.#db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const additions: Array<[string, string]> = [
      ["summary", "TEXT"],
      ["kind", "TEXT NOT NULL DEFAULT 'note'"],
      ["aliases_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["project", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
      ["source_type", "TEXT NOT NULL DEFAULT 'legacy'"],
      ["source_uri", "TEXT"],
      ["source_ref", "TEXT"],
      ["captured_at", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.#db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
    this.#db.exec("UPDATE memories SET captured_at=created_at WHERE captured_at IS NULL");

    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS memories_status_updated_idx ON memories(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_revisions (
        memory_id TEXT NOT NULL, revision INTEGER NOT NULL, slug TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, summary TEXT, kind TEXT NOT NULL,
        tags_json TEXT NOT NULL, aliases_json TEXT NOT NULL, project TEXT, status TEXT NOT NULL,
        source_type TEXT NOT NULL, source_uri TEXT, source_ref TEXT, captured_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, revision), FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS memory_links (
        source_memory_id TEXT NOT NULL, target_slug TEXT NOT NULL, label TEXT NOT NULL,
        ordinal INTEGER NOT NULL, PRIMARY KEY(source_memory_id, ordinal),
        FOREIGN KEY(source_memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS memory_links_target_idx ON memory_links(target_slug);
      INSERT OR IGNORE INTO memory_revisions (
        memory_id, revision, slug, title, body, summary, kind, tags_json, aliases_json,
        project, status, source_type, source_uri, source_ref, captured_at, created_at,
        updated_at, recorded_at
      ) SELECT id, revision, slug, title, body, summary, kind, tags_json, aliases_json,
        project, status, source_type, source_uri, source_ref, captured_at, created_at,
        updated_at, updated_at FROM memories;
    `);

    const ftsSql = String(
      (this.#db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as Row | undefined)?.sql ?? "",
    );
    if (!ftsSql.includes("aliases") || !ftsSql.includes("summary")) {
      this.#db.exec("DROP TABLE IF EXISTS memories_fts");
    }
    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED, title, aliases, summary, body, tags
      );
      DELETE FROM memories_fts;
      INSERT INTO memories_fts(memory_id, title, aliases, summary, body, tags)
      SELECT id, title, replace(replace(aliases_json, '[', ' '), ']', ' '), coalesce(summary, ''),
        body, replace(replace(tags_json, '[', ' '), ']', ' ')
      FROM memories WHERE status='active';
    `);

    const missingLinks = this.#db.prepare(`SELECT id, body FROM memories
      WHERE id NOT IN (SELECT DISTINCT source_memory_id FROM memory_links)`).all() as Row[];
    for (const row of missingLinks) this.#writeLinks(String(row.id), String(row.body));
  }

  create(input: CreateMemoryInput, source: AuditSource = "api"): MemoryDetail {
    return this.#create(CreateMemorySchema.parse(input), "memory.created", source);
  }

  ingest(input: unknown, source: AuditSource = "api"): MemoryDetail {
    return this.#create(IngestMemorySchema.parse(input), "memory.ingested", source);
  }

  #create(
    input: ReturnType<typeof CreateMemorySchema.parse>,
    eventType: "memory.created" | "memory.ingested",
    source: AuditSource,
  ): MemoryDetail {
    const now = new Date().toISOString();
    let memory: Memory | undefined;
    let event: AssistantEvent | undefined;
    this.#transaction(() => {
      const slug = this.#availableSlug(input.slug ?? slugifyMemoryTitle(input.title));
      memory = MemorySchema.parse({
        id: randomUUID(),
        slug,
        title: input.title,
        body: input.body,
        summary: input.summary ?? null,
        kind: input.kind,
        tags: normalizeTags(input.tags),
        aliases: normalizeAliases(input.aliases),
        project: input.project ?? null,
        status: "active",
        provenance: {
          sourceType: input.provenance.sourceType,
          sourceUri: input.provenance.sourceUri ?? null,
          sourceRef: input.provenance.sourceRef ?? null,
          capturedAt: input.provenance.capturedAt ?? now,
        },
        createdAt: now,
        updatedAt: now,
        revision: 1,
      });
      this.#insertMemory(memory);
      this.#writeRevision(memory, now);
      this.#writeLinks(memory.id, memory.body);
      this.#writeFts(memory);
      event = this.#insertEvent(eventType, source, memory.id, { memory });
    });
    if (event) this.#onEvent?.(event);
    if (!memory) throw new Error("Memory transaction did not produce a record");
    return this.get(memory.id) as MemoryDetail;
  }

  get(idOrSlug: string): MemoryDetail | undefined {
    const row = this.#db.prepare("SELECT * FROM memories WHERE id=? OR slug=?").get(idOrSlug, idOrSlug) as Row | undefined;
    if (!row) return undefined;
    const memory = mapMemory(row);
    return MemoryDetailSchema.parse({
      memory,
      outgoingLinks: this.outgoingLinks(memory.id),
      backlinks: this.backlinks(memory.slug),
    });
  }

  list(options: MemoryListOptions = {}): Memory[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const match = options.query ? ftsQuery(options.query) : undefined;
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.status) {
      clauses.push("m.status=?");
      parameters.push(options.status);
    } else if (!options.includeArchived) {
      clauses.push("m.status='active'");
    }
    if (options.project) {
      clauses.push("m.project=?");
      parameters.push(options.project);
    }
    if (options.kind) {
      clauses.push("m.kind=?");
      parameters.push(options.kind);
    }
    if (options.tag) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE lower(value)=lower(?))");
      parameters.push(options.tag);
    }
    const where = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
    if (match) {
      return (this.#db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.memory_id
        WHERE memories_fts MATCH ?${where} ORDER BY bm25(memories_fts), m.updated_at DESC LIMIT ?`)
        .all(match, ...parameters, limit) as Row[]).map(mapMemory);
    }
    return (this.#db.prepare(`SELECT m.* FROM memories m WHERE 1=1${where} ORDER BY m.updated_at DESC LIMIT ?`)
      .all(...parameters, limit) as Row[]).map(mapMemory);
  }

  listTags(includeArchived = false): MemoryTag[] {
    const statusClause = includeArchived ? "" : "AND m.status='active'";
    return (this.#db.prepare(`SELECT lower(trim(j.value)) AS tag, count(*) AS count
      FROM memories m, json_each(m.tags_json) j WHERE trim(j.value) <> '' ${statusClause}
      GROUP BY lower(trim(j.value)) ORDER BY count DESC, tag COLLATE NOCASE`)
      .all() as Row[]).map((row) => MemoryTagSchema.parse(row));
  }

  exportAll(includeArchived = false): Memory[] {
    const where = includeArchived ? "" : "WHERE status='active'";
    return (this.#db.prepare(`SELECT * FROM memories ${where} ORDER BY slug COLLATE NOCASE`).all() as Row[])
      .map(mapMemory);
  }

  update(idOrSlug: string, input: UpdateMemoryInput, source: AuditSource = "api"): MemoryDetail {
    const value = UpdateMemorySchema.parse(input);
    const detail = this.get(idOrSlug);
    if (!detail) throw new MemoryNotFoundError(`Memory ${idOrSlug} was not found`);
    const current = detail.memory;
    if (value.expectedRevision !== current.revision) {
      throw new MemoryRevisionConflictError(`Memory ${current.slug} has changed since revision ${value.expectedRevision}`);
    }
    const updated = MemorySchema.parse({
      ...current,
      ...(value.title !== undefined ? { title: value.title } : {}),
      ...(value.body !== undefined ? { body: value.body } : {}),
      ...(Object.hasOwn(value, "summary") ? { summary: value.summary ?? null } : {}),
      ...(value.kind !== undefined ? { kind: value.kind } : {}),
      ...(value.tags !== undefined ? { tags: normalizeTags(value.tags) } : {}),
      ...(value.aliases !== undefined ? { aliases: normalizeAliases(value.aliases) } : {}),
      ...(Object.hasOwn(value, "project") ? { project: value.project ?? null } : {}),
      ...(value.status !== undefined ? { status: value.status } : {}),
      ...(value.provenance !== undefined ? { provenance: value.provenance } : {}),
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1,
    });

    let event: AssistantEvent | undefined;
    this.#transaction(() => {
      const result = this.#db.prepare(`UPDATE memories SET title=?, body=?, summary=?, kind=?,
        tags_json=?, aliases_json=?, project=?, status=?, source_type=?, source_uri=?, source_ref=?,
        captured_at=?, updated_at=?, revision=? WHERE id=? AND revision=?`).run(
        updated.title, updated.body, updated.summary, updated.kind, JSON.stringify(updated.tags),
        JSON.stringify(updated.aliases), updated.project, updated.status, updated.provenance.sourceType,
        updated.provenance.sourceUri, updated.provenance.sourceRef, updated.provenance.capturedAt,
        updated.updatedAt, updated.revision, current.id, current.revision,
      );
      if (result.changes !== 1) throw new MemoryRevisionConflictError(`Memory ${current.slug} changed during the update`);
      this.#writeRevision(updated, updated.updatedAt);
      this.#writeLinks(updated.id, updated.body);
      this.#db.prepare("DELETE FROM memories_fts WHERE memory_id=?").run(updated.id);
      if (updated.status === "active") this.#writeFts(updated);
      event = this.#insertEvent(
        updated.status === "archived" && current.status !== "archived" ? "memory.archived" : "memory.updated",
        source,
        updated.id,
        { memory: updated, previousRevision: current.revision },
      );
    });
    if (event) this.#onEvent?.(event);
    return this.get(updated.id) as MemoryDetail;
  }

  history(idOrSlug: string): MemoryRevision[] {
    const detail = this.get(idOrSlug);
    if (!detail) throw new MemoryNotFoundError(`Memory ${idOrSlug} was not found`);
    return (this.#db.prepare("SELECT * FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC")
      .all(detail.memory.id) as Row[]).map(mapRevision);
  }

  revision(idOrSlug: string, revision: number): MemoryRevision | undefined {
    const detail = this.get(idOrSlug);
    if (!detail) throw new MemoryNotFoundError(`Memory ${idOrSlug} was not found`);
    const row = this.#db.prepare("SELECT * FROM memory_revisions WHERE memory_id=? AND revision=?")
      .get(detail.memory.id, revision) as Row | undefined;
    return row ? mapRevision(row) : undefined;
  }

  outgoingLinks(memoryId: string): MemoryLink[] {
    return (this.#db.prepare(`SELECT l.target_slug AS slug, l.label, m.id AS resolved_memory_id
      FROM memory_links l LEFT JOIN memories m ON m.slug=l.target_slug
      WHERE l.source_memory_id=? ORDER BY l.ordinal`).all(memoryId) as Row[]).map((row) =>
      MemoryLinkSchema.parse({ slug: row.slug, label: row.label, resolvedMemoryId: row.resolved_memory_id }),
    );
  }

  backlinks(slug: string): MemoryBacklink[] {
    return (this.#db.prepare(`SELECT DISTINCT m.id, m.slug, m.title, m.status
      FROM memory_links l JOIN memories m ON m.id=l.source_memory_id
      WHERE l.target_slug=? ORDER BY m.title COLLATE NOCASE`).all(slug) as Row[]).map((row) =>
      MemoryBacklinkSchema.parse(row),
    );
  }

  #availableSlug(requested: string): string {
    const base = requested.slice(0, 160).replace(/-+$/g, "") || "memory";
    let candidate = base;
    let suffix = 2;
    while (this.#db.prepare("SELECT 1 FROM memories WHERE slug=?").get(candidate)) {
      const ending = `-${suffix}`;
      candidate = `${base.slice(0, 160 - ending.length).replace(/-+$/g, "")}${ending}`;
      suffix += 1;
    }
    return candidate;
  }

  #insertMemory(memory: Memory): void {
    this.#db.prepare(`INSERT INTO memories (
      id, slug, title, body, tags_json, created_at, updated_at, revision, summary, kind,
      aliases_json, project, status, source_type, source_uri, source_ref, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      memory.id, memory.slug, memory.title, memory.body, JSON.stringify(memory.tags), memory.createdAt,
      memory.updatedAt, memory.revision, memory.summary, memory.kind, JSON.stringify(memory.aliases),
      memory.project, memory.status, memory.provenance.sourceType, memory.provenance.sourceUri,
      memory.provenance.sourceRef, memory.provenance.capturedAt,
    );
  }

  #writeRevision(memory: Memory, recordedAt: string): void {
    this.#db.prepare(`INSERT INTO memory_revisions (
      memory_id, revision, slug, title, body, summary, kind, tags_json, aliases_json,
      project, status, source_type, source_uri, source_ref, captured_at, created_at,
      updated_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      memory.id, memory.revision, memory.slug, memory.title, memory.body, memory.summary, memory.kind,
      JSON.stringify(memory.tags), JSON.stringify(memory.aliases), memory.project, memory.status,
      memory.provenance.sourceType, memory.provenance.sourceUri, memory.provenance.sourceRef,
      memory.provenance.capturedAt, memory.createdAt, memory.updatedAt, recordedAt,
    );
  }

  #writeLinks(memoryId: string, body: string): void {
    this.#db.prepare("DELETE FROM memory_links WHERE source_memory_id=?").run(memoryId);
    const insert = this.#db.prepare(
      "INSERT INTO memory_links(source_memory_id, target_slug, label, ordinal) VALUES (?, ?, ?, ?)",
    );
    extractLinks(body).forEach((link, ordinal) => insert.run(memoryId, link.slug, link.label, ordinal));
  }

  #writeFts(memory: Memory): void {
    this.#db.prepare(`INSERT INTO memories_fts(memory_id, title, aliases, summary, body, tags)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      memory.id, memory.title, memory.aliases.join(" "), memory.summary ?? "", memory.body,
      memory.tags.join(" "),
    );
  }

  #insertEvent(
    type: string,
    source: AuditSource,
    entityId: string,
    payload: Record<string, unknown>,
  ): AssistantEvent {
    const occurredAt = new Date().toISOString();
    const result = this.#db.prepare(`INSERT INTO events
      (type, source, occurred_at, entity_type, entity_id, payload_json)
      VALUES (?, ?, ?, 'memory', ?, ?)`).run(type, source, occurredAt, entityId, JSON.stringify(payload));
    const row = this.#db.prepare("SELECT * FROM events WHERE id=?").get(result.lastInsertRowid) as Row;
    return AssistantEventSchema.parse({
      id: row.id, type: row.type, source: row.source, occurredAt: row.occurred_at,
      entityType: row.entity_type, entityId: row.entity_id,
      payload: JSON.parse(String(row.payload_json)) as unknown,
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
