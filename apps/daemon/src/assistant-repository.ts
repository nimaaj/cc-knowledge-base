import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AbilityManifestSchema,
  AssistantEventSchema,
  AssistantNotificationSchema,
  BrowserJobSchema,
  CreateScheduleSchema,
  ScheduleSchema,
  UpdateScheduleSchema,
  type AbilityManifest,
  type AssistantEvent,
  type AssistantNotification,
  type BrowserJob,
  type CreateScheduleInput,
  type Schedule,
} from "@cc-assistant/shared";

type JsonRecord = Record<string, unknown>;
type Row = Record<string, unknown>;

function json(value: unknown): JsonRecord {
  return JSON.parse(String(value)) as JsonRecord;
}

function mapSchedule(row: Row): Schedule {
  return ScheduleSchema.parse({
    id: row.id, name: row.name, enabled: Boolean(row.enabled),
    triggerKind: row.trigger_kind, trigger: json(row.trigger_json),
    actionKind: row.action_kind, action: json(row.action_json),
    nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
  });
}

function mapNotification(row: Row): AssistantNotification {
  return AssistantNotificationSchema.parse({
    id: row.id, title: row.title, body: row.body, source: row.source,
    read: Boolean(row.read), createdAt: row.created_at,
  });
}

function mapBrowserJob(row: Row): BrowserJob {
  return BrowserJobSchema.parse({
    id: row.id, runId: row.run_id, adapter: row.adapter, action: row.action, input: json(row.input_json),
    status: row.status,
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)) as unknown,
    error: row.error, createdAt: row.created_at, claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  });
}

function nextRun(triggerKind: Schedule["triggerKind"], trigger: JsonRecord, now = Date.now()): string | null {
  if (triggerKind === "at") {
    const at = String(trigger.at ?? "");
    if (!Number.isFinite(Date.parse(at))) throw new Error("An at trigger requires trigger.at as an ISO timestamp");
    return new Date(at).toISOString();
  }
  if (triggerKind === "interval") {
    const everyMs = Number(trigger.everyMs);
    if (!Number.isInteger(everyMs) || everyMs < 1_000 || everyMs > 31_536_000_000) {
      throw new Error("An interval trigger requires everyMs between 1000 and 31536000000");
    }
    const start = trigger.startAt ? Date.parse(String(trigger.startAt)) : now + everyMs;
    if (!Number.isFinite(start)) throw new Error("trigger.startAt must be an ISO timestamp");
    return new Date(Math.max(start, now)).toISOString();
  }
  if (triggerKind === "system_notification") return null;
  throw new Error(`Unsupported trigger kind: ${triggerKind}`);
}

export class AssistantRepository {
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
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL,
        trigger_kind TEXT NOT NULL, trigger_json TEXT NOT NULL,
        action_kind TEXT NOT NULL, action_json TEXT NOT NULL,
        next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        source TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notifications_read_idx ON notifications(read, created_at DESC);
      CREATE TABLE IF NOT EXISTS abilities (
        id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_jobs (
        id TEXT PRIMARY KEY, run_id TEXT, adapter TEXT NOT NULL, action TEXT NOT NULL,
        input_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT,
        created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS browser_jobs_status_idx ON browser_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, source TEXT NOT NULL,
        occurred_at TEXT NOT NULL, entity_type TEXT, entity_id TEXT, payload_json TEXT NOT NULL
      );
    `);
    const browserColumns = this.#db.prepare("PRAGMA table_info(browser_jobs)").all() as Array<{ name: string }>;
    if (!browserColumns.some((column) => column.name === "run_id")) {
      this.#db.exec("ALTER TABLE browser_jobs ADD COLUMN run_id TEXT");
    }
  }

  close(): void { this.#db.close(); }

  createSchedule(rawInput: CreateScheduleInput): Schedule {
    const input = CreateScheduleSchema.parse(rawInput);
    const now = new Date().toISOString();
    const schedule = ScheduleSchema.parse({
      id: randomUUID(), name: input.name, enabled: input.enabled,
      triggerKind: input.triggerKind, trigger: input.trigger,
      actionKind: input.actionKind, action: input.action,
      nextRunAt: input.enabled ? nextRun(input.triggerKind, input.trigger) : null,
      lastRunAt: null, createdAt: now, updatedAt: now, revision: 1,
    });
    this.#db.prepare(`INSERT INTO schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(schedule.id, schedule.name, Number(schedule.enabled), schedule.triggerKind,
        JSON.stringify(schedule.trigger), schedule.actionKind, JSON.stringify(schedule.action),
        schedule.nextRunAt, schedule.lastRunAt, schedule.createdAt, schedule.updatedAt, schedule.revision);
    this.#event("schedule.created", "schedule", schedule.id, { schedule });
    return schedule;
  }

  getSchedule(id: string): Schedule | undefined {
    const row = this.#db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return row ? mapSchedule(row) : undefined;
  }

  listSchedules(): Schedule[] {
    return (this.#db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all() as Row[]).map(mapSchedule);
  }

  updateSchedule(id: string, rawInput: unknown): Schedule {
    const input = UpdateScheduleSchema.parse(rawInput);
    const current = this.getSchedule(id);
    if (!current) throw new Error(`Schedule ${id} was not found`);
    if (input.expectedRevision && input.expectedRevision !== current.revision) throw new Error("Schedule revision conflict");
    const triggerKind = input.triggerKind ?? current.triggerKind;
    const trigger = input.trigger ?? current.trigger;
    const enabled = input.enabled ?? current.enabled;
    const changedTrigger = input.triggerKind !== undefined || input.trigger !== undefined || input.enabled !== undefined;
    const updated = ScheduleSchema.parse({
      ...current, ...input, triggerKind, trigger, enabled,
      nextRunAt: changedTrigger ? (enabled ? nextRun(triggerKind, trigger) : null) : current.nextRunAt,
      updatedAt: new Date().toISOString(), revision: current.revision + 1,
    });
    this.#db.prepare(`UPDATE schedules SET name=?, enabled=?, trigger_kind=?, trigger_json=?,
      action_kind=?, action_json=?, next_run_at=?, last_run_at=?, updated_at=?, revision=? WHERE id=?`)
      .run(updated.name, Number(updated.enabled), updated.triggerKind, JSON.stringify(updated.trigger),
        updated.actionKind, JSON.stringify(updated.action), updated.nextRunAt, updated.lastRunAt,
        updated.updatedAt, updated.revision, id);
    this.#event("schedule.updated", "schedule", id, { schedule: updated });
    return updated;
  }

  dueSchedules(now = new Date().toISOString()): Schedule[] {
    return (this.#db.prepare(`SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL
      AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 100`).all(now) as Row[]).map(mapSchedule);
  }

  markScheduleRun(id: string, ranAt = new Date().toISOString()): Schedule {
    const current = this.getSchedule(id);
    if (!current) throw new Error(`Schedule ${id} was not found`);
    let enabled = current.enabled;
    let nextRunAt: string | null = null;
    if (current.triggerKind === "interval") {
      const everyMs = Number(current.trigger.everyMs);
      nextRunAt = new Date(Date.parse(ranAt) + everyMs).toISOString();
    } else if (current.triggerKind === "at") enabled = false;
    this.#db.prepare(`UPDATE schedules SET enabled=?, next_run_at=?, last_run_at=?, updated_at=?,
      revision=revision+1 WHERE id=?`).run(Number(enabled), nextRunAt, ranAt, ranAt, id);
    const updated = this.getSchedule(id);
    if (!updated) throw new Error(`Schedule ${id} disappeared`);
    this.#event("schedule.fired", "schedule", id, { schedule: updated });
    return updated;
  }

  matchingNotificationSchedules(input: { app?: string | undefined; title?: string | undefined; body?: string | undefined }): Schedule[] {
    return this.listSchedules().filter((schedule) => {
      if (!schedule.enabled || schedule.triggerKind !== "system_notification") return false;
      const cooldownMs = Number(schedule.trigger.cooldownMs ?? 60_000);
      if (schedule.lastRunAt && Number.isFinite(cooldownMs) && Date.now() - Date.parse(schedule.lastRunAt) < cooldownMs) return false;
      for (const key of ["app", "title", "body"] as const) {
        const pattern = schedule.trigger[key];
        if (pattern && !String(input[key] ?? "").toLowerCase().includes(String(pattern).toLowerCase())) return false;
      }
      return true;
    });
  }

  createNotification(title: string, body: string, source: string): AssistantNotification {
    const notification = AssistantNotificationSchema.parse({
      id: randomUUID(), title, body, source, read: false, createdAt: new Date().toISOString(),
    });
    this.#db.prepare("INSERT INTO notifications VALUES (?, ?, ?, ?, 0, ?)")
      .run(notification.id, title, body, source, notification.createdAt);
    this.#event("notification.created", "notification", notification.id, { notification });
    return notification;
  }

  listNotifications(includeRead = false): AssistantNotification[] {
    const sql = includeRead ? "SELECT * FROM notifications ORDER BY created_at DESC" :
      "SELECT * FROM notifications WHERE read=0 ORDER BY created_at DESC";
    return (this.#db.prepare(sql).all() as Row[]).map(mapNotification);
  }

  markNotificationRead(id: string): void {
    this.#db.prepare("UPDATE notifications SET read=1 WHERE id=?").run(id);
    this.#event("notification.read", "notification", id, {});
  }

  installAbility(rawManifest: unknown): AbilityManifest {
    const manifest = AbilityManifestSchema.parse(rawManifest);
    const now = new Date().toISOString();
    this.#db.prepare(`INSERT INTO abilities VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json, updated_at=excluded.updated_at`)
      .run(manifest.id, JSON.stringify(manifest), now, now);
    this.#event("ability.installed", "ability", manifest.id, { manifest });
    return manifest;
  }

  listAbilities(): AbilityManifest[] {
    return (this.#db.prepare("SELECT manifest_json FROM abilities ORDER BY id").all() as Row[])
      .map((row) => AbilityManifestSchema.parse(JSON.parse(String(row.manifest_json))));
  }

  getAbility(id: string): AbilityManifest | undefined {
    const row = this.#db.prepare("SELECT manifest_json FROM abilities WHERE id=?").get(id) as Row | undefined;
    return row ? AbilityManifestSchema.parse(JSON.parse(String(row.manifest_json))) : undefined;
  }

  createBrowserJob(adapter: BrowserJob["adapter"], action: string, input: JsonRecord, runId: string | null = null): BrowserJob {
    const job = BrowserJobSchema.parse({ id: randomUUID(), runId, adapter, action, input, status: "queued",
      result: null, error: null, createdAt: new Date().toISOString(), claimedAt: null, completedAt: null });
    this.#db.prepare(`INSERT INTO browser_jobs
      (id, run_id, adapter, action, input_json, status, result_json, error, created_at, claimed_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, runId, adapter, action, JSON.stringify(input), job.status, null, null, job.createdAt, null, null);
    this.#event("browser_job.created", "browser_job", job.id, { job });
    return job;
  }

  getBrowserJob(id: string): BrowserJob | undefined {
    const row = this.#db.prepare("SELECT * FROM browser_jobs WHERE id=?").get(id) as Row | undefined;
    return row ? mapBrowserJob(row) : undefined;
  }

  claimBrowserJob(): BrowserJob | undefined {
    const stale = new Date(Date.now() - 120_000).toISOString();
    this.#db.prepare("UPDATE browser_jobs SET status='queued', claimed_at=NULL WHERE status='claimed' AND claimed_at < ?")
      .run(stale);
    const row = this.#db.prepare("SELECT * FROM browser_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as Row | undefined;
    if (!row) return undefined;
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE browser_jobs SET status='claimed', claimed_at=? WHERE id=? AND status='queued'").run(now, String(row.id));
    return this.getBrowserJob(String(row.id));
  }

  completeBrowserJob(id: string, result: unknown, error?: string): BrowserJob {
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE browser_jobs SET status=?, result_json=?, error=?, completed_at=? WHERE id=?")
      .run(error ? "failed" : "succeeded", result === undefined ? null : JSON.stringify(result), error ?? null, now, id);
    const job = this.getBrowserJob(id);
    if (!job) throw new Error(`Browser job ${id} was not found`);
    this.#event("browser_job.completed", "browser_job", id, { job });
    return job;
  }

  #event(type: string, entityType: string, entityId: string, payload: JsonRecord): void {
    const occurredAt = new Date().toISOString();
    const result = this.#db.prepare(`INSERT INTO events (type, source, occurred_at, entity_type, entity_id, payload_json)
      VALUES (?, 'daemon', ?, ?, ?, ?)`).run(type, occurredAt, entityType, entityId, JSON.stringify(payload));
    const row = this.#db.prepare("SELECT * FROM events WHERE id=?").get(result.lastInsertRowid) as Row;
    this.#onEvent?.(AssistantEventSchema.parse({ id: row.id, type: row.type, source: row.source,
      occurredAt: row.occurred_at, entityType: row.entity_type, entityId: row.entity_id,
      payload: json(row.payload_json) }));
  }
}
