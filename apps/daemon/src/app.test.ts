import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { DaemonConfig } from "./config.js";

const databasePath = join(tmpdir(), `cc-assistant-test-${randomUUID()}.sqlite`);

function config(): DaemonConfig {
  return {
    host: "127.0.0.1",
    port: 4317,
    dataDir: ".",
    databasePath,
    accessToken: "test-token-with-at-least-thirty-two-characters",
    accessTokenPath: "unused",
    allowedRoots: ["/tmp"],
  };
}

describe("daemon API", () => {
  it("requires authentication and supports the task lifecycle", async () => {
    const app = await buildApp({ config: config() });

    const unauthorized = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(unauthorized.statusCode).toBe(401);

    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { token: config().accessToken },
    });
    expect(session.statusCode).toBe(204);
    const cookie = session.headers["set-cookie"];
    expect(cookie).toBeTypeOf("string");

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: cookie as string },
      payload: { title: "First integrated task" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().task.title).toBe("First integrated task");

    const listed = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { cookie: cookie as string },
    });
    expect(listed.json().tasks).toHaveLength(1);

    const hook = await app.inject({
      method: "POST",
      url: "/api/hooks/claude",
      headers: { cookie: cookie as string },
      payload: {
        session_id: "session-test-1",
        transcript_path: "/tmp/session-test-1.jsonl",
        cwd: "/tmp/project",
        hook_event_name: "SessionStart",
        source: "startup",
        model: "claude-test",
      },
    });
    expect(hook.statusCode).toBe(200);
    expect(hook.json().session.status).toBe("idle");

    const sessions = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: cookie as string },
    });
    expect(sessions.json().sessions).toMatchObject([
      { id: "session-test-1", status: "idle", model: "claude-test" },
    ]);

    const proposed = await app.inject({
      method: "POST",
      url: "/api/runs/command",
      headers: { cookie: cookie as string },
      payload: {
        title: "Safe test command",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('hello from command')"],
        cwd: "/tmp",
      },
    });
    expect(proposed.statusCode).toBe(202);
    expect(proposed.json().run.status).toBe("waiting_approval");

    const approved = await app.inject({
      method: "POST",
      url: `/api/approvals/${proposed.json().approval.id}/resolve`,
      headers: { cookie: cookie as string },
      payload: { decision: "approved" },
    });
    expect(approved.statusCode).toBe(200);

    let commandStatus = "running";
    for (let attempt = 0; attempt < 50 && commandStatus === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await app.inject({
        method: "GET",
        url: `/api/runs/${proposed.json().run.id}`,
        headers: { cookie: cookie as string },
      });
      commandStatus = response.json().run.status as string;
    }
    expect(commandStatus).toBe("succeeded");

    const logs = await app.inject({
      method: "GET",
      url: `/api/runs/${proposed.json().run.id}/logs`,
      headers: { cookie: cookie as string },
    });
    expect(logs.json().logs.map((log: { message: string }) => log.message).join("\n")).toContain("Starting node");

    const browserProposal = await app.inject({
      method: "POST",
      url: "/api/browser/jobs",
      headers: { cookie: cookie as string },
      payload: { adapter: "slack", action: "send_message", input: { channelName: "test", text: "Hello" } },
    });
    expect(browserProposal.json().run.status).toBe("waiting_approval");
    const browserApproved = await app.inject({
      method: "POST",
      url: `/api/approvals/${browserProposal.json().approval.id}/resolve`,
      headers: { cookie: cookie as string },
      payload: { decision: "approved" },
    });
    expect(browserApproved.statusCode).toBe(200);
    const claimed = await app.inject({
      method: "GET",
      url: "/api/browser/jobs/claim",
      headers: { cookie: cookie as string },
    });
    expect(claimed.json().job.action).toBe("send_message");
    await app.inject({
      method: "POST",
      url: `/api/browser/jobs/${claimed.json().job.id}/complete`,
      headers: { cookie: cookie as string },
      payload: { result: { sent: true } },
    });
    const browserRun = await app.inject({
      method: "GET",
      url: `/api/runs/${browserProposal.json().run.id}`,
      headers: { cookie: cookie as string },
    });
    expect(browserRun.json().run.status).toBe("succeeded");

    const reminder = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { cookie: cookie as string },
      payload: {
        name: "Integration reminder",
        triggerKind: "at",
        trigger: { at: new Date(Date.now() - 1_000).toISOString() },
        actionKind: "reminder",
        action: { title: "Reminder fired", body: "durably" },
      },
    });
    expect(reminder.statusCode).toBe(201);
    let notificationCount = 0;
    for (let attempt = 0; attempt < 30 && notificationCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const notifications = await app.inject({
        method: "GET",
        url: "/api/notifications",
        headers: { cookie: cookie as string },
      });
      notificationCount = notifications.json().notifications.length as number;
    }
    expect(notificationCount).toBe(1);

    await app.close();
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
  });

  it("exposes revision-safe linked memory through the authenticated API", async () => {
    const memoryDatabasePath = join(tmpdir(), `cc-assistant-memory-api-${randomUUID()}.sqlite`);
    const memoryConfig = { ...config(), databasePath: memoryDatabasePath };
    const app = await buildApp({ config: memoryConfig });
    const headers = {
      authorization: `Bearer ${memoryConfig.accessToken}`,
      "x-cc-assistant-source": "mcp",
    };

    const ingested = await app.inject({
      method: "POST", url: "/api/memories/ingest", headers,
      payload: {
        title: "Release Handbook",
        body: "Follow [[Project Orchid|the project plan]].",
        aliases: ["shipping guide"], tags: ["Deployments"],
        provenance: { sourceType: "conversation", sourceRef: "session-42" },
      },
    });
    expect(ingested.statusCode).toBe(201);
    expect(ingested.json()).toMatchObject({
      memory: { slug: "release-handbook", revision: 1, tags: ["deployments"] },
      outgoingLinks: [{ slug: "project-orchid", resolvedMemoryId: null }],
    });

    const target = await app.inject({
      method: "POST", url: "/api/memories", headers,
      payload: { title: "Project Orchid", body: "The current plan." },
    });
    expect(target.statusCode).toBe(201);
    expect(target.json().backlinks).toMatchObject([{ slug: "release-handbook" }]);

    const recalled = await app.inject({
      method: "GET", url: "/api/memories/recall?q=shipping%20guide", headers,
    });
    expect(recalled.statusCode).toBe(200);
    expect(recalled.json().memories).toMatchObject([{ slug: "release-handbook" }]);

    const conflict = await app.inject({
      method: "PATCH", url: "/api/memories/release-handbook", headers,
      payload: { body: "A stale edit", expectedRevision: 2 },
    });
    expect(conflict.statusCode).toBe(409);

    const edited = await app.inject({
      method: "PATCH", url: "/api/memories/release-handbook", headers,
      payload: { body: "Updated. See [[Project Orchid]].", expectedRevision: 1 },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().memory.revision).toBe(2);

    const history = await app.inject({
      method: "GET", url: "/api/memories/release-handbook/revisions", headers,
    });
    expect(history.json().revisions.map((revision: { revision: number }) => revision.revision)).toEqual([2, 1]);

    const events = await app.inject({ method: "GET", url: "/api/events", headers });
    expect(events.json().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "memory.ingested", source: "mcp" }),
      expect.objectContaining({ type: "memory.updated", source: "mcp" }),
    ]));

    await app.close();
    rmSync(memoryDatabasePath, { force: true });
    rmSync(`${memoryDatabasePath}-shm`, { force: true });
    rmSync(`${memoryDatabasePath}-wal`, { force: true });
  });
});
