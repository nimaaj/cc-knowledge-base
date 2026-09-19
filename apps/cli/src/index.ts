#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { DaemonClient } from "@cc-assistant/client";
import {
  ApprovalListSchema,
  ClaudeSessionListSchema,
  MemoryMarkdownExportSchema,
  RunListSchema,
  RunSchema,
  TaskListSchema,
  TaskSchema,
  taskStatuses,
  type ClaudeSession,
  type Task,
  type TaskStatus,
} from "@cc-assistant/shared";

const rawArgs = process.argv.slice(2);
const jsonIndex = rawArgs.indexOf("--json");
const jsonOutput = jsonIndex !== -1;
if (jsonIndex !== -1) rawArgs.splice(jsonIndex, 1);

const client = new DaemonClient({ source: "cli" });

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printTasks(tasks: Task[]): void {
  if (jsonOutput) return printJson({ tasks });
  console.table(
    tasks.map((task) => ({
      id: task.id,
      status: task.status,
      priority: task.priority,
      project: task.project ?? "",
      title: task.title,
      revision: task.revision,
      updated: task.updatedAt,
    })),
  );
}

function printSessions(sessions: ClaudeSession[]): void {
  if (jsonOutput) return printJson({ sessions });
  console.table(
    sessions.map((session) => ({
      id: session.id,
      status: session.status,
      cwd: session.cwd,
      model: session.model ?? "",
      event: session.lastEvent,
      updated: session.lastEventAt,
    })),
  );
}

function help(): never {
  console.log(`cc-assistant developer CLI

Usage:
  pnpm cca status [--json]
  pnpm cca task list [--status <status>] [--json]
  pnpm cca task get <id> [--json]
  pnpm cca task create <title> [--project <name>] [--description <text>]
                       [--status <status>] [--priority <0-4>] [--due <ISO time>]
  pnpm cca task update <id> [--title <title>] [--description <text>]
                       [--project <name> | --clear-project] [--status <status>]
                       [--priority <0-4>] [--due <ISO time> | --clear-due]
                       [--revision <number>]
  pnpm cca task focus <id> [--revision <number>]
  pnpm cca task complete <id> [--revision <number>]
  pnpm cca session list [--all] [--json]
  pnpm cca session get <id> [--json]
  pnpm cca run list [--status <status>] [--json]
  pnpm cca run get <id> [--json]
  pnpm cca run logs <id> [--after <sequence>] [--json]
  pnpm cca run agent <title> --prompt <text> [--cwd <path>] [--model <model>]
                     [--effort <level>] [--max-turns <n>] [--max-budget <usd>]
                     [--task <id>] [--worktree]
  pnpm cca run command <title> <executable> [args...] [--cwd <path>]
                       [--timeout <ms>] [--task <id>]
  pnpm cca run cancel <id>
  pnpm cca approval list [--status <status>] [--json]
  pnpm cca approval approve <id> [--note <text>]
  pnpm cca approval deny <id> [--note <text>]
  pnpm cca memory list [--query <text>] [--project <name>] [--kind <kind>]
                       [--tag <tag>] [--all] [--limit <n>] [--json]
  pnpm cca memory get <id-or-slug> [--json]
  pnpm cca memory create <title> --body <text> [--slug <slug>] [--summary <text>]
                         [--kind <kind>] [--tags <a,b>] [--aliases <a,b>] [--project <name>]
  pnpm cca memory ingest <title> --body <text> --source-type <type>
                         [--source-uri <uri>] [--source-ref <ref>] [create options]
  pnpm cca memory update <id-or-slug> --revision <number> [--title <text>]
                         [--body <text>] [--summary <text>] [--kind <kind>]
                         [--tags <a,b>] [--aliases <a,b>] [--project <name>]
  pnpm cca memory archive <id-or-slug> --revision <number>
  pnpm cca memory history <id-or-slug> [--json]
  pnpm cca memory export --output <directory> [--all]
  pnpm cca memory import <file-or-directory> [--apply]
  pnpm cca schedule list [--json]
  pnpm cca schedule create <name> --trigger-kind <kind> --trigger <json>
                           --action-kind <kind> --action <json>
  pnpm cca schedule enable|disable <id>
  pnpm cca notification list [--all] [--json]
  pnpm cca notification read <id>
  pnpm cca ability list [--json]
  pnpm cca ability install <manifest.json>
  pnpm cca ability invoke <id> [json-input]
  pnpm cca browser calendar list
  pnpm cca browser calendar create <json-input>
  pnpm cca browser slack unreads
  pnpm cca browser slack read <channel>
  pnpm cca browser slack send <channel> <text>
  pnpm cca native clipboard-image --output <file>
  pnpm cca native notify <title> [body]
  pnpm cca event list [--after <id>] [--limit <1-500>] [--json]
  pnpm cca state export [--json]
  pnpm cca api <METHOD> </api/path> [json-body] [--json]

Configuration:
  CC_ASSISTANT_DATA_DIR   Directory containing access-token
  CC_ASSISTANT_DAEMON_URL  Daemon URL (default http://127.0.0.1:4317)
  CC_ASSISTANT_TOKEN      Explicit token override
`);
  process.exit(0);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function statusOption(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`status must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function markdownFiles(inputPath: string): Array<{ path: string; content: string }> {
  const root = resolve(inputPath);
  if (!statSync(root).isDirectory()) {
    return [{ path: root.split(sep).at(-1) ?? "memory.md", content: readFileSync(root, "utf8") }];
  }
  const files: Array<{ path: string; content: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".md")) {
        files.push({ path: relative(root, absolute).split(sep).join("/"), content: readFileSync(absolute, "utf8") });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function taskCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") {
    const parsed = parseArgs({
      args,
      options: { status: { type: "string" } },
      strict: true,
    });
    const status = statusOption(parsed.values.status);
    const query = status ? `?status=${status}` : "";
    const payload = TaskListSchema.parse(await client.request(`/api/tasks${query}`));
    return printTasks(payload.tasks);
  }

  if (action === "get") {
    const id = required(args[0], "task ID");
    const payload = (await client.request(`/api/tasks/${encodeURIComponent(id)}`)) as {
      task: unknown;
    };
    const task = TaskSchema.parse(payload.task);
    return jsonOutput ? printJson({ task }) : printTasks([task]);
  }

  if (action === "create") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        description: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        due: { type: "string" },
      },
      strict: true,
    });
    const title = required(parsed.positionals[0], "task title");
    const body = {
      title,
      ...(parsed.values.project ? { project: parsed.values.project } : {}),
      ...(parsed.values.description ? { description: parsed.values.description } : {}),
      ...(parsed.values.status ? { status: statusOption(parsed.values.status) } : {}),
      ...(parsed.values.priority
        ? { priority: numberOption(parsed.values.priority, "priority") }
        : {}),
      ...(parsed.values.due ? { dueAt: parsed.values.due } : {}),
    };
    const payload = (await client.request("/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
    })) as { task: unknown };
    const task = TaskSchema.parse(payload.task);
    return jsonOutput ? printJson({ task }) : printTasks([task]);
  }

  if (action === "update") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        title: { type: "string" },
        description: { type: "string" },
        project: { type: "string" },
        "clear-project": { type: "boolean" },
        status: { type: "string" },
        priority: { type: "string" },
        due: { type: "string" },
        "clear-due": { type: "boolean" },
        revision: { type: "string" },
      },
      strict: true,
    });
    const id = required(parsed.positionals[0], "task ID");
    const body = {
      ...(parsed.values.title !== undefined ? { title: parsed.values.title } : {}),
      ...(parsed.values.description !== undefined
        ? { description: parsed.values.description }
        : {}),
      ...(parsed.values["clear-project"]
        ? { project: null }
        : parsed.values.project !== undefined
          ? { project: parsed.values.project }
          : {}),
      ...(parsed.values.status ? { status: statusOption(parsed.values.status) } : {}),
      ...(parsed.values.priority !== undefined
        ? { priority: numberOption(parsed.values.priority, "priority") }
        : {}),
      ...(parsed.values["clear-due"]
        ? { dueAt: null }
        : parsed.values.due !== undefined
          ? { dueAt: parsed.values.due }
          : {}),
      ...(parsed.values.revision !== undefined
        ? { expectedRevision: numberOption(parsed.values.revision, "revision") }
        : {}),
    };
    const payload = (await client.request(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })) as { task: unknown };
    const task = TaskSchema.parse(payload.task);
    return jsonOutput ? printJson({ task }) : printTasks([task]);
  }

  if (action === "focus" || action === "complete") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { revision: { type: "string" } },
      strict: true,
    });
    const id = required(parsed.positionals[0], "task ID");
    const body = {
      status: action === "focus" ? "active" : "done",
      ...(parsed.values.revision
        ? { expectedRevision: numberOption(parsed.values.revision, "revision") }
        : {}),
    };
    const payload = (await client.request(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })) as { task: unknown };
    const task = TaskSchema.parse(payload.task);
    return jsonOutput ? printJson({ task }) : printTasks([task]);
  }

  help();
}

async function sessionCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") {
    const parsed = parseArgs({
      args,
      options: { all: { type: "boolean" } },
      strict: true,
    });
    const payload = ClaudeSessionListSchema.parse(
      await client.request(`/api/sessions${parsed.values.all ? "?includeEnded=true" : ""}`),
    );
    return printSessions(payload.sessions);
  }
  if (action === "get") {
    const id = required(args[0], "session ID");
    const payload = (await client.request(`/api/sessions/${encodeURIComponent(id)}`)) as {
      session: unknown;
    };
    return jsonOutput ? printJson(payload) : printSessions([payload.session as ClaudeSession]);
  }
  help();
}

async function eventCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action !== "list") help();
  const parsed = parseArgs({
    args,
    options: { after: { type: "string" }, limit: { type: "string" } },
    strict: true,
  });
  const after = numberOption(parsed.values.after, "after") ?? 0;
  const limit = numberOption(parsed.values.limit, "limit") ?? 100;
  const payload = await client.request(`/api/events?after=${after}&limit=${limit}`);
  if (jsonOutput) return printJson(payload);
  console.table(
    (payload as { events: Array<Record<string, unknown>> }).events.map((event) => ({
      id: event.id,
      type: event.type,
      source: event.source,
      entity: `${event.entityType ?? ""}:${event.entityId ?? ""}`,
      occurredAt: event.occurredAt,
    })),
  );
}

async function runCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") {
    const parsed = parseArgs({ args, options: { status: { type: "string" } }, strict: true });
    const suffix = parsed.values.status ? `?status=${encodeURIComponent(parsed.values.status)}` : "";
    const payload = RunListSchema.parse(await client.request(`/api/runs${suffix}`));
    if (jsonOutput) return printJson(payload);
    console.table(payload.runs.map((run) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      title: run.title,
      cwd: run.cwd,
      created: run.createdAt,
    })));
    return;
  }
  if (action === "get") {
    const id = required(args[0], "run ID");
    const payload = (await client.request(`/api/runs/${encodeURIComponent(id)}`)) as { run: unknown };
    return printJson({ run: RunSchema.parse(payload.run) });
  }
  if (action === "logs") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { after: { type: "string" } },
      strict: true,
    });
    const id = required(parsed.positionals[0], "run ID");
    const after = numberOption(parsed.values.after, "after") ?? -1;
    const payload = await client.request(`/api/runs/${encodeURIComponent(id)}/logs?after=${after}`);
    if (jsonOutput) return printJson(payload);
    for (const log of (payload as { logs: Array<Record<string, unknown>> }).logs) {
      console.log(`${log.occurredAt} [${log.level}] ${log.message}`);
    }
    return;
  }
  if (action === "agent") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        prompt: { type: "string" }, cwd: { type: "string" }, model: { type: "string" },
        effort: { type: "string" }, "max-turns": { type: "string" },
        "max-budget": { type: "string" }, task: { type: "string" },
        worktree: { type: "boolean" },
      },
      strict: true,
    });
    const body = {
      title: required(parsed.positionals[0], "run title"),
      prompt: required(parsed.values.prompt, "--prompt"),
      cwd: parsed.values.cwd ?? process.cwd(),
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
      ...(parsed.values.effort ? { effort: parsed.values.effort } : {}),
      ...(parsed.values["max-turns"] ? { maxTurns: numberOption(parsed.values["max-turns"], "max-turns") } : {}),
      ...(parsed.values["max-budget"] ? { maxBudgetUsd: Number(parsed.values["max-budget"]) } : {}),
      ...(parsed.values.task ? { taskId: parsed.values.task } : {}),
      useWorktree: parsed.values.worktree ?? false,
    };
    return printJson(await client.request("/api/runs/agent", { method: "POST", body: JSON.stringify(body) }));
  }
  if (action === "command") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { cwd: { type: "string" }, timeout: { type: "string" }, task: { type: "string" } },
      strict: true,
    });
    const body = {
      title: required(parsed.positionals[0], "run title"),
      executable: required(parsed.positionals[1], "executable"),
      args: parsed.positionals.slice(2),
      cwd: parsed.values.cwd ?? process.cwd(),
      ...(parsed.values.timeout ? { timeoutMs: numberOption(parsed.values.timeout, "timeout") } : {}),
      ...(parsed.values.task ? { taskId: parsed.values.task } : {}),
    };
    return printJson(await client.request("/api/runs/command", { method: "POST", body: JSON.stringify(body) }));
  }
  if (action === "cancel") {
    const id = required(args[0], "run ID");
    return printJson(await client.request(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }));
  }
  help();
}

async function approvalCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") {
    const parsed = parseArgs({ args, options: { status: { type: "string" } }, strict: true });
    const suffix = parsed.values.status ? `?status=${encodeURIComponent(parsed.values.status)}` : "";
    const payload = ApprovalListSchema.parse(await client.request(`/api/approvals${suffix}`));
    if (jsonOutput) return printJson(payload);
    console.table(payload.approvals.map((approval) => ({
      id: approval.id,
      status: approval.status,
      action: approval.actionType,
      summary: approval.summary,
      run: approval.runId,
      created: approval.createdAt,
    })));
    return;
  }
  if (action === "approve" || action === "deny") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { note: { type: "string" } },
      strict: true,
    });
    const id = required(parsed.positionals[0], "approval ID");
    return printJson(await client.request(`/api/approvals/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision: action === "approve" ? "approved" : "denied", note: parsed.values.note ?? null }),
    }));
  }
  help();
}

async function memoryCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") {
    const parsed = parseArgs({ args, options: {
      query: { type: "string" }, project: { type: "string" }, kind: { type: "string" },
      tag: { type: "string" }, all: { type: "boolean" }, limit: { type: "string" },
    }, strict: true });
    const query = new URLSearchParams();
    if (parsed.values.query) query.set("q", parsed.values.query);
    if (parsed.values.project) query.set("project", parsed.values.project);
    if (parsed.values.kind) query.set("kind", parsed.values.kind);
    if (parsed.values.tag) query.set("tag", parsed.values.tag);
    if (parsed.values.all) query.set("includeArchived", "true");
    if (parsed.values.limit) query.set("limit", String(numberOption(parsed.values.limit, "limit")));
    return printJson(await client.request(`/api/memories?${query}`));
  }
  if (action === "get") return printJson(await client.request(`/api/memories/${encodeURIComponent(required(args[0], "memory ID or slug"))}`));
  if (action === "create" || action === "ingest") {
    const parsed = parseArgs({ args, allowPositionals: true, options: {
      body: { type: "string" }, slug: { type: "string" }, summary: { type: "string" },
      kind: { type: "string" }, tags: { type: "string" }, aliases: { type: "string" },
      project: { type: "string" }, "source-type": { type: "string" },
      "source-uri": { type: "string" }, "source-ref": { type: "string" },
    }, strict: true });
    const payload = {
      title: required(parsed.positionals[0], "title"), body: required(parsed.values.body, "--body"),
      ...(parsed.values.slug ? { slug: parsed.values.slug } : {}),
      ...(parsed.values.summary !== undefined ? { summary: parsed.values.summary } : {}),
      ...(parsed.values.kind ? { kind: parsed.values.kind } : {}),
      tags: parsed.values.tags?.split(",").filter(Boolean) ?? [],
      aliases: parsed.values.aliases?.split(",").filter(Boolean) ?? [],
      ...(parsed.values.project ? { project: parsed.values.project } : {}),
      ...(action === "ingest" ? { provenance: {
        sourceType: required(parsed.values["source-type"], "--source-type"),
        ...(parsed.values["source-uri"] ? { sourceUri: parsed.values["source-uri"] } : {}),
        ...(parsed.values["source-ref"] ? { sourceRef: parsed.values["source-ref"] } : {}),
      } } : {}),
    };
    return printJson(await client.request(action === "ingest" ? "/api/memories/ingest" : "/api/memories", {
      method: "POST", body: JSON.stringify(payload),
    }));
  }
  if (action === "update") {
    const parsed = parseArgs({ args, allowPositionals: true, options: {
      title: { type: "string" }, body: { type: "string" }, summary: { type: "string" },
      kind: { type: "string" }, tags: { type: "string" }, aliases: { type: "string" },
      project: { type: "string" }, "clear-project": { type: "boolean" }, revision: { type: "string" },
    }, strict: true });
    const id = required(parsed.positionals[0], "memory ID or slug");
    const body = { ...(parsed.values.title !== undefined ? { title: parsed.values.title } : {}),
      ...(parsed.values.body !== undefined ? { body: parsed.values.body } : {}),
      ...(parsed.values.summary !== undefined ? { summary: parsed.values.summary } : {}),
      ...(parsed.values.kind !== undefined ? { kind: parsed.values.kind } : {}),
      ...(parsed.values.tags !== undefined ? { tags: parsed.values.tags.split(",").filter(Boolean) } : {}),
      ...(parsed.values.aliases !== undefined ? { aliases: parsed.values.aliases.split(",").filter(Boolean) } : {}),
      ...(parsed.values["clear-project"] ? { project: null } : parsed.values.project !== undefined ? { project: parsed.values.project } : {}),
      expectedRevision: numberOption(required(parsed.values.revision, "--revision"), "revision") };
    return printJson(await client.request(`/api/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }));
  }
  if (action === "archive") {
    const parsed = parseArgs({ args, allowPositionals: true, options: { revision: { type: "string" } }, strict: true });
    const id = required(parsed.positionals[0], "memory ID or slug");
    return printJson(await client.request(`/api/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived", expectedRevision: numberOption(required(parsed.values.revision, "--revision"), "revision") }),
    }));
  }
  if (action === "history") {
    const id = required(args[0], "memory ID or slug");
    return printJson(await client.request(`/api/memories/${encodeURIComponent(id)}/revisions`));
  }
  if (action === "export") {
    const parsed = parseArgs({ args, options: {
      output: { type: "string" }, all: { type: "boolean" },
    }, strict: true });
    const outputRoot = resolve(required(parsed.values.output, "--output"));
    const suffix = parsed.values.all ? "?includeArchived=true" : "";
    const bundle = MemoryMarkdownExportSchema.parse(await client.request(`/api/memories/export${suffix}`));
    mkdirSync(outputRoot, { recursive: true });
    for (const file of bundle.files) {
      const target = resolve(outputRoot, file.path);
      const targetRelative = relative(outputRoot, target);
      if (targetRelative.startsWith("..") || targetRelative === "" || targetRelative.includes(`..${sep}`)) {
        throw new Error(`Unsafe export path: ${file.path}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    writeFileSync(resolve(outputRoot, "manifest.json"), `${JSON.stringify({
      formatVersion: bundle.formatVersion,
      exportedAt: bundle.exportedAt,
      files: bundle.files.map((file) => ({ path: file.path })),
    }, null, 2)}\n`, "utf8");
    return printJson({ output: outputRoot, exportedAt: bundle.exportedAt, files: bundle.files.length });
  }
  if (action === "import") {
    const parsed = parseArgs({ args, allowPositionals: true, options: {
      apply: { type: "boolean" },
    }, strict: true });
    const files = markdownFiles(required(parsed.positionals[0], "Markdown file or export directory"));
    if (files.length === 0) throw new Error("No Markdown files were found");
    const path = parsed.values.apply ? "/api/memories/import" : "/api/memories/import/preview";
    return printJson(await client.request(path, { method: "POST", body: JSON.stringify({ files }) }));
  }
  help();
}

async function scheduleCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") return printJson(await client.request("/api/schedules"));
  if (action === "create") {
    const parsed = parseArgs({ args, allowPositionals: true, options: {
      "trigger-kind": { type: "string" }, trigger: { type: "string" },
      "action-kind": { type: "string" }, action: { type: "string" },
    }, strict: true });
    return printJson(await client.request("/api/schedules", { method: "POST", body: JSON.stringify({
      name: required(parsed.positionals[0], "schedule name"),
      triggerKind: required(parsed.values["trigger-kind"], "--trigger-kind"),
      trigger: JSON.parse(required(parsed.values.trigger, "--trigger")),
      actionKind: required(parsed.values["action-kind"], "--action-kind"),
      action: JSON.parse(required(parsed.values.action, "--action")),
    }) }));
  }
  if (action === "enable" || action === "disable") {
    const id = required(args[0], "schedule ID");
    return printJson(await client.request(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: action === "enable" }) }));
  }
  help();
}

async function notificationCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") {
    const parsed = parseArgs({ args, options: { all: { type: "boolean" } }, strict: true });
    return printJson(await client.request(`/api/notifications${parsed.values.all ? "?includeRead=true" : ""}`));
  }
  if (action === "read") {
    await client.request(`/api/notifications/${required(args[0], "notification ID")}/read`, { method: "POST" });
    return printJson({ ok: true });
  }
  help();
}

async function abilityCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "list") return printJson(await client.request("/api/abilities"));
  if (action === "install") {
    const manifest = JSON.parse(readFileSync(required(args[0], "manifest file"), "utf8"));
    return printJson(await client.request("/api/abilities", { method: "POST", body: JSON.stringify(manifest) }));
  }
  if (action === "invoke") {
    const id = required(args.shift(), "ability ID");
    const input = args[0] ? JSON.parse(args[0]) : {};
    return printJson(await client.request(`/api/abilities/${id}/invoke`, { method: "POST", body: JSON.stringify({ input }) }));
  }
  help();
}

async function browserCommand(args: string[]): Promise<void> {
  const adapterName = args.shift();
  const action = args.shift();
  let adapter: "google_calendar" | "slack";
  let browserAction: string;
  let input: Record<string, unknown> = {};
  if (adapterName === "calendar" && action === "list") { adapter = "google_calendar"; browserAction = "list_visible_events"; }
  else if (adapterName === "calendar" && action === "create") { adapter = "google_calendar"; browserAction = "create_event"; input = JSON.parse(required(args[0], "event JSON")); }
  else if (adapterName === "slack" && action === "unreads") { adapter = "slack"; browserAction = "list_unreads"; }
  else if (adapterName === "slack" && action === "read") { adapter = "slack"; browserAction = "read_channel"; input = { channelName: required(args[0], "channel") }; }
  else if (adapterName === "slack" && action === "send") { adapter = "slack"; browserAction = "send_message"; input = { channelName: required(args[0], "channel"), text: required(args[1], "message") }; }
  else help();
  return printJson(await client.request("/api/browser/jobs", { method: "POST", body: JSON.stringify({ adapter, action: browserAction, input }) }));
}

async function nativeCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "clipboard-image") {
    const parsed = parseArgs({ args, options: { output: { type: "string" } }, strict: true });
    const output = required(parsed.values.output, "--output");
    const payload = await client.request("/api/native/clipboard/image") as { image: { base64: string; mimeType: string } };
    writeFileSync(output, Buffer.from(payload.image.base64, "base64"));
    return printJson({ output, mimeType: payload.image.mimeType });
  }
  if (action === "notify") {
    await client.request("/api/native/notify", { method: "POST", body: JSON.stringify({ title: required(args[0], "title"), body: args[1] ?? "" }) });
    return printJson({ ok: true });
  }
  help();
}

async function main(): Promise<void> {
  const command = rawArgs.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") help();
  if (command === "task") return taskCommand(rawArgs);
  if (command === "session") return sessionCommand(rawArgs);
  if (command === "event") return eventCommand(rawArgs);
  if (command === "run") return runCommand(rawArgs);
  if (command === "approval") return approvalCommand(rawArgs);
  if (command === "memory") return memoryCommand(rawArgs);
  if (command === "schedule") return scheduleCommand(rawArgs);
  if (command === "notification") return notificationCommand(rawArgs);
  if (command === "ability") return abilityCommand(rawArgs);
  if (command === "browser") return browserCommand(rawArgs);
  if (command === "native") return nativeCommand(rawArgs);

  if (command === "status") {
    const [health, tasks, sessions, runs, approvals] = await Promise.all([
      client.request("/api/health"),
      client.request("/api/tasks"),
      client.request("/api/sessions"),
      client.request("/api/runs"),
      client.request("/api/approvals?status=pending"),
    ]);
    const value = {
      health,
      tasks: (tasks as { tasks: unknown[] }).tasks.length,
      sessions: (sessions as { sessions: unknown[] }).sessions.length,
      runs: (runs as { runs: unknown[] }).runs.length,
      pendingApprovals: (approvals as { approvals: unknown[] }).approvals.length,
    };
    return printJson(value);
  }

  if (command === "state" && rawArgs.shift() === "export") {
    const [tasks, sessions, runs, approvals, events] = await Promise.all([
      client.request("/api/tasks"),
      client.request("/api/sessions?includeEnded=true"),
      client.request("/api/runs"),
      client.request("/api/approvals"),
      client.request("/api/events?after=0&limit=500"),
    ]);
    return printJson({ exportedAt: new Date().toISOString(), tasks, sessions, runs, approvals, events });
  }

  if (command === "api") {
    const method = required(rawArgs.shift(), "HTTP method").toUpperCase();
    const path = required(rawArgs.shift(), "API path");
    const bodyText = rawArgs.shift();
    const body = bodyText === undefined ? undefined : JSON.stringify(JSON.parse(bodyText));
    return printJson(await client.request(path, { method, ...(body ? { body } : {}) }));
  }

  help();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
