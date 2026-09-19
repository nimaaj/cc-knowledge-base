import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryRevisionConflictError,
  SqliteMemoryRepository,
} from "./memory-repository.js";

const paths: string[] = [];

function repository(): SqliteMemoryRepository {
  const path = join(tmpdir(), `cc-assistant-memory-${randomUUID()}.sqlite`);
  paths.push(path);
  return new SqliteMemoryRepository(path);
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
});

describe("SqliteMemoryRepository", () => {
  it("normalizes metadata, generates collision-safe slugs, and searches every indexed field", () => {
    const store = repository();
    const first = store.create({
      title: "Project Orchid",
      body: "Uses a blue-green rollout.",
      summary: "Release handbook",
      aliases: [" Orchid ", "orchid", "Flowers"],
      tags: [" Work ", "work", "Deployments"],
      project: "assistant",
    });
    const second = store.create({ title: "Project Orchid", body: "Follow-up" });

    expect(first.memory.slug).toBe("project-orchid");
    expect(second.memory.slug).toBe("project-orchid-2");
    expect(first.memory.tags).toEqual(["work", "deployments"]);
    expect(first.memory.aliases).toEqual(["Orchid", "Flowers"]);
    expect(store.list({ query: "Release handbook" })).toMatchObject([{ id: first.memory.id }]);
    expect(store.list({ query: "Flowers" })).toMatchObject([{ id: first.memory.id }]);
    expect(store.list({ query: `"blue" (green)` })).toMatchObject([{ id: first.memory.id }]);
    expect(store.list({ query: `!!!` })).toHaveLength(2);
    expect(store.listTags()).toEqual([
      { tag: "deployments", count: 1 },
      { tag: "work", count: 1 },
    ]);
    store.close();
  });

  it("indexes wiki links, resolves pages created later, and returns backlinks", () => {
    const store = repository();
    const source = store.create({
      title: "Release notes",
      body: "See [[Project Orchid|the plan]] and [[Missing Page]].",
    });
    expect(source.outgoingLinks).toEqual([
      { slug: "project-orchid", label: "the plan", resolvedMemoryId: null },
      { slug: "missing-page", label: "Missing Page", resolvedMemoryId: null },
    ]);

    const target = store.create({ title: "Project Orchid", body: "Plan" });
    expect(store.get(source.memory.id)?.outgoingLinks[0]?.resolvedMemoryId).toBe(target.memory.id);
    expect(store.get(target.memory.slug)?.backlinks).toMatchObject([
      { id: source.memory.id, slug: source.memory.slug },
    ]);
    store.close();
  });

  it("requires the current revision, preserves history, and removes archived pages from search", () => {
    const store = repository();
    const created = store.ingest({
      title: "Deployment preference",
      body: "Prefer canary releases.",
      kind: "preference",
      provenance: { sourceType: "conversation", sourceRef: "session-123" },
    });
    const updated = store.update(created.memory.id, {
      body: "Prefer staged canary releases.",
      expectedRevision: created.memory.revision,
    });
    expect(updated.memory.revision).toBe(2);
    expect(store.history(created.memory.id).map((item) => item.revision)).toEqual([2, 1]);
    expect(store.revision(created.memory.id, 1)?.body).toBe("Prefer canary releases.");
    expect(() => store.update(created.memory.id, {
      title: "Stale edit",
      expectedRevision: 1,
    })).toThrow(MemoryRevisionConflictError);

    store.update(created.memory.id, { status: "archived", expectedRevision: 2 });
    expect(store.list({ query: "canary" })).toHaveLength(0);
    expect(store.list({ includeArchived: true })).toMatchObject([{ status: "archived" }]);
    store.close();
  });

  it("migrates the original minimal memory schema without losing pages", () => {
    const path = join(tmpdir(), `cc-assistant-legacy-memory-${randomUUID()}.sqlite`);
    paths.push(path);
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        body TEXT NOT NULL, tags_json TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, title, body, tags);
    `);
    const now = new Date().toISOString();
    const id = randomUUID();
    legacy.prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, "legacy-page", "Legacy Page", "See [[Future Page]].", '["old"]', now, now, 1);
    legacy.close();

    const store = new SqliteMemoryRepository(path);
    expect(store.get(id)).toMatchObject({
      memory: { slug: "legacy-page", kind: "note", status: "active", revision: 1 },
      outgoingLinks: [{ slug: "future-page" }],
    });
    expect(store.history(id)).toHaveLength(1);
    expect(store.list({ query: "legacy" })).toMatchObject([{ id }]);
    store.close();
  });
});
