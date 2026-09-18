import {
  ApprovalListSchema,
  AssistantNotificationListSchema,
  ClaudeSessionListSchema,
  MemoryDetailSchema,
  MemoryListSchema,
  MemoryRevisionListSchema,
  RunListSchema,
  ScheduleListSchema,
  TaskListSchema,
  TaskSchema,
  type CreateTaskInput,
  type ClaudeSession,
  type Approval,
  type AssistantNotification,
  type Memory,
  type MemoryDetail,
  type MemoryRevision,
  type Run,
  type Schedule,
  type Task,
  type UpdateTaskInput,
} from "@cc-assistant/shared";

export class AuthenticationError extends Error {}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401) throw new AuthenticationError("Authentication is required");
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new Error(body?.message ?? `Request failed with HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined;
  return response.json() as Promise<unknown>;
}

export async function login(token: string): Promise<void> {
  await request("/api/session", { method: "POST", body: JSON.stringify({ token }) });
}

export async function logout(): Promise<void> {
  await request("/api/session", { method: "DELETE" });
}

export async function listTasks(): Promise<Task[]> {
  return TaskListSchema.parse(await request("/api/tasks")).tasks;
}

export async function listSessions(): Promise<ClaudeSession[]> {
  return ClaudeSessionListSchema.parse(await request("/api/sessions")).sessions;
}

export async function listRuns(): Promise<Run[]> {
  return RunListSchema.parse(await request("/api/runs")).runs;
}

export async function listPendingApprovals(): Promise<Approval[]> {
  return ApprovalListSchema.parse(await request("/api/approvals?status=pending")).approvals;
}

export async function resolveApproval(
  id: string,
  decision: "approved" | "denied",
): Promise<void> {
  await request(`/api/approvals/${id}/resolve`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

export async function cancelRun(id: string): Promise<void> {
  await request(`/api/runs/${id}/cancel`, { method: "POST" });
}

export async function getConfig(): Promise<{ platform: string; allowedRoots: string[]; dataDir: string }> {
  return await request("/api/config") as { platform: string; allowedRoots: string[]; dataDir: string };
}

export async function listNotifications(): Promise<AssistantNotification[]> {
  return AssistantNotificationListSchema.parse(await request("/api/notifications")).notifications;
}

export async function markNotificationRead(id: string): Promise<void> {
  await request(`/api/notifications/${id}/read`, { method: "POST" });
}

export async function listSchedules(): Promise<Schedule[]> {
  return ScheduleListSchema.parse(await request("/api/schedules")).schedules;
}

export async function createReminder(input: { title: string; body: string; at: string }): Promise<void> {
  await request("/api/schedules", { method: "POST", body: JSON.stringify({
    name: input.title, triggerKind: "at", trigger: { at: input.at },
    actionKind: "reminder", action: { title: input.title, body: input.body },
  }) });
}

export async function listMemories(query = "", includeArchived = false): Promise<Memory[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (includeArchived) params.set("includeArchived", "true");
  return MemoryListSchema.parse(await request(`/api/memories?${params}`)).memories;
}

export async function createMemory(input: { title: string; body: string; tags?: string[] }): Promise<MemoryDetail> {
  return MemoryDetailSchema.parse(await request("/api/memories", {
    method: "POST", body: JSON.stringify(input),
  }));
}

export async function getMemory(idOrSlug: string): Promise<MemoryDetail> {
  return MemoryDetailSchema.parse(await request(`/api/memories/${encodeURIComponent(idOrSlug)}`));
}

export async function updateMemory(
  idOrSlug: string,
  input: {
    title?: string; body?: string; summary?: string | null; kind?: string;
    tags?: string[]; aliases?: string[]; project?: string | null;
    status?: "active" | "archived"; expectedRevision: number;
  },
): Promise<MemoryDetail> {
  return MemoryDetailSchema.parse(await request(`/api/memories/${encodeURIComponent(idOrSlug)}`, {
    method: "PATCH", body: JSON.stringify(input),
  }));
}

export async function listMemoryRevisions(idOrSlug: string): Promise<MemoryRevision[]> {
  return MemoryRevisionListSchema.parse(
    await request(`/api/memories/${encodeURIComponent(idOrSlug)}/revisions`),
  ).revisions;
}

export async function startAgent(input: { title: string; prompt: string; cwd: string }): Promise<void> {
  await request("/api/runs/agent", { method: "POST", body: JSON.stringify(input) });
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const result = (await request("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { task: unknown };
  return TaskSchema.parse(result.task);
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  const result = (await request(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })) as { task: unknown };
  return TaskSchema.parse(result.task);
}
