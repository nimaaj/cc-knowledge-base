import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "./config.js";
import { ExecutionRepository } from "./execution-repository.js";
import { ExecutionService, type AgentQuery } from "./execution-service.js";
import { TaskRepository } from "./task-repository.js";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
});

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("execution service", () => {
  it("parks a managed Claude tool request until its approval is resolved", async () => {
    const databasePath = join(tmpdir(), `cc-assistant-execution-${randomUUID()}.sqlite`);
    paths.push(databasePath);
    new TaskRepository(databasePath).close();
    const repository = new ExecutionRepository(databasePath);
    let permissionResult: PermissionResult | null | undefined;
    const fakeQuery: AgentQuery = (params) => {
      const iterator = (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "fake-session" } as SDKMessage;
        const callback = params.options?.canUseTool;
        if (!callback) throw new Error("Expected permission callback");
        permissionResult = await callback("Write", { file_path: "/tmp/example.txt" }, {
          signal: new AbortController().signal,
          title: "Write /tmp/example.txt",
          toolUseID: "tool-1",
          requestId: "request-1",
        });
        yield {
          type: "result", subtype: "success", is_error: false, session_id: "fake-session",
          result: "Finished", total_cost_usd: 0.01, num_turns: 1,
        } as SDKMessage;
      })();
      return Object.assign(iterator, { close() {} });
    };
    const config: DaemonConfig = {
      host: "127.0.0.1", port: 4317, dataDir: tmpdir(), databasePath,
      accessToken: "test-token-with-at-least-thirty-two-characters", accessTokenPath: "unused",
      allowedRoots: [tmpdir()],
    };
    const service = new ExecutionService(repository, config, fakeQuery);
    const run = service.startAgent({ title: "Fake agent", prompt: "Do a thing", cwd: tmpdir() });

    await until(() => repository.listApprovals("pending").length === 1, "Approval was not created");
    expect(repository.getRun(run.id)?.status).toBe("waiting_approval");
    const approval = repository.listApprovals("pending")[0];
    if (!approval) throw new Error("Expected pending approval");
    service.resolveApproval(approval.id, { decision: "approved" });

    await until(() => repository.getRun(run.id)?.status === "succeeded", "Agent did not finish");
    expect(permissionResult).toMatchObject({ behavior: "allow", toolUseID: "tool-1" });
    expect(repository.getRun(run.id)).toMatchObject({ sessionId: "fake-session", result: "Finished" });
    repository.close();
  });
});
