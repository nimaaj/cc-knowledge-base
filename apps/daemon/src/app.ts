import { timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import {
  ApprovalSchema,
  AbilityManifestSchema,
  CreateMemorySchema,
  IngestMemorySchema,
  MemoryStatusSchema,
  CreateScheduleSchema,
  CreateTaskSchema,
  ProposeCommandSchema,
  ResolveApprovalSchema,
  RunStatusSchema,
  StartAgentRunSchema,
  TaskStatusSchema,
  UpdateMemorySchema,
  UpdateScheduleSchema,
  UpdateTaskSchema,
} from "@cc-assistant/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { DaemonConfig } from "./config.js";
import { AssistantRepository } from "./assistant-repository.js";
import { AutomationService } from "./automation-service.js";
import { EventHub } from "./event-hub.js";
import { ExecutionRepository } from "./execution-repository.js";
import { ExecutionService } from "./execution-service.js";
import { NativeService } from "./native-service.js";
import {
  MemoryNotFoundError,
  MemoryRevisionConflictError,
  SqliteMemoryRepository,
} from "./memory-repository.js";
import { SessionRepository } from "./session-repository.js";
import {
  RevisionConflictError,
  TaskNotFoundError,
  TaskRepository,
} from "./task-repository.js";

const SessionSchema = z.object({ token: z.string().min(1) });
const TaskParamsSchema = z.object({ id: z.uuid() });
const IdParamsSchema = z.object({ id: z.uuid() });
const EventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const allowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function secretsMatch(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function tokenFromAuthorization(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function requestSource(header: string | string[] | undefined): "mcp" | "cli" | "web" {
  if (header === "mcp") return "mcp";
  if (header === "cli") return "cli";
  return "web";
}

export interface AppDependencies {
  config: DaemonConfig;
  repository?: TaskRepository;
  sessionRepository?: SessionRepository;
  executionRepository?: ExecutionRepository;
  executionService?: ExecutionService;
  assistantRepository?: AssistantRepository;
  memoryRepository?: SqliteMemoryRepository;
  automationService?: AutomationService;
  nativeService?: NativeService;
  eventHub?: EventHub;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const eventHub = dependencies.eventHub ?? new EventHub();
  const ownsRepository = dependencies.repository === undefined;
  const ownsSessionRepository = dependencies.sessionRepository === undefined;
  const ownsExecutionRepository = dependencies.executionRepository === undefined;
  const ownsAssistantRepository = dependencies.assistantRepository === undefined;
  const ownsMemoryRepository = dependencies.memoryRepository === undefined;
  const repository =
    dependencies.repository ??
    new TaskRepository(dependencies.config.databasePath, (event) => eventHub.publish(event));
  const sessionRepository =
    dependencies.sessionRepository ??
    new SessionRepository(dependencies.config.databasePath, (event) => eventHub.publish(event));
  const executionRepository =
    dependencies.executionRepository ??
    new ExecutionRepository(dependencies.config.databasePath, (event) => eventHub.publish(event));
  const executionService =
    dependencies.executionService ?? new ExecutionService(executionRepository, dependencies.config);
  const assistantRepository = dependencies.assistantRepository ??
    new AssistantRepository(dependencies.config.databasePath, (event) => eventHub.publish(event));
  const memoryRepository = dependencies.memoryRepository ??
    new SqliteMemoryRepository(dependencies.config.databasePath, (event) => eventHub.publish(event));
  const nativeService = dependencies.nativeService ?? new NativeService();
  const automationService = dependencies.automationService ??
    new AutomationService(assistantRepository, executionService, nativeService, dependencies.config);
  automationService.start();

  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    const hostname = request.hostname.replace(/^\[|\]$/g, "");
    if (!allowedHosts.has(hostname)) {
      return reply.code(400).send({ error: "invalid_host", message: "Host is not allowed" });
    }

    if (request.url === "/api/health" || request.url === "/api/session") return;

    const candidate =
      tokenFromAuthorization(request.headers.authorization) ?? request.cookies.cc_assistant_session;
    if (!secretsMatch(candidate, dependencies.config.accessToken)) {
      return reply.code(401).send({ error: "unauthorized", message: "Authentication is required" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TaskNotFoundError) {
      return reply.code(404).send({ error: "task_not_found", message: error.message });
    }
    if (error instanceof RevisionConflictError) {
      return reply.code(409).send({ error: "revision_conflict", message: error.message });
    }
    if (error instanceof MemoryNotFoundError) {
      return reply.code(404).send({ error: "memory_not_found", message: error.message });
    }
    if (error instanceof MemoryRevisionConflictError) {
      return reply.code(409).send({ error: "revision_conflict", message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Request validation failed",
        details: z.treeifyError(error),
      });
    }

    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "Unexpected server error" });
  });

  app.get("/api/health", async () => ({
    ok: true as const,
    version: "0.1.0",
    now: new Date().toISOString(),
  }));

  app.get("/api/config", async () => ({
    platform: process.platform,
    allowedRoots: dependencies.config.allowedRoots,
    dataDir: dependencies.config.dataDir,
  }));

  app.post("/api/session", async (request, reply) => {
    const { token } = SessionSchema.parse(request.body);
    if (!secretsMatch(token, dependencies.config.accessToken)) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid access token" });
    }

    reply.setCookie("cc_assistant_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return reply.code(204).send();
  });

  app.delete("/api/session", async (_request, reply) => {
    reply.clearCookie("cc_assistant_session", { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/tasks", async (request) => {
    const query = z.object({ status: TaskStatusSchema.optional() }).parse(request.query);
    return { tasks: repository.list(query.status) };
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = TaskParamsSchema.parse(request.params);
    const task = repository.get(id);
    if (!task) {
      return reply.code(404).send({ error: "task_not_found", message: `Task ${id} was not found` });
    }
    return { task };
  });

  app.post("/api/tasks", async (request, reply) => {
    const input = CreateTaskSchema.parse(request.body);
    const task = repository.create(input, requestSource(request.headers["x-cc-assistant-source"]));
    return reply.code(201).send({ task });
  });

  app.patch("/api/tasks/:id", async (request) => {
    const { id } = TaskParamsSchema.parse(request.params);
    const input = UpdateTaskSchema.parse(request.body);
    return {
      task: repository.update(
        id,
        input,
        requestSource(request.headers["x-cc-assistant-source"]),
      ),
    };
  });

  app.get("/api/events", async (request) => {
    const query = EventsQuerySchema.parse(request.query);
    return { events: repository.listEvents(query.after, query.limit) };
  });

  app.get("/api/sessions", async (request) => {
    const query = z
      .object({ includeEnded: z.stringbool().default(false) })
      .parse(request.query);
    return { sessions: sessionRepository.list(query.includeEnded) };
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const id = z.object({ id: z.string().min(1) }).parse(request.params).id;
    const session = sessionRepository.get(id);
    if (!session) {
      return reply
        .code(404)
        .send({ error: "session_not_found", message: `Session ${id} was not found` });
    }
    return { session };
  });

  app.post("/api/hooks/claude", async (request) => {
    const session = sessionRepository.ingest(request.body);
    return { accepted: true, session };
  });

  app.get("/api/runs", async (request) => {
    const query = z.object({ status: RunStatusSchema.optional() }).parse(request.query);
    return { runs: executionRepository.listRuns(query.status) };
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const run = executionRepository.getRun(id);
    if (!run) return reply.code(404).send({ error: "run_not_found", message: `Run ${id} was not found` });
    return { run };
  });

  app.get("/api/runs/:id/logs", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    if (!executionRepository.getRun(id)) {
      return reply.code(404).send({ error: "run_not_found", message: `Run ${id} was not found` });
    }
    const query = z
      .object({
        after: z.coerce.number().int().min(-1).default(-1),
        limit: z.coerce.number().int().min(1).max(2_000).default(500),
      })
      .parse(request.query);
    return { logs: executionRepository.listLogs(id, query.after, query.limit) };
  });

  app.post("/api/runs/agent", async (request, reply) => {
    const run = executionService.startAgent(StartAgentRunSchema.parse(request.body));
    return reply.code(202).send({ run });
  });

  app.post("/api/runs/command", async (request, reply) => {
    const proposed = executionService.proposeCommand(ProposeCommandSchema.parse(request.body));
    return reply.code(202).send(proposed);
  });

  app.post("/api/runs/:id/cancel", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    return { run: executionService.cancel(id) };
  });

  app.get("/api/approvals", async (request) => {
    const query = z.object({ status: ApprovalSchema.shape.status.optional() }).parse(request.query);
    return { approvals: executionRepository.listApprovals(query.status) };
  });

  app.post("/api/approvals/:id/resolve", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const resolution = ResolveApprovalSchema.parse(request.body);
    const pending = executionRepository.getApproval(id);
    const approval = executionService.resolveApproval(id, resolution);
    if (pending?.actionType === "browser_action" && resolution.decision === "approved") {
      const adapter = z.enum(["google_calendar", "slack"]).parse(pending.payload.adapter);
      const action = z.string().min(1).parse(pending.payload.action);
      const input = z.record(z.string(), z.unknown()).parse(pending.payload.input);
      const job = assistantRepository.createBrowserJob(adapter, action, input, pending.runId);
      executionService.updateExternalRun(pending.runId, {
        status: "running",
        metadata: { ...(executionRepository.getRun(pending.runId)?.metadata ?? {}), browserJobId: job.id },
      });
    }
    return { approval };
  });

  app.get("/api/schedules", async () => ({ schedules: assistantRepository.listSchedules() }));

  app.get("/api/schedules/:id", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const schedule = assistantRepository.getSchedule(id);
    if (!schedule) return reply.code(404).send({ error: "schedule_not_found", message: `Schedule ${id} was not found` });
    return { schedule };
  });

  app.post("/api/schedules", async (request, reply) => {
    const schedule = assistantRepository.createSchedule(CreateScheduleSchema.parse(request.body));
    return reply.code(201).send({ schedule });
  });

  app.patch("/api/schedules/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    return { schedule: assistantRepository.updateSchedule(id, UpdateScheduleSchema.parse(request.body)) };
  });

  app.get("/api/notifications", async (request) => {
    const query = z.object({ includeRead: z.stringbool().default(false) }).parse(request.query);
    return { notifications: assistantRepository.listNotifications(query.includeRead) };
  });

  app.post("/api/notifications/:id/read", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    assistantRepository.markNotificationRead(id);
    return reply.code(204).send();
  });

  app.post("/api/triggers/system-notification", async (request) => {
    const input = z.object({ app: z.string().optional(), title: z.string().optional(), body: z.string().optional() }).parse(request.body);
    return { matched: await automationService.ingestSystemNotification(input) };
  });

  app.get("/api/memories", async (request) => {
    const query = z.object({
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      status: MemoryStatusSchema.optional(),
      project: z.string().min(1).max(160).optional(),
      kind: z.string().min(1).max(80).optional(),
      tag: z.string().min(1).max(160).optional(),
      includeArchived: z.stringbool().default(false),
    }).parse(request.query);
    return { memories: memoryRepository.list({
      query: query.q,
      limit: query.limit,
      status: query.status,
      project: query.project,
      kind: query.kind,
      tag: query.tag,
      includeArchived: query.includeArchived,
    }) };
  });

  app.get("/api/memories/recall", async (request) => {
    const query = z.object({
      q: z.string().default(""),
      limit: z.coerce.number().int().min(1).max(100).default(10),
      project: z.string().min(1).max(160).optional(),
      kind: z.string().min(1).max(80).optional(),
      tag: z.string().min(1).max(160).optional(),
    }).parse(request.query);
    return {
      query: query.q,
      memories: memoryRepository.list({
        query: query.q, limit: query.limit, project: query.project, kind: query.kind, tag: query.tag,
      }),
    };
  });

  app.get("/api/memories/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const detail = memoryRepository.get(id);
    if (!detail) return reply.code(404).send({ error: "memory_not_found", message: `Memory ${id} was not found` });
    return detail;
  });

  app.post("/api/memories", async (request, reply) => {
    const detail = memoryRepository.create(
      CreateMemorySchema.parse(request.body),
      requestSource(request.headers["x-cc-assistant-source"]),
    );
    return reply.code(201).send(detail);
  });

  app.post("/api/memories/ingest", async (request, reply) => {
    const detail = memoryRepository.ingest(
      IngestMemorySchema.parse(request.body),
      requestSource(request.headers["x-cc-assistant-source"]),
    );
    return reply.code(201).send(detail);
  });

  app.patch("/api/memories/:id", async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return memoryRepository.update(
      id,
      UpdateMemorySchema.parse(request.body),
      requestSource(request.headers["x-cc-assistant-source"]),
    );
  });

  app.get("/api/memories/:id/revisions", async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { revisions: memoryRepository.history(id) };
  });

  app.get("/api/memories/:id/revisions/:revision", async (request, reply) => {
    const { id, revision } = z.object({
      id: z.string().min(1), revision: z.coerce.number().int().positive(),
    }).parse(request.params);
    const result = memoryRepository.revision(id, revision);
    if (!result) return reply.code(404).send({
      error: "memory_revision_not_found",
      message: `Revision ${revision} of memory ${id} was not found`,
    });
    return { revision: result };
  });

  app.get("/api/abilities", async () => ({ abilities: assistantRepository.listAbilities() }));

  app.post("/api/abilities", async (request, reply) => {
    const ability = assistantRepository.installAbility(AbilityManifestSchema.parse(request.body));
    return reply.code(201).send({ ability });
  });

  app.post("/api/abilities/:id/invoke", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ input: z.record(z.string(), z.unknown()).default({}), taskId: z.uuid().nullable().optional() }).parse(request.body);
    return reply.code(202).send(automationService.invokeAbility(id, body.input, body.taskId));
  });

  app.get("/api/native/clipboard/image", async () => {
    const image = await nativeService.readClipboardImage();
    return { image: { ...image, dataUrl: `data:${image.mimeType};base64,${image.base64}` } };
  });

  app.post("/api/native/notify", async (request, reply) => {
    const body = z.object({ title: z.string().min(1), body: z.string().default("") }).parse(request.body);
    await nativeService.notify(body.title, body.body);
    return reply.code(204).send();
  });

  app.post("/api/browser/jobs", async (request, reply) => {
    const body = z.object({ adapter: z.enum(["google_calendar", "slack"]), action: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const readActions = new Set(["list_visible_events", "list_unreads", "read_channel"]);
    if (!readActions.has(body.action)) {
      return reply.code(202).send(executionService.proposeBrowser(body.adapter, body.action, body.input));
    }
    return reply.code(202).send({ job: assistantRepository.createBrowserJob(body.adapter, body.action, body.input) });
  });

  app.get("/api/browser/jobs/claim", async (_request, reply) => {
    const job = assistantRepository.claimBrowserJob();
    return job ? { job } : reply.code(204).send();
  });

  app.get("/api/browser/jobs/:id", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const job = assistantRepository.getBrowserJob(id);
    if (!job) return reply.code(404).send({ error: "browser_job_not_found", message: `Browser job ${id} was not found` });
    return { job };
  });

  app.post("/api/browser/jobs/:id/complete", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = z.object({ result: z.unknown().optional(), error: z.string().optional() }).parse(request.body);
    const job = assistantRepository.completeBrowserJob(id, body.result, body.error);
    if (job.runId) {
      executionService.updateExternalRun(job.runId, {
        status: body.error ? "failed" : "succeeded",
        result: body.error ? null : JSON.stringify(body.result ?? null),
        error: body.error ?? null,
        completedAt: new Date().toISOString(),
      });
    }
    return { job };
  });

  app.get("/api/events/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const unsubscribe = eventHub.subscribe(reply.raw);
    request.raw.once("close", unsubscribe);
  });

  app.addHook("onClose", async () => {
    automationService.stop();
    executionService.shutdown();
    if (ownsRepository) repository.close();
    if (ownsSessionRepository) sessionRepository.close();
    if (ownsExecutionRepository) executionRepository.close();
    if (ownsAssistantRepository) assistantRepository.close();
    if (ownsMemoryRepository) memoryRepository.close();
  });

  return app;
}
