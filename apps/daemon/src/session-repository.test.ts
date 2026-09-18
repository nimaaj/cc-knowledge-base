import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRepository } from "./session-repository.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRepository(): SessionRepository {
  const directory = mkdtempSync(join(tmpdir(), "cc-assistant-session-test-"));
  cleanup.push(directory);
  return new SessionRepository(join(directory, "assistant.sqlite"));
}

describe("SessionRepository", () => {
  it("maps lifecycle hooks into current session state", () => {
    const repository = createRepository();
    const base = {
      session_id: "session-123",
      cwd: "/work/project",
      transcript_path: "/tmp/session-123.jsonl",
    };

    expect(repository.ingest({ ...base, hook_event_name: "SessionStart", model: "claude" }).status)
      .toBe("idle");
    expect(repository.ingest({ ...base, hook_event_name: "UserPromptSubmit" }).status).toBe(
      "working",
    );
    expect(
      repository.ingest({
        ...base,
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
      }).status,
    ).toBe("waiting");
    expect(repository.ingest({ ...base, hook_event_name: "SessionEnd", reason: "other" }).status)
      .toBe("ended");
    expect(repository.list()).toEqual([]);
    expect(repository.list(true)).toHaveLength(1);
    repository.close();
  });
});
