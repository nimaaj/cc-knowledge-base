import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { query, type CanUseTool, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ProposeCommandSchema,
  ResolveApprovalSchema,
  StartAgentRunSchema,
  type Approval,
  type ProposeCommandInput,
  type Run,
  type StartAgentRunInput,
} from "@cc-assistant/shared";
import type { DaemonConfig } from "./config.js";
import { ExecutionRepository } from "./execution-repository.js";

export type AgentQuery = (params: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage> & { close(): void };

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
}

interface ActiveExecution {
  abort: AbortController;
  child?: ChildProcess;
  close?: () => void;
}

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_KEY|AUTH)/i;

function commandEnvironment(additions: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRET_ENV_NAME.test(name)));
  return { ...inherited, ...additions };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function textFromAssistantMessage(message: SDKMessage): string[] {
  if (message.type !== "assistant") return [];
  const blocks = message.message.content as unknown as Array<Record<string, unknown>>;
  return blocks.flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      return [`Using ${name}`];
    }
    return [];
  });
}

export class ExecutionService {
  readonly #repository: ExecutionRepository;
  readonly #config: DaemonConfig;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #agentQuery: AgentQuery;

  constructor(repository: ExecutionRepository, config: DaemonConfig, agentQuery: AgentQuery = query) {
    this.#repository = repository;
    this.#config = config;
    this.#agentQuery = agentQuery;
  }

  startAgent(rawInput: StartAgentRunInput): Run {
    const input = StartAgentRunSchema.parse(rawInput);
    const cwd = this.#allowedDirectory(input.cwd);
    const run = this.#repository.createRun({
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      kind: "agent",
      title: input.title,
      prompt: input.prompt,
      cwd,
      metadata: {
        model: input.model ?? null,
        effort: input.effort,
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd ?? null,
        useWorktree: input.useWorktree,
      },
    });
    void this.#runAgent(run, input);
    return run;
  }

  proposeCommand(rawInput: ProposeCommandInput): { run: Run; approval: Approval } {
    const input = ProposeCommandSchema.parse(rawInput);
    const cwd = this.#allowedDirectory(input.cwd);
    if (input.executable.includes("/") && !isAbsolute(input.executable)) {
      throw new Error("Executable paths must be absolute or resolved through PATH");
    }
    const forbidden = Object.keys(input.env).filter((name) => SECRET_ENV_NAME.test(name));
    if (forbidden.length > 0) {
      throw new Error(`Secret-like environment variables are not accepted: ${forbidden.join(", ")}`);
    }
    const run = this.#repository.createRun({
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      kind: "command",
      status: "waiting_approval",
      title: input.title,
      cwd,
      metadata: {
        executable: input.executable,
        args: input.args,
        timeoutMs: input.timeoutMs,
        env: input.env,
      },
    });
    const approval = this.#repository.createApproval({
      runId: run.id,
      actionType: "run_command",
      summary: `${basename(input.executable)} ${input.args.join(" ")}`.trim(),
      payload: {
        executable: input.executable,
        args: input.args,
        cwd,
        timeoutMs: input.timeoutMs,
        env: input.env,
      },
    });
    return { run, approval };
  }

  proposeBrowser(adapter: "google_calendar" | "slack", action: string, input: Record<string, unknown>): { run: Run; approval: Approval } {
    const cwd = this.#config.allowedRoots[0] ?? process.cwd();
    const run = this.#repository.createRun({
      kind: "browser", status: "waiting_approval", title: `${adapter}: ${action}`, cwd,
      metadata: { adapter, action, input },
    });
    const approval = this.#repository.createApproval({
      runId: run.id, actionType: "browser_action",
      summary: `${adapter.replace("_", " ")} wants to ${action.replaceAll("_", " ")}`,
      payload: { adapter, action, input },
    });
    return { run, approval };
  }

  updateExternalRun(runId: string, patch: Parameters<ExecutionRepository["updateRun"]>[1]): Run {
    return this.#repository.updateRun(runId, patch);
  }

  resolveApproval(id: string, rawInput: unknown): Approval {
    const input = ResolveApprovalSchema.parse(rawInput);
    const approval = this.#repository.resolveApproval(id, input.decision, input.note);
    const pending = this.#pendingPermissions.get(id);
    if (pending) {
      this.#pendingPermissions.delete(id);
      if (input.decision === "approved") pending.resolve({ behavior: "allow" });
      else pending.resolve({ behavior: "deny", message: input.note ?? "Denied by the user" });
      return approval;
    }

    const run = this.#repository.getRun(approval.runId);
    if (run?.kind === "command" && run.status === "waiting_approval") {
      if (input.decision === "approved") void this.#runCommand(run);
      else {
        this.#repository.updateRun(run.id, {
          status: "cancelled",
          error: input.note ?? "Command denied by the user",
          completedAt: new Date().toISOString(),
        });
      }
    }
    if (run?.kind === "browser" && run.status === "waiting_approval") {
      if (input.decision === "approved") {
        this.#repository.updateRun(run.id, { status: "queued", startedAt: new Date().toISOString() });
      } else {
        this.#repository.updateRun(run.id, { status: "cancelled", error: input.note ?? "Browser action denied", completedAt: new Date().toISOString() });
      }
    }
    return approval;
  }

  cancel(runId: string): Run {
    const run = this.#repository.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    const active = this.#active.get(runId);
    active?.abort.abort();
    active?.close?.();
    active?.child?.kill("SIGTERM");
    for (const [approvalId, pending] of this.#pendingPermissions) {
      const approval = this.#repository.getApproval(approvalId);
      if (approval?.runId === runId) {
        this.#pendingPermissions.delete(approvalId);
        pending.resolve({ behavior: "deny", message: "Run cancelled", interrupt: true });
      }
    }
    this.#active.delete(runId);
    return this.#repository.updateRun(runId, {
      status: "cancelled",
      error: "Cancelled by the user",
      completedAt: new Date().toISOString(),
    });
  }

  shutdown(): void {
    for (const runId of this.#active.keys()) this.cancel(runId);
  }

  #allowedDirectory(rawPath: string): string {
    const candidate = realpathSync(resolve(rawPath));
    const roots = this.#config.allowedRoots.map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return resolve(root);
      }
    });
    if (!roots.some((root) => isWithin(candidate, root))) {
      throw new Error(`Working directory is outside allowed roots: ${candidate}`);
    }
    return candidate;
  }

  async #runCommand(run: Run): Promise<void> {
    const executable = String(run.metadata.executable);
    const args = Array.isArray(run.metadata.args) ? run.metadata.args.map(String) : [];
    const timeoutMs = Number(run.metadata.timeoutMs ?? 120_000);
    const requestedEnv = (run.metadata.env ?? {}) as Record<string, string>;
    const abort = new AbortController();
    this.#active.set(run.id, { abort });
    this.#repository.updateRun(run.id, { status: "running", startedAt: new Date().toISOString() });
    this.#repository.appendLog(run.id, "info", `Starting ${basename(executable)}`, { args });

    try {
      await new Promise<void>((resolvePromise, reject) => {
        let stdout = "";
        let stderr = "";
        const child = spawn(executable, args, {
          cwd: run.cwd,
          env: commandEnvironment(requestedEnv),
          shell: false,
          signal: abort.signal,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const active = this.#active.get(run.id);
        if (active) active.child = child;
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
          stdout = `${stdout}${chunk}`.slice(-2_000_000);
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
          stderr = `${stderr}${chunk}`.slice(-2_000_000);
        });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          if (stdout) this.#repository.appendLog(run.id, "info", stdout);
          if (stderr) this.#repository.appendLog(run.id, "warning", stderr);
          if (code === 0) resolvePromise();
          else reject(new Error(`Command exited with code ${code ?? "null"} (${signal ?? "no signal"})`));
        });
      });
      this.#repository.updateRun(run.id, {
        status: "succeeded",
        result: "Command completed successfully",
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const latest = this.#repository.getRun(run.id);
      if (latest?.status !== "cancelled") {
        this.#repository.appendLog(run.id, "error", errorMessage(error));
        this.#repository.updateRun(run.id, {
          status: "failed",
          error: errorMessage(error),
          completedAt: new Date().toISOString(),
        });
      }
    } finally {
      this.#active.delete(run.id);
    }
  }

  async #runAgent(initialRun: Run, input: ReturnType<typeof StartAgentRunSchema.parse>): Promise<void> {
    let run = initialRun;
    const abort = new AbortController();
    this.#active.set(run.id, { abort });
    try {
      if (input.useWorktree) {
        const worktree = await this.#prepareWorktree(run);
        run = this.#repository.updateRun(run.id, {
          cwd: worktree.path,
          metadata: { ...run.metadata, worktreePath: worktree.path, worktreeBranch: worktree.branch },
        });
      }
      this.#repository.updateRun(run.id, { status: "running", startedAt: new Date().toISOString() });
      this.#repository.appendLog(run.id, "info", "Starting managed Claude run");

      const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
        const approval = this.#repository.createApproval({
          runId: run.id,
          actionType: "claude_tool",
          summary: options.title ?? options.description ?? `${toolName} requested`,
          payload: {
            toolName,
            input: toolInput,
            toolUseId: options.toolUseID,
            blockedPath: options.blockedPath ?? null,
            reason: options.decisionReason ?? null,
          },
        });
        this.#repository.updateRun(run.id, { status: "waiting_approval" });
        return await new Promise<PermissionResult>((resolvePermission, reject) => {
          const onAbort = (): void => {
            this.#pendingPermissions.delete(approval.id);
            reject(new Error("Claude run was cancelled"));
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
          this.#pendingPermissions.set(approval.id, {
            resolve: (result) => {
              options.signal.removeEventListener("abort", onAbort);
              this.#repository.updateRun(run.id, { status: "running" });
              resolvePermission({ ...result, toolUseID: options.toolUseID });
            },
            reject,
          });
        });
      };

      const stream = this.#agentQuery({
        prompt: input.prompt,
        options: {
          cwd: run.cwd,
          abortController: abort,
          canUseTool,
          permissionMode: "default",
          settingSources: ["user", "project", "local"],
          tools: { type: "preset", preset: "claude_code" },
          effort: input.effort,
          maxTurns: input.maxTurns,
          ...(input.model ? { model: input.model } : {}),
          ...(input.maxBudgetUsd ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
        },
      });
      const active = this.#active.get(run.id);
      if (active) active.close = () => stream.close();

      for await (const message of stream) {
        if ("session_id" in message && typeof message.session_id === "string") {
          const latest = this.#repository.getRun(run.id);
          if (latest && latest.sessionId !== message.session_id) {
            this.#repository.updateRun(run.id, { sessionId: message.session_id });
          }
        }
        for (const text of textFromAssistantMessage(message)) {
          this.#repository.appendLog(run.id, "info", text.slice(0, 50_000));
        }
        if (message.type === "result") {
          if (message.subtype === "success" && !message.is_error) {
            this.#repository.updateRun(run.id, {
              status: "succeeded",
              result: message.result,
              metadata: {
                ...(this.#repository.getRun(run.id)?.metadata ?? run.metadata),
                totalCostUsd: message.total_cost_usd,
                numTurns: message.num_turns,
              },
              completedAt: new Date().toISOString(),
            });
          } else {
            const detail = message.subtype === "success" ? message.result : message.errors.join("; ");
            throw new Error(detail || message.subtype);
          }
        }
      }
    } catch (error) {
      const latest = this.#repository.getRun(run.id);
      if (latest?.status !== "cancelled") {
        this.#repository.appendLog(run.id, "error", errorMessage(error));
        this.#repository.updateRun(run.id, {
          status: "failed",
          error: errorMessage(error),
          completedAt: new Date().toISOString(),
        });
      }
    } finally {
      this.#active.delete(run.id);
    }
  }

  async #prepareWorktree(run: Run): Promise<{ path: string; branch: string }> {
    const path = join(this.#config.dataDir, "worktrees", run.id);
    const branch = `cc-assistant/${run.id.slice(0, 8)}`;
    mkdirSync(join(this.#config.dataDir, "worktrees"), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("git", ["worktree", "add", "-b", branch, path, "HEAD"], {
        cwd: run.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`Could not create git worktree: ${stderr.trim() || `exit ${code}`}`));
      });
    });
    return { path, branch };
  }
}
