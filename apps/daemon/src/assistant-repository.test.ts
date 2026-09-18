import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantRepository } from "./assistant-repository.js";

const paths: string[] = [];

function repository(): AssistantRepository {
  const path = join(tmpdir(), `cc-assistant-state-${randomUUID()}.sqlite`);
  paths.push(path);
  return new AssistantRepository(path);
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
});

describe("assistant repository", () => {
  it("persists schedules, abilities, notifications, and browser jobs", () => {
    const store = repository();
    const schedule = store.createSchedule({
      name: "Stand up",
      triggerKind: "interval",
      trigger: { everyMs: 60_000 },
      actionKind: "reminder",
      action: { title: "Move", body: "Stand and stretch" },
    });
    expect(schedule.nextRunAt).not.toBeNull();
    expect(store.listSchedules()).toHaveLength(1);

    store.installAbility({
      manifestVersion: 1,
      id: "say-hello",
      name: "Say hello",
      description: "Print a greeting",
      inputSchema: { type: "object" },
      execution: { kind: "command", executable: "printf", args: ["Hello ${input.name}"] },
    });
    expect(store.getAbility("say-hello")?.name).toBe("Say hello");

    store.createNotification("Test", "Body", "test");
    expect(store.listNotifications()).toHaveLength(1);

    const job = store.createBrowserJob("slack", "list_unreads", {});
    expect(store.claimBrowserJob()?.id).toBe(job.id);
    expect(store.completeBrowserJob(job.id, { count: 2 }).status).toBe("succeeded");
    store.close();
  });
});
