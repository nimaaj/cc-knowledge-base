import { z } from "zod";
import type { Memory } from "@cc-assistant/shared";

const ImportedMemorySchema = z.object({
  formatVersion: z.literal(1),
  id: z.uuid().nullable(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().max(2_000).nullable(),
  kind: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/).max(80),
  tags: z.array(z.string().trim().min(1).max(160)).max(100),
  aliases: z.array(z.string().trim().min(1).max(160)).max(100),
  project: z.string().trim().min(1).max(160).nullable(),
  status: z.enum(["active", "archived"]),
  revision: z.number().int().nonnegative(),
  provenance: z.object({
    sourceType: z.string().trim().min(1).max(80),
    sourceUri: z.string().trim().min(1).max(2_000).nullable(),
    sourceRef: z.string().trim().min(1).max(500).nullable(),
    capturedAt: z.iso.datetime(),
  }),
  body: z.string().max(200_000),
});

export type ImportedMemory = z.infer<typeof ImportedMemorySchema>;

const metadataKeys = [
  "cc_memory_format",
  "id",
  "slug",
  "title",
  "summary",
  "kind",
  "tags",
  "aliases",
  "project",
  "status",
  "revision",
  "source_type",
  "source_uri",
  "source_ref",
  "captured_at",
] as const;

function frontmatterValue(value: unknown): string {
  return JSON.stringify(value);
}

export function serializeMemoryMarkdown(memory: Memory): string {
  const values: Record<(typeof metadataKeys)[number], unknown> = {
    cc_memory_format: 1,
    id: memory.id,
    slug: memory.slug,
    title: memory.title,
    summary: memory.summary,
    kind: memory.kind,
    tags: memory.tags,
    aliases: memory.aliases,
    project: memory.project,
    status: memory.status,
    revision: memory.revision,
    source_type: memory.provenance.sourceType,
    source_uri: memory.provenance.sourceUri,
    source_ref: memory.provenance.sourceRef,
    captured_at: memory.provenance.capturedAt,
  };
  const frontmatter = metadataKeys.map((key) => `${key}: ${frontmatterValue(values[key])}`).join("\n");
  const body = memory.body.replaceAll("\r\n", "\n").replace(/\n+$/u, "");
  return `---\n${frontmatter}\n---\n${body}\n`;
}

export function parseMemoryMarkdown(path: string, content: string): ImportedMemory {
  const normalized = content.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/u.exec(normalized);
  if (!match) throw new Error("Expected JSON-valued YAML frontmatter delimited by --- lines");

  const rawMetadata: Record<string, unknown> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    if (!metadataKeys.includes(key as (typeof metadataKeys)[number])) {
      throw new Error(`Unknown frontmatter field: ${key}`);
    }
    if (Object.hasOwn(rawMetadata, key)) throw new Error(`Duplicate frontmatter field: ${key}`);
    const encoded = line.slice(separator + 1).trim();
    try {
      rawMetadata[key] = JSON.parse(encoded) as unknown;
    } catch {
      throw new Error(`Frontmatter field ${key} must contain a JSON value`);
    }
  }

  const body = (match[2] ?? "").replace(/\n$/u, "");
  const parsed = ImportedMemorySchema.parse({
    formatVersion: rawMetadata.cc_memory_format,
    id: rawMetadata.id ?? null,
    slug: rawMetadata.slug,
    title: rawMetadata.title,
    summary: rawMetadata.summary ?? null,
    kind: rawMetadata.kind,
    tags: rawMetadata.tags ?? [],
    aliases: rawMetadata.aliases ?? [],
    project: rawMetadata.project ?? null,
    status: rawMetadata.status,
    revision: rawMetadata.revision,
    provenance: {
      sourceType: rawMetadata.source_type,
      sourceUri: rawMetadata.source_uri ?? null,
      sourceRef: rawMetadata.source_ref ?? null,
      capturedAt: rawMetadata.captured_at,
    },
    body,
  });
  if (!path.toLocaleLowerCase().endsWith(".md")) throw new Error("Memory import paths must end in .md");
  return parsed;
}
