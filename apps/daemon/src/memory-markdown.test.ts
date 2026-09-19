import { describe, expect, it } from "vitest";
import { MemorySchema } from "@cc-assistant/shared";
import { parseMemoryMarkdown, serializeMemoryMarkdown } from "./memory-markdown.js";

describe("memory Markdown interchange", () => {
  it("round-trips all editable fields with deterministic JSON-valued frontmatter", () => {
    const memory = MemorySchema.parse({
      id: "38f581e2-cf22-4e42-a0ca-c12fa408be8f",
      slug: "communication-style",
      title: "Communication style",
      body: "Prefer concise answers.\n\nSee [[System Settings]].",
      summary: "How to communicate with the user",
      kind: "preference",
      tags: ["user preferences", "communicated style"],
      aliases: ["Writing style"],
      project: null,
      status: "active",
      provenance: {
        sourceType: "conversation",
        sourceUri: null,
        sourceRef: "session-42",
        capturedAt: "2026-09-19T14:00:00.000Z",
      },
      createdAt: "2026-09-19T14:00:00.000Z",
      updatedAt: "2026-09-19T14:00:00.000Z",
      revision: 3,
    });

    const markdown = serializeMemoryMarkdown(memory);
    expect(markdown).toContain('tags: ["user preferences","communicated style"]');
    expect(parseMemoryMarkdown("memories/communication-style.md", markdown)).toEqual({
      formatVersion: 1,
      id: memory.id,
      slug: memory.slug,
      title: memory.title,
      body: memory.body,
      summary: memory.summary,
      kind: memory.kind,
      tags: memory.tags,
      aliases: memory.aliases,
      project: memory.project,
      status: memory.status,
      revision: memory.revision,
      provenance: memory.provenance,
    });
    expect(serializeMemoryMarkdown(memory)).toBe(markdown);
  });

  it("rejects unknown metadata and non-Markdown paths", () => {
    const invalid = "---\ncc_memory_format: 1\nunknown: true\n---\nBody\n";
    expect(() => parseMemoryMarkdown("memory.md", invalid)).toThrow("Unknown frontmatter field");
    expect(() => parseMemoryMarkdown("memory.txt", invalid.replace("unknown: true\n", ""))).toThrow();
  });
});
