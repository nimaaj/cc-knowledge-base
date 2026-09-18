import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AssistantEventSchema,
  CreateTaskSchema,
  TaskSchema,
  UpdateTaskSchema,
  type AssistantEvent,
  type CreateTaskInput,
  type Task,
  type TaskStatus,
  type UpdateTaskInput,
} from "@cc-assistant/shared";

interface TaskRow {
  id: string;
  title: string;
  description: string;
  project: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
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

export class TaskNotFoundError extends Error {}
export class RevisionConflictError extends Error {}

function mapTask(row: TaskRow): Task {
  return TaskSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    project: row.project,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
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

export class TaskRepository {
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

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        project TEXT,
        status TEXT NOT NULL CHECK (status IN ('inbox', 'planned', 'active', 'blocked', 'done', 'cancelled')),
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS tasks_status_updated_idx
      ON tasks(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_occurred_idx
      ON events(occurred_at DESC);
    `);
  }

  close(): void {
    this.#db.close();
  }

  list(status?: TaskStatus): Task[] {
    const rows = status
      ? this.#db
          .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, updated_at DESC")
          .all(status)
      : this.#db.prepare("SELECT * FROM tasks ORDER BY priority ASC, updated_at DESC").all();
    return (rows as unknown as TaskRow[]).map(mapTask);
  }

  get(id: string): Task | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? mapTask(row as unknown as TaskRow) : undefined;
  }

  create(input: CreateTaskInput, source = "api"): Task {
    const value = CreateTaskSchema.parse(input);
    const now = new Date().toISOString();
    const task = TaskSchema.parse({
      id: randomUUID(),
      title: value.title,
      description: value.description,
      project: value.project ?? null,
      status: value.status,
      priority: value.priority,
      dueAt: value.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    });

    this.#transaction(() => {
      this.#db
        .prepare(`
          INSERT INTO tasks (
            id, title, description, project, status, priority,
            due_at, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          task.id,
          task.title,
          task.description,
          task.project,
          task.status,
          task.priority,
          task.dueAt,
          task.createdAt,
          task.updatedAt,
          task.revision,
        );
    });

    this.#recordEvent("task.created", source, task.id, { task });
    return task;
  }

  update(id: string, input: UpdateTaskInput, source = "api"): Task {
    const value = UpdateTaskSchema.parse(input);
    const current = this.get(id);
    if (!current) throw new TaskNotFoundError(`Task ${id} was not found`);

    if (value.expectedRevision !== undefined && value.expectedRevision !== current.revision) {
      throw new RevisionConflictError(`Task ${id} has changed since it was loaded`);
    }

    const updated = TaskSchema.parse({
      ...current,
      ...(value.title !== undefined ? { title: value.title } : {}),
      ...(value.description !== undefined ? { description: value.description } : {}),
      ...(Object.hasOwn(value, "project") ? { project: value.project ?? null } : {}),
      ...(value.status !== undefined ? { status: value.status } : {}),
      ...(value.priority !== undefined ? { priority: value.priority } : {}),
      ...(Object.hasOwn(value, "dueAt") ? { dueAt: value.dueAt ?? null } : {}),
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1,
    });

    const result = this.#db
      .prepare(`
        UPDATE tasks
        SET title = ?, description = ?, project = ?, status = ?, priority = ?,
            due_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND revision = ?
      `)
      .run(
        updated.title,
        updated.description,
        updated.project,
        updated.status,
        updated.priority,
        updated.dueAt,
        updated.updatedAt,
        updated.revision,
        id,
        current.revision,
      );

    if (result.changes !== 1) {
      throw new RevisionConflictError(`Task ${id} changed during the update`);
    }

    this.#recordEvent("task.updated", source, id, { task: updated, previousRevision: current.revision });
    return updated;
  }

  listEvents(afterId = 0, limit = 100): AssistantEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, Math.min(Math.max(limit, 1), 500));
    return (rows as unknown as EventRow[]).map(mapEvent);
  }

  #recordEvent(
    type: string,
    source: string,
    entityId: string,
    payload: Record<string, unknown>,
  ): void {
    const occurredAt = new Date().toISOString();
    const result = this.#db
      .prepare(`
        INSERT INTO events (type, source, occurred_at, entity_type, entity_id, payload_json)
        VALUES (?, ?, ?, 'task', ?, ?)
      `)
      .run(type, source, occurredAt, entityId, JSON.stringify(payload));

    const row = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(result.lastInsertRowid);
    if (!row) throw new Error("Failed to read newly created event");
    this.#onEvent?.(mapEvent(row as unknown as EventRow));
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
