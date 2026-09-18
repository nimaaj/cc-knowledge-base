import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RevisionConflictError, TaskRepository } from "./task-repository.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRepository(): TaskRepository {
  const directory = mkdtempSync(join(tmpdir(), "cc-assistant-test-"));
  cleanup.push(directory);
  return new TaskRepository(join(directory, "assistant.sqlite"));
}

describe("TaskRepository", () => {
  it("creates, updates, and audits a task", () => {
    const repository = createRepository();
    const created = repository.create({ title: "Build the daemon", project: "assistant" }, "test");

    expect(repository.list()).toEqual([created]);
    expect(created.status).toBe("inbox");

    const updated = repository.update(
      created.id,
      { status: "active", expectedRevision: created.revision },
      "test",
    );
    expect(updated.status).toBe("active");
    expect(updated.revision).toBe(2);
    expect(repository.listEvents().map((event) => event.type)).toEqual([
      "task.created",
      "task.updated",
    ]);
    repository.close();
  });

  it("rejects stale revisions", () => {
    const repository = createRepository();
    const task = repository.create({ title: "Keep state safe" });
    repository.update(task.id, { title: "Keep state safer", expectedRevision: 1 });

    expect(() => repository.update(task.id, { status: "done", expectedRevision: 1 })).toThrow(
      RevisionConflictError,
    );
    repository.close();
  });
});
