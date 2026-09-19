import { z } from "zod";

export const taskStatuses = [
  "inbox",
  "planned",
  "active",
  "blocked",
  "done",
  "cancelled",
] as const;

export const TaskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  description: z.string(),
  project: z.string().nullable(),
  status: TaskStatusSchema,
  priority: z.number().int().min(0).max(4),
  dueAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).default(""),
  project: z.string().trim().min(1).max(160).nullable().optional(),
  status: TaskStatusSchema.default("inbox"),
  priority: z.number().int().min(0).max(4).default(2),
  dueAt: z.iso.datetime().nullable().optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().trim().max(20_000).optional(),
    project: z.string().trim().min(1).max(160).nullable().optional(),
    status: TaskStatusSchema.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    dueAt: z.iso.datetime().nullable().optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
    "At least one task field must be supplied",
  );
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const TaskListSchema = z.object({
  tasks: z.array(TaskSchema),
});

export const AssistantEventSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().min(1),
  source: z.string().min(1),
  occurredAt: z.iso.datetime(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  now: z.iso.datetime(),
});

export const sessionStatuses = ["working", "waiting", "idle", "ended", "error"] as const;
export const SessionStatusSchema = z.enum(sessionStatuses);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ClaudeSessionSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  transcriptPath: z.string().nullable(),
  model: z.string().nullable(),
  agentType: z.string().nullable(),
  permissionMode: z.string().nullable(),
  status: SessionStatusSchema,
  lastEvent: z.string().min(1),
  startedAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});
export type ClaudeSession = z.infer<typeof ClaudeSessionSchema>;

export const ClaudeSessionListSchema = z.object({
  sessions: z.array(ClaudeSessionSchema),
});

export const ClaudeHookInputSchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().optional(),
    cwd: z.string().min(1),
    hook_event_name: z.string().min(1),
    model: z.string().optional(),
    agent_type: z.string().optional(),
    permission_mode: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    notification_type: z.string().optional(),
    tool_name: z.string().optional(),
  })
  .loose();
export type ClaudeHookInput = z.infer<typeof ClaudeHookInputSchema>;

export const runKinds = ["agent", "command", "browser"] as const;
export const RunKindSchema = z.enum(runKinds);
export type RunKind = z.infer<typeof RunKindSchema>;

export const runStatuses = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const RunStatusSchema = z.enum(runStatuses);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid().nullable(),
  kind: RunKindSchema,
  status: RunStatusSchema,
  title: z.string().min(1),
  prompt: z.string().nullable(),
  cwd: z.string().min(1),
  sessionId: z.string().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunListSchema = z.object({ runs: z.array(RunSchema) });

export const RunLogSchema = z.object({
  id: z.number().int().positive(),
  runId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  level: z.enum(["debug", "info", "warning", "error"]),
  message: z.string(),
  data: z.unknown().nullable(),
  occurredAt: z.iso.datetime(),
});
export type RunLog = z.infer<typeof RunLogSchema>;

export const ApprovalSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  actionType: z.string().min(1),
  summary: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolutionNote: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalListSchema = z.object({ approvals: z.array(ApprovalSchema) });

export const StartAgentRunSchema = z.object({
  taskId: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(100_000),
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  maxTurns: z.number().int().min(1).max(200).default(50),
  maxBudgetUsd: z.number().positive().max(1_000).optional(),
  useWorktree: z.boolean().default(false),
});
export type StartAgentRunInput = z.input<typeof StartAgentRunSchema>;

export const ProposeCommandSchema = z.object({
  taskId: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240),
  executable: z.string().min(1),
  args: z.array(z.string()).max(200).default([]),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
  env: z.record(z.string(), z.string()).default({}),
});
export type ProposeCommandInput = z.input<typeof ProposeCommandSchema>;

export const ResolveApprovalSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  note: z.string().trim().max(2_000).nullable().optional(),
});
export type ResolveApprovalInput = z.infer<typeof ResolveApprovalSchema>;

export const scheduleTriggerKinds = ["at", "interval", "system_notification"] as const;
export const ScheduleTriggerKindSchema = z.enum(scheduleTriggerKinds);
export const scheduleActionKinds = ["reminder", "agent", "command", "ability"] as const;
export const ScheduleActionKindSchema = z.enum(scheduleActionKinds);

export const ScheduleSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  enabled: z.boolean(),
  triggerKind: ScheduleTriggerKindSchema,
  trigger: z.record(z.string(), z.unknown()),
  actionKind: ScheduleActionKindSchema,
  action: z.record(z.string(), z.unknown()),
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;
export const ScheduleListSchema = z.object({ schedules: z.array(ScheduleSchema) });

export const CreateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(240),
  enabled: z.boolean().default(true),
  triggerKind: ScheduleTriggerKindSchema,
  trigger: z.record(z.string(), z.unknown()),
  actionKind: ScheduleActionKindSchema,
  action: z.record(z.string(), z.unknown()),
});
export type CreateScheduleInput = z.input<typeof CreateScheduleSchema>;

export const UpdateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  enabled: z.boolean().optional(),
  triggerKind: ScheduleTriggerKindSchema.optional(),
  trigger: z.record(z.string(), z.unknown()).optional(),
  actionKind: ScheduleActionKindSchema.optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().positive().optional(),
});
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;

export const AssistantNotificationSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  body: z.string(),
  source: z.string().min(1),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AssistantNotification = z.infer<typeof AssistantNotificationSchema>;
export const AssistantNotificationListSchema = z.object({
  notifications: z.array(AssistantNotificationSchema),
});

export const memoryStatuses = ["active", "archived"] as const;
export const MemoryStatusSchema = z.enum(memoryStatuses);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryProvenanceSchema = z.object({
  sourceType: z.string().trim().min(1).max(80),
  sourceUri: z.string().trim().min(1).max(2_000).nullable(),
  sourceRef: z.string().trim().min(1).max(500).nullable(),
  capturedAt: z.iso.datetime(),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const MemorySchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  summary: z.string().nullable(),
  kind: z.string().min(1),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  project: z.string().nullable(),
  status: MemoryStatusSchema,
  provenance: MemoryProvenanceSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(),
});
export type Memory = z.infer<typeof MemorySchema>;
export const MemoryListSchema = z.object({ memories: z.array(MemorySchema) });
export const MemoryRecallResultSchema = z.object({
  query: z.string(),
  memories: z.array(MemorySchema),
});
export type MemoryRecallResult = z.infer<typeof MemoryRecallResultSchema>;

const MemorySlugSchema = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160);
const MemoryKindSchema = z.string().trim().regex(/^[a-z][a-z0-9_-]*$/).max(80);
const MemoryStringListSchema = z.array(z.string().trim().min(1).max(160)).max(100);

export const CreateMemorySchema = z.object({
  slug: MemorySlugSchema.optional(),
  title: z.string().trim().min(1).max(240),
  body: z.string().max(200_000),
  summary: z.string().trim().max(2_000).nullable().optional(),
  kind: MemoryKindSchema.default("note"),
  tags: MemoryStringListSchema.default([]),
  aliases: MemoryStringListSchema.default([]),
  project: z.string().trim().min(1).max(160).nullable().optional(),
  provenance: z.object({
    sourceType: z.string().trim().min(1).max(80).default("manual"),
    sourceUri: z.string().trim().min(1).max(2_000).nullable().optional(),
    sourceRef: z.string().trim().min(1).max(500).nullable().optional(),
    capturedAt: z.iso.datetime().optional(),
  }).default({ sourceType: "manual" }),
});
export type CreateMemoryInput = z.input<typeof CreateMemorySchema>;

export const IngestMemorySchema = CreateMemorySchema.extend({
  provenance: z.object({
    sourceType: z.string().trim().min(1).max(80),
    sourceUri: z.string().trim().min(1).max(2_000).nullable().optional(),
    sourceRef: z.string().trim().min(1).max(500).nullable().optional(),
    capturedAt: z.iso.datetime().optional(),
  }),
});

export const UpdateMemorySchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    body: z.string().max(200_000).optional(),
    summary: z.string().trim().max(2_000).nullable().optional(),
    kind: MemoryKindSchema.optional(),
    tags: MemoryStringListSchema.optional(),
    aliases: MemoryStringListSchema.optional(),
    project: z.string().trim().min(1).max(160).nullable().optional(),
    status: MemoryStatusSchema.optional(),
    provenance: z.object({
      sourceType: z.string().trim().min(1).max(80),
      sourceUri: z.string().trim().min(1).max(2_000).nullable(),
      sourceRef: z.string().trim().min(1).max(500).nullable(),
      capturedAt: z.iso.datetime(),
    }).optional(),
    expectedRevision: z.number().int().positive(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
    "At least one memory field must be supplied",
  );
export type UpdateMemoryInput = z.infer<typeof UpdateMemorySchema>;

export const MemoryRevisionSchema = MemorySchema.extend({
  memoryId: z.uuid(),
  recordedAt: z.iso.datetime(),
});
export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;
export const MemoryRevisionListSchema = z.object({ revisions: z.array(MemoryRevisionSchema) });

export const MemoryLinkSchema = z.object({
  slug: MemorySlugSchema,
  label: z.string().min(1),
  resolvedMemoryId: z.uuid().nullable(),
});
export type MemoryLink = z.infer<typeof MemoryLinkSchema>;

export const MemoryBacklinkSchema = z.object({
  id: z.uuid(),
  slug: MemorySlugSchema,
  title: z.string().min(1),
  status: MemoryStatusSchema,
});
export type MemoryBacklink = z.infer<typeof MemoryBacklinkSchema>;

export const MemoryDetailSchema = z.object({
  memory: MemorySchema,
  outgoingLinks: z.array(MemoryLinkSchema),
  backlinks: z.array(MemoryBacklinkSchema),
});
export type MemoryDetail = z.infer<typeof MemoryDetailSchema>;

export const MemoryTagSchema = z.object({
  tag: z.string().min(1),
  count: z.number().int().nonnegative(),
});
export const MemoryTagListSchema = z.object({ tags: z.array(MemoryTagSchema) });
export type MemoryTag = z.infer<typeof MemoryTagSchema>;

export const MemoryMarkdownFileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  content: z.string().max(300_000),
});
export type MemoryMarkdownFile = z.infer<typeof MemoryMarkdownFileSchema>;

export const MemoryMarkdownExportSchema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  files: z.array(MemoryMarkdownFileSchema).max(10_000),
});
export type MemoryMarkdownExport = z.infer<typeof MemoryMarkdownExportSchema>;

export const MemoryMarkdownImportRequestSchema = z.object({
  files: z.array(MemoryMarkdownFileSchema).min(1).max(10_000),
});
export type MemoryMarkdownImportRequest = z.infer<typeof MemoryMarkdownImportRequestSchema>;

export const memoryImportActions = ["create", "update", "unchanged", "conflict", "invalid"] as const;
export const MemoryImportActionSchema = z.enum(memoryImportActions);
export type MemoryImportAction = z.infer<typeof MemoryImportActionSchema>;

export const MemoryImportEntrySchema = z.object({
  path: z.string().min(1),
  slug: z.string().nullable(),
  action: MemoryImportActionSchema,
  reason: z.string().nullable(),
  currentRevision: z.number().int().positive().nullable(),
  importedRevision: z.number().int().nonnegative().nullable(),
});
export type MemoryImportEntry = z.infer<typeof MemoryImportEntrySchema>;

export const MemoryImportPlanSchema = z.object({
  entries: z.array(MemoryImportEntrySchema),
  summary: z.object({
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
});
export type MemoryImportPlan = z.infer<typeof MemoryImportPlanSchema>;

export const AbilityManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(2_000),
  inputSchema: z.record(z.string(), z.unknown()),
  execution: z.object({
    kind: z.literal("command"),
    executable: z.string().min(1),
    args: z.array(z.string()).max(200),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
  }),
});
export type AbilityManifest = z.infer<typeof AbilityManifestSchema>;

export const BrowserJobSchema = z.object({
  id: z.uuid(),
  runId: z.uuid().nullable(),
  adapter: z.enum(["google_calendar", "slack"]),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  status: z.enum(["queued", "claimed", "succeeded", "failed", "cancelled"]),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  claimedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type BrowserJob = z.infer<typeof BrowserJobSchema>;
