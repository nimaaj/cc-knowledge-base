import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ApprovalSchema,
  AssistantEventSchema,
  RunLogSchema,
  RunSchema,
  type Approval,
  type AssistantEvent,
  type Run,
  type RunKind,
  type RunLog,
  type RunStatus,
} from "@cc-assistant/shared";

interface RunRow {
  id: string;
  task_id: string | null;
  kind: string;
  status: string;
  title: string;
  prompt: string | null;
  cwd: string;
  session_id: string | null;
  result: string | null;
  error: string | null;
  metadata_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  revision: number;
}

interface RunLogRow {
  id: number;
  run_id: string;
  sequence: number;
  level: string;
  message: string;
  data_json: string | null;
  occurred_at: string;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  action_type: string;
  summary: string;
  payload_json: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

interface EventRow {
  id: number;
  type: string;
  source: string;
  occurred_at: string;
  entity_type: string | null;
  entity_id: string | null;
  payload_json: string;
}

function mapRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    prompt: row.prompt,
    cwd: row.cwd,
    sessionId: row.session_id,
    result: row.result,
    error: row.error,
    metadata: JSON.parse(row.metadata_json) as unknown,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    revision: row.revision,
  });
}

function mapLog(row: RunLogRow): RunLog {
  return RunLogSchema.parse({
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    level: row.level,
    message: row.message,
    data: row.data_json ? (JSON.parse(row.data_json) as unknown) : null,
    occurredAt: row.occurred_at,
  });
}

function mapApproval(row: ApprovalRow): Approval {
  return ApprovalSchema.parse({
    id: row.id,
    runId: row.run_id,
    actionType: row.action_type,
    summary: row.summary,
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
  });
}

function mapEvent(row: EventRow): AssistantEvent {
  return AssistantEventSchema.parse({
    id: row.id,
    type: row.type,
    source: row.source,
    occurredAt: row.occurred_at,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: JSON.parse(row.payload_json) as unknown,
  });
}

export class ExecutionRepository {
  readonly #db: DatabaseSync;
  readonly #onEvent: ((event: AssistantEvent) => void) | undefined;

  constructor(databasePath: string, onEvent?: (event: AssistantEvent) => void) {
    this.#db = new DatabaseSync(databasePath);
    this.#onEvent = onEvent;
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'command', 'browser')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
        title TEXT NOT NULL,
        prompt TEXT,
        cwd TEXT NOT NULL,
        session_id TEXT,
        result TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS runs_status_created_idx ON runs(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
        message TEXT NOT NULL,
        data_json TEXT,
        occurred_at TEXT NOT NULL,
        UNIQUE(run_id, sequence),
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_note TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS approvals_status_created_idx
      ON approvals(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        payload_json TEXT NOT NULL
      );
    `);
    const restartedAt = new Date().toISOString();
    this.#db.prepare(`UPDATE runs SET status='failed', error='Daemon restarted before the run completed',
      completed_at=?, revision=revision+1 WHERE status='running' OR
      (kind='agent' AND status IN ('queued','waiting_approval'))`).run(restartedAt);
    this.#db.prepare(`UPDATE approvals SET status='expired', resolved_at=?,
      resolution_note='Owning agent run ended during daemon restart' WHERE status='pending' AND run_id IN
      (SELECT id FROM runs WHERE kind='agent' AND status='failed')`).run(restartedAt);
  }

  close(): void {
    this.#db.close();
  }

  createRun(input: {
    taskId?: string | null;
    kind: RunKind;
    status?: RunStatus;
    title: string;
    prompt?: string | null;
    cwd: string;
    metadata?: Record<string, unknown>;
  }): Run {
    const now = new Date().toISOString();
    const run = RunSchema.parse({
      id: randomUUID(),
      taskId: input.taskId ?? null,
      kind: input.kind,
      status: input.status ?? "queued",
      title: input.title,
      prompt: input.prompt ?? null,
      cwd: input.cwd,
      sessionId: null,
      result: null,
      error: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      startedAt: null,
      completedAt: null,
      revision: 1,
    });
    this.#db
      .prepare(`
        INSERT INTO runs (
          id, task_id, kind, status, title, prompt, cwd, session_id, result, error,
          metadata_json, created_at, started_at, completed_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.taskId,
        run.kind,
        run.status,
        run.title,
        run.prompt,
        run.cwd,
        run.sessionId,
        run.result,
        run.error,
        JSON.stringify(run.metadata),
        run.createdAt,
        run.startedAt,
        run.completedAt,
        run.revision,
      );
    this.#event("run.created", "run", run.id, { run });
    return run;
  }

  getRun(id: string): Run | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? mapRun(row as unknown as RunRow) : undefined;
  }

  listRuns(status?: RunStatus): Run[] {
    const rows = status
      ? this.#db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.#db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all();
    return (rows as unknown as RunRow[]).map(mapRun);
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<Run, "status" | "cwd" | "sessionId" | "result" | "error" | "metadata" | "startedAt" | "completedAt">
    >,
  ): Run {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run ${id} was not found`);
    const updated = RunSchema.parse({ ...current, ...patch, revision: current.revision + 1 });
    this.#db
      .prepare(`
        UPDATE runs SET status = ?, cwd = ?, session_id = ?, result = ?, error = ?, metadata_json = ?,
          started_at = ?, completed_at = ?, revision = ? WHERE id = ?
      `)
      .run(
        updated.status,
        updated.cwd,
        updated.sessionId,
        updated.result,
        updated.error,
        JSON.stringify(updated.metadata),
        updated.startedAt,
        updated.completedAt,
        updated.revision,
        id,
      );
    this.#event("run.updated", "run", id, { run: updated });
    return updated;
  }

  appendLog(
    runId: string,
    level: RunLog["level"],
    message: string,
    data: unknown = null,
  ): RunLog {
    const next = this.#db
      .prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_logs WHERE run_id = ?")
      .get(runId) as unknown as { sequence: number };
    const occurredAt = new Date().toISOString();
    const result = this.#db
      .prepare(`
        INSERT INTO run_logs (run_id, sequence, level, message, data_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(runId, next.sequence, level, message, data === null ? null : JSON.stringify(data), occurredAt);
    const row = this.#db.prepare("SELECT * FROM run_logs WHERE id = ?").get(result.lastInsertRowid);
    if (!row) throw new Error("Failed to read run log");
    const log = mapLog(row as unknown as RunLogRow);
    this.#event("run.log", "run", runId, { log });
    return log;
  }

  listLogs(runId: string, afterSequence = -1, limit = 500): RunLog[] {
    const rows = this.#db
      .prepare(`
        SELECT * FROM run_logs WHERE run_id = ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?
      `)
      .all(runId, afterSequence, Math.min(Math.max(limit, 1), 2_000));
    return (rows as unknown as RunLogRow[]).map(mapLog);
  }

  createApproval(input: {
    runId: string;
    actionType: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Approval {
    const approval = ApprovalSchema.parse({
      id: randomUUID(),
      runId: input.runId,
      actionType: input.actionType,
      summary: input.summary,
      payload: input.payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolutionNote: null,
    });
    this.#db
      .prepare(`
        INSERT INTO approvals (
          id, run_id, action_type, summary, payload_json, status,
          created_at, resolved_at, resolution_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.runId,
        approval.actionType,
        approval.summary,
        JSON.stringify(approval.payload),
        approval.status,
        approval.createdAt,
        approval.resolvedAt,
        approval.resolutionNote,
      );
    this.#event("approval.created", "approval", approval.id, { approval });
    return approval;
  }

  getApproval(id: string): Approval | undefined {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? mapApproval(row as unknown as ApprovalRow) : undefined;
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    const rows = status
      ? this.#db
          .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC")
          .all(status)
      : this.#db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all();
    return (rows as unknown as ApprovalRow[]).map(mapApproval);
  }

  resolveApproval(id: string, decision: "approved" | "denied", note?: string | null): Approval {
    const current = this.getApproval(id);
    if (!current) throw new Error(`Approval ${id} was not found`);
    if (current.status !== "pending") throw new Error(`Approval ${id} is already ${current.status}`);
    const resolvedAt = new Date().toISOString();
    this.#db
      .prepare(`
        UPDATE approvals SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ?
      `)
      .run(decision, resolvedAt, note ?? null, id);
    const approval = this.getApproval(id);
    if (!approval) throw new Error(`Approval ${id} disappeared after update`);
    this.#event("approval.resolved", "approval", id, { approval });
    return approval;
  }

  #event(type: string, entityType: string, entityId: string, payload: Record<string, unknown>): void {
    const occurredAt = new Date().toISOString();
    const result = this.#db
      .prepare(`
        INSERT INTO events (type, source, occurred_at, entity_type, entity_id, payload_json)
        VALUES (?, 'daemon', ?, ?, ?, ?)
      `)
      .run(type, occurredAt, entityType, entityId, JSON.stringify(payload));
    const row = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(result.lastInsertRowid);
    if (!row) throw new Error("Failed to read execution event");
    this.#onEvent?.(mapEvent(row as unknown as EventRow));
  }
}
