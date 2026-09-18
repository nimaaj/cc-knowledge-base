import { DatabaseSync } from "node:sqlite";
import {
  AssistantEventSchema,
  ClaudeHookInputSchema,
  ClaudeSessionSchema,
  type AssistantEvent,
  type ClaudeHookInput,
  type ClaudeSession,
  type SessionStatus,
} from "@cc-assistant/shared";

interface SessionRow {
  id: string;
  cwd: string;
  transcript_path: string | null;
  model: string | null;
  agent_type: string | null;
  permission_mode: string | null;
  status: string;
  last_event: string;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
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

function mapSession(row: SessionRow): ClaudeSession {
  return ClaudeSessionSchema.parse({
    id: row.id,
    cwd: row.cwd,
    transcriptPath: row.transcript_path,
    model: row.model,
    agentType: row.agent_type,
    permissionMode: row.permission_mode,
    status: row.status,
    lastEvent: row.last_event,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    endedAt: row.ended_at,
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

function statusForEvent(input: ClaudeHookInput): SessionStatus {
  switch (input.hook_event_name) {
    case "PermissionRequest":
      return "waiting";
    case "Notification":
      return input.notification_type === "permission_prompt" || input.notification_type === "idle_prompt"
        ? "waiting"
        : "idle";
    case "Stop":
    case "SessionStart":
      return "idle";
    case "SessionEnd":
      return "ended";
    case "StopFailure":
      return "error";
    default:
      return "working";
  }
}

export class SessionRepository {
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

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        transcript_path TEXT,
        model TEXT,
        agent_type TEXT,
        permission_mode TEXT,
        status TEXT NOT NULL CHECK (status IN ('working', 'waiting', 'idle', 'ended', 'error')),
        last_event TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE INDEX IF NOT EXISTS sessions_status_activity_idx
      ON sessions(status, last_event_at DESC);

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
  }

  close(): void {
    this.#db.close();
  }

  list(includeEnded = false): ClaudeSession[] {
    const rows = includeEnded
      ? this.#db.prepare("SELECT * FROM sessions ORDER BY last_event_at DESC").all()
      : this.#db
          .prepare("SELECT * FROM sessions WHERE status != 'ended' ORDER BY last_event_at DESC")
          .all();
    return (rows as unknown as SessionRow[]).map(mapSession);
  }

  get(id: string): ClaudeSession | undefined {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? mapSession(row as unknown as SessionRow) : undefined;
  }

  ingest(rawInput: unknown): ClaudeSession {
    const input = ClaudeHookInputSchema.parse(rawInput);
    const current = this.get(input.session_id);
    const now = new Date().toISOString();
    const status = statusForEvent(input);
    const startedAt = current?.startedAt ?? now;
    const endedAt = status === "ended" ? now : null;

    this.#db
      .prepare(`
        INSERT INTO sessions (
          id, cwd, transcript_path, model, agent_type, permission_mode,
          status, last_event, started_at, last_event_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cwd = excluded.cwd,
          transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
          model = COALESCE(excluded.model, sessions.model),
          agent_type = COALESCE(excluded.agent_type, sessions.agent_type),
          permission_mode = COALESCE(excluded.permission_mode, sessions.permission_mode),
          status = excluded.status,
          last_event = excluded.last_event,
          last_event_at = excluded.last_event_at,
          ended_at = excluded.ended_at
      `)
      .run(
        input.session_id,
        input.cwd,
        input.transcript_path ?? null,
        input.model ?? null,
        input.agent_type ?? null,
        input.permission_mode ?? null,
        status,
        input.hook_event_name,
        startedAt,
        now,
        endedAt,
      );

    const session = this.get(input.session_id);
    if (!session) throw new Error("Failed to read ingested Claude session");
    this.#recordEvent(input, session, now);
    return session;
  }

  #recordEvent(input: ClaudeHookInput, session: ClaudeSession, occurredAt: string): void {
    const payload = {
      session,
      hook: {
        event: input.hook_event_name,
        ...(input.tool_name ? { toolName: input.tool_name } : {}),
        ...(input.notification_type ? { notificationType: input.notification_type } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    };
    const result = this.#db
      .prepare(`
        INSERT INTO events (type, source, occurred_at, entity_type, entity_id, payload_json)
        VALUES (?, 'claude-hook', ?, 'session', ?, ?)
      `)
      .run(`session.${input.hook_event_name}`, occurredAt, input.session_id, JSON.stringify(payload));
    const row = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(result.lastInsertRowid);
    if (!row) throw new Error("Failed to read session event");
    this.#onEvent?.(mapEvent(row as unknown as EventRow));
  }
}
