import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { type Approval, type AssistantNotification, type ClaudeSession, type Memory, type MemoryDetail, type MemoryRevision, type MemoryTag, type Run, type Schedule, type Task, type TaskStatus } from "@cc-assistant/shared";
import {
  AuthenticationError,
  cancelRun,
  createMemory,
  createReminder,
  createTask,
  getConfig,
  getMemory,
  listMemoryRevisions,
  listMemoryTags,
  listMemories,
  listNotifications,
  listPendingApprovals,
  listRuns,
  listSchedules,
  listSessions,
  listTasks,
  login,
  logout,
  markNotificationRead,
  resolveApproval,
  startAgent,
  updateMemory,
  updateTask,
} from "./api.js";

const statusLabels: Record<TaskStatus, string> = {
  inbox: "Inbox",
  planned: "Planned",
  active: "Active",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const visibleStatuses: TaskStatus[] = ["active", "inbox", "planned", "blocked", "done"];

function formatRelative(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }): React.JSX.Element {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login(token);
      onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="mark">CC</div>
        <p className="eyebrow">Local workspace</p>
        <h1>Open your assistant</h1>
        <p className="muted">Paste the token stored in <code>.data/access-token</code>.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="token">Access token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          {error ? <p className="error">{error}</p> : null}
          <button className="primary" disabled={busy || token.length === 0}>
            {busy ? "Opening…" : "Open assistant"}
          </button>
        </form>
      </section>
    </main>
  );
}

function TaskCard({ task, onChange }: { task: Task; onChange: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const setStatus = async (status: TaskStatus): Promise<void> => {
    setBusy(true);
    try {
      await updateTask(task.id, { status, expectedRevision: task.revision });
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`task-card status-${task.status}`}>
      <div className="task-topline">
        <span className={`priority priority-${task.priority}`}>P{task.priority}</span>
        {task.project ? <span className="project">{task.project}</span> : null}
        <span className="updated">{formatRelative(task.updatedAt)}</span>
      </div>
      <h3>{task.title}</h3>
      {task.description ? <p>{task.description}</p> : null}
      <div className="task-actions">
        {task.status !== "active" && task.status !== "done" ? (
          <button disabled={busy} onClick={() => void setStatus("active")}>Focus</button>
        ) : null}
        {task.status !== "done" ? (
          <button disabled={busy} onClick={() => void setStatus("done")}>Complete</button>
        ) : (
          <button disabled={busy} onClick={() => void setStatus("inbox")}>Reopen</button>
        )}
      </div>
    </article>
  );
}

function NewTask({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      await createTask({ title, project: project || null });
      setTitle("");
      setProject("");
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="capture" onSubmit={(event) => void submit(event)}>
      <div>
        <label htmlFor="new-task">Capture a task</label>
        <input
          id="new-task"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs your attention?"
        />
      </div>
      <div className="project-field">
        <label htmlFor="new-project">Project</label>
        <input
          id="new-project"
          value={project}
          onChange={(event) => setProject(event.target.value)}
          placeholder="Optional"
        />
      </div>
      <button className="primary" disabled={busy || title.trim().length === 0}>
        {busy ? "Adding…" : "Add task"}
      </button>
    </form>
  );
}

function SessionStrip({ sessions }: { sessions: ClaudeSession[] }): React.JSX.Element {
  return (
    <section className="sessions">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Claude Code</p>
          <h2>Observed sessions</h2>
        </div>
        <span>{sessions.length} live</span>
      </div>
      <div className="session-list">
        {sessions.map((session) => (
          <article className="session-card" key={session.id}>
            <div className="session-title">
              <i className={`session-dot ${session.status}`} />
              <strong>{session.cwd.split("/").filter(Boolean).at(-1) ?? session.cwd}</strong>
              <span className={`session-status ${session.status}`}>{session.status}</span>
            </div>
            <p>{session.lastEvent.replaceAll(/([a-z])([A-Z])/g, "$1 $2")}</p>
            <div className="session-meta">
              <span>{session.model ?? "Model unknown"}</span>
              <span>{formatRelative(session.lastEventAt)}</span>
            </div>
          </article>
        ))}
        {sessions.length === 0 ? (
          <div className="session-empty">
            Restart Claude Code once to activate the project lifecycle hooks.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ExecutionPanel({
  runs,
  approvals,
  onChange,
}: {
  runs: Run[];
  approvals: Approval[];
  onChange: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string>();
  const decide = async (id: string, decision: "approved" | "denied"): Promise<void> => {
    setBusy(id);
    try {
      await resolveApproval(id, decision);
      onChange();
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="execution">
      <div className="section-heading">
        <div><p className="eyebrow">Execution</p><h2>Managed work</h2></div>
        <span>{approvals.length} awaiting approval</span>
      </div>
      {approvals.length > 0 ? (
        <div className="approval-list">
          {approvals.map((approval) => (
            <article className="approval-card" key={approval.id}>
              <div><span>{approval.actionType.replaceAll("_", " ")}</span><strong>{approval.summary}</strong></div>
              <div className="approval-actions">
                <button disabled={busy === approval.id} onClick={() => void decide(approval.id, "denied")}>Deny</button>
                <button className="primary" disabled={busy === approval.id} onClick={() => void decide(approval.id, "approved")}>Approve once</button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      <div className="run-list">
        {runs.slice(0, 8).map((run) => (
          <article className="run-card" key={run.id}>
            <div className="run-title"><i className={`run-dot ${run.status}`} /><strong>{run.title}</strong><span>{run.kind}</span></div>
            <p>{run.error ?? run.result ?? run.prompt ?? run.cwd}</p>
            <div className="run-meta"><span>{run.status.replaceAll("_", " ")}</span><span>{formatRelative(run.createdAt)}</span></div>
            {!["succeeded", "failed", "cancelled"].includes(run.status) ? (
              <button className="run-cancel" onClick={() => void cancelRun(run.id).then(onChange)}>Cancel</button>
            ) : null}
          </article>
        ))}
        {runs.length === 0 ? <div className="session-empty">No managed runs yet. Start one from Claude through MCP or with <code>pnpm cca run</code>.</div> : null}
      </div>
    </section>
  );
}

function NotificationInbox({ notifications, onChange }: { notifications: AssistantNotification[]; onChange: () => void }): React.JSX.Element | null {
  if (notifications.length === 0) return null;
  return <section className="notification-inbox">{notifications.map((notification) => (
    <article key={notification.id}>
      <div><strong>{notification.title}</strong>{notification.body ? <p>{notification.body}</p> : null}</div>
      <button onClick={() => void markNotificationRead(notification.id).then(onChange)}>Dismiss</button>
    </article>
  ))}</section>;
}

function AssistantTools({
  schedules, memories, memoryTags, defaultCwd, onChange,
}: { schedules: Schedule[]; memories: Memory[]; memoryTags: MemoryTag[]; defaultCwd: string; onChange: () => void }): React.JSX.Element {
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [agentTitle, setAgentTitle] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryBody, setMemoryBody] = useState("");
  const [memoryTagInput, setMemoryTagInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!cwd && defaultCwd) setCwd(defaultCwd); }, [cwd, defaultCwd]);
  const reminderSubmit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await createReminder({ title: reminderTitle, body: "", at: new Date(reminderAt).toISOString() }); setReminderTitle(""); setReminderAt(""); onChange(); }
    finally { setBusy(false); }
  };
  const agentSubmit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await startAgent({ title: agentTitle, prompt: agentPrompt, cwd }); setAgentTitle(""); setAgentPrompt(""); onChange(); }
    finally { setBusy(false); }
  };
  const memorySubmit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      await createMemory({
        title: memoryTitle,
        body: memoryBody,
        tags: memoryTagInput.split(",").map((item) => item.trim()).filter(Boolean),
      });
      setMemoryTitle(""); setMemoryBody(""); setMemoryTagInput(""); onChange();
    }
    finally { setBusy(false); }
  };
  return <section className="tools-grid">
    <details open><summary>New reminder <span>{schedules.filter((item) => item.enabled && item.actionKind === "reminder").length} scheduled</span></summary>
      <form onSubmit={(event) => void reminderSubmit(event)}><input placeholder="Reminder title" value={reminderTitle} onChange={(event) => setReminderTitle(event.target.value)} /><input type="datetime-local" value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} /><button className="primary" disabled={busy || !reminderTitle || !reminderAt}>Schedule</button></form>
    </details>
    <details><summary>Spin off Claude <span>managed run</span></summary>
      <form onSubmit={(event) => void agentSubmit(event)}><input placeholder="Run title" value={agentTitle} onChange={(event) => setAgentTitle(event.target.value)} /><textarea placeholder="What should Claude accomplish?" value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} /><input placeholder="Working directory" value={cwd} onChange={(event) => setCwd(event.target.value)} /><button className="primary" disabled={busy || !agentTitle || !agentPrompt || !cwd}>Start run</button></form>
    </details>
    <details><summary>Add memory <span>{memories.length} stored</span></summary>
      <form onSubmit={(event) => void memorySubmit(event)}><input placeholder="Memory title" value={memoryTitle} onChange={(event) => setMemoryTitle(event.target.value)} /><textarea placeholder="What should the assistant remember?" value={memoryBody} onChange={(event) => setMemoryBody(event.target.value)} /><input placeholder="Tags, comma separated" list="memory-tag-options" value={memoryTagInput} onChange={(event) => setMemoryTagInput(event.target.value)} /><button className="primary" disabled={busy || !memoryTitle || !memoryBody}>Remember</button></form>
      <div className="memory-peek">{memories.slice(0, 3).map((memory) => <span key={memory.id}>{memory.title}</span>)}</div>
      <datalist id="memory-tag-options">{memoryTags.map(({ tag }) => <option value={tag} key={tag} />)}</datalist>
    </details>
  </section>;
}

function WikiBody({ body, onNavigate }: { body: string; onNavigate: (slug: string) => void }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  const pattern = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) parts.push(body.slice(cursor, index));
    const target = match[1]?.trim() ?? "";
    const slug = target.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "memory";
    parts.push(<button className="wiki-link" key={`${index}-${slug}`} onClick={() => onNavigate(slug)}>{match[2]?.trim() || target}</button>);
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));
  return <div className="memory-body">{parts}</div>;
}

function MemoryWorkspace({ memories, memoryTags, onChange }: { memories: Memory[]; memoryTags: MemoryTag[]; onChange: () => void }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [results, setResults] = useState(memories);
  const [detail, setDetail] = useState<MemoryDetail>();
  const [history, setHistory] = useState<MemoryRevision[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", summary: "", body: "", kind: "note", tags: "", aliases: "", project: "" });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!query) setResults(memories.filter((memory) =>
      (includeArchived || memory.status === "active") && (!tagFilter || memory.tags.includes(tagFilter)),
    ));
  }, [memories, query, tagFilter, includeArchived]);

  const open = async (idOrSlug: string): Promise<void> => {
    setBusy(true); setError(undefined);
    try {
      const next = await getMemory(idOrSlug);
      setDetail(next);
      setDraft({
        title: next.memory.title, summary: next.memory.summary ?? "", body: next.memory.body,
        kind: next.memory.kind, tags: next.memory.tags.join(", "), aliases: next.memory.aliases.join(", "),
        project: next.memory.project ?? "",
      });
      setEditing(false); setHistory([]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open memory"); }
    finally { setBusy(false); }
  };

  const search = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { setResults(await listMemories({ query, includeArchived, ...(tagFilter ? { tag: tagFilter } : {}) })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Search failed"); }
    finally { setBusy(false); }
  };

  const selectTag = async (tag: string): Promise<void> => {
    setTagFilter(tag); setQuery(""); setBusy(true); setError(undefined);
    try { setResults(await listMemories({ includeArchived, tag })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Tag filter failed"); }
    finally { setBusy(false); }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!detail) return;
    setBusy(true); setError(undefined);
    try {
      const next = await updateMemory(detail.memory.id, {
        title: draft.title, summary: draft.summary || null, body: draft.body, kind: draft.kind,
        tags: draft.tags.split(",").map((item) => item.trim()).filter(Boolean),
        aliases: draft.aliases.split(",").map((item) => item.trim()).filter(Boolean),
        project: draft.project || null, expectedRevision: detail.memory.revision,
      });
      setDetail(next); setEditing(false); onChange();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Save failed"); }
    finally { setBusy(false); }
  };

  const archive = async (): Promise<void> => {
    if (!detail) return;
    setBusy(true); setError(undefined);
    try {
      const next = await updateMemory(detail.memory.id, { status: "archived", expectedRevision: detail.memory.revision });
      setDetail(next); onChange();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Archive failed"); }
    finally { setBusy(false); }
  };

  const loadHistory = async (): Promise<void> => {
    if (!detail) return;
    setBusy(true);
    try { setHistory(await listMemoryRevisions(detail.memory.id)); }
    finally { setBusy(false); }
  };

  return <section className="memory-workspace">
    <div className="section-heading"><div><p className="eyebrow">Local knowledge</p><h2>Memory wiki</h2></div><span>{memories.length} active pages</span></div>
    <form className="memory-search" onSubmit={(event) => void search(event)}>
      <input aria-label="Search memories" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, aliases, summaries, body, and tags" />
      <select aria-label="Filter memories by tag" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
        <option value="">All tags</option>
        {memoryTags.map(({ tag, count }) => <option value={tag} key={tag}>{tag} ({count})</option>)}
      </select>
      <label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Archived</label>
      <button disabled={busy}>Search</button>
    </form>
    {error ? <p className="error">{error}</p> : null}
    <div className="memory-layout">
      <nav className="memory-results" aria-label="Memory pages">
        {results.map((memory) => <button className={detail?.memory.id === memory.id ? "selected" : ""} key={memory.id} onClick={() => void open(memory.id)}>
          <strong>{memory.title}</strong><span>{memory.kind} · rev {memory.revision}{memory.status === "archived" ? " · archived" : ""}</span>{memory.tags.length ? <small>{memory.tags.join(" · ")}</small> : null}
        </button>)}
        {results.length === 0 ? <p className="empty">No matching pages</p> : null}
      </nav>
      <article className="memory-page">
        {!detail ? <p className="memory-placeholder">Choose a page to read its links, backlinks, and revision history.</p> : editing ? (
          <form className="memory-editor" onSubmit={(event) => void save(event)}>
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} aria-label="Memory title" />
            <input value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="Summary" />
            <textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} aria-label="Memory body" />
            <div className="memory-fields"><input value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })} placeholder="Kind" /><input value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} placeholder="Project" /><input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="Tags, comma separated" /><input value={draft.aliases} onChange={(event) => setDraft({ ...draft, aliases: event.target.value })} placeholder="Aliases, comma separated" /></div>
            <div className="memory-actions"><button type="button" onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy || !draft.title}>Save revision</button></div>
          </form>
        ) : <>
          <div className="memory-page-heading"><div><p className="eyebrow">{detail.memory.kind} · {detail.memory.slug}</p><h3>{detail.memory.title}</h3></div><span>rev {detail.memory.revision}</span></div>
          {detail.memory.summary ? <p className="memory-summary">{detail.memory.summary}</p> : null}
          <WikiBody body={detail.memory.body} onNavigate={(slug) => void open(slug)} />
          <div className="memory-tags">{detail.memory.tags.map((tag) => <button key={tag} onClick={() => void selectTag(tag)}>{tag}</button>)}</div>
          <div className="memory-connections">
            <div><strong>Links</strong>{detail.outgoingLinks.map((link) => <button key={`${link.slug}-${link.label}`} className={!link.resolvedMemoryId ? "unresolved" : ""} onClick={() => void open(link.slug)}>{link.label}{!link.resolvedMemoryId ? " ?" : ""}</button>)}</div>
            <div><strong>Backlinks</strong>{detail.backlinks.map((link) => <button key={link.id} onClick={() => void open(link.id)}>{link.title}</button>)}</div>
          </div>
          <p className="memory-provenance">Captured {formatRelative(detail.memory.provenance.capturedAt)} from {detail.memory.provenance.sourceType}{detail.memory.provenance.sourceRef ? ` · ${detail.memory.provenance.sourceRef}` : ""}</p>
          <div className="memory-actions"><button onClick={() => setEditing(true)} disabled={detail.memory.status === "archived"}>Edit</button><button onClick={() => void loadHistory()}>History</button>{detail.memory.status === "active" ? <button onClick={() => void archive()}>Archive</button> : null}</div>
          {history.length ? <ol className="memory-history">{history.map((revision) => <li key={revision.revision}><strong>Revision {revision.revision}</strong><span>{new Date(revision.recordedAt).toLocaleString()}</span></li>)}</ol> : null}
        </>}
      </article>
    </div>
  </section>;
}

export default function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notifications, setNotifications] = useState<AssistantNotification[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryTags, setMemoryTags] = useState<MemoryTag[]>([]);
  const [defaultCwd, setDefaultCwd] = useState("");
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextTasks, nextSessions, nextRuns, nextApprovals, nextNotifications, nextSchedules, nextMemories, nextMemoryTags, config] = await Promise.all([
        listTasks(), listSessions(), listRuns(), listPendingApprovals(), listNotifications(), listSchedules(), listMemories(), listMemoryTags(), getConfig(),
      ]);
      setTasks(nextTasks);
      setSessions(nextSessions);
      setRuns(nextRuns);
      setApprovals(nextApprovals);
      setNotifications(nextNotifications);
      setSchedules(nextSchedules);
      setMemories(nextMemories);
      setMemoryTags(nextMemoryTags);
      setDefaultCwd(config.allowedRoots[0] ?? "");
      setAuthenticated(true);
      setError(undefined);
    } catch (caught) {
      if (caught instanceof AuthenticationError) setAuthenticated(false);
      else setError(caught instanceof Error ? caught.message : "Could not load tasks");
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  useEffect(() => {
    if (!authenticated) return;
    const events = new EventSource("/api/events/stream", { withCredentials: true });
    events.addEventListener("assistant-event", () => void refresh());
    return () => events.close();
  }, [authenticated, refresh]);

  const grouped = useMemo(() => {
    const groups: Record<TaskStatus, Task[]> = {
      inbox: [],
      planned: [],
      active: [],
      blocked: [],
      done: [],
      cancelled: [],
    };
    for (const task of tasks) groups[task.status].push(task);
    return groups;
  }, [tasks]);

  if (authenticated === undefined) return <main className="loading">Starting assistant…</main>;
  if (!authenticated) return <Login onAuthenticated={() => void refresh()} />;

  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">Personal workspace</p>
          <h1>What are we working on?</h1>
        </div>
        <div className="header-meta">
          <span className="live"><i /> Live</span>
          <button
            className="quiet"
            onClick={() => void logout().then(() => setAuthenticated(false))}
          >
            Lock
          </button>
        </div>
      </header>

      <NewTask onCreated={() => void refresh()} />
      {error ? <p className="error banner">{error}</p> : null}
      <NotificationInbox notifications={notifications} onChange={() => void refresh()} />

      <AssistantTools schedules={schedules} memories={memories} memoryTags={memoryTags} defaultCwd={defaultCwd} onChange={() => void refresh()} />

      <MemoryWorkspace memories={memories} memoryTags={memoryTags} onChange={() => void refresh()} />

      <SessionStrip sessions={sessions} />
      <ExecutionPanel runs={runs} approvals={approvals} onChange={() => void refresh()} />

      <section className="summary">
        <div><strong>{grouped.active.length}</strong><span>in focus</span></div>
        <div><strong>{grouped.inbox.length}</strong><span>in inbox</span></div>
        <div><strong>{grouped.blocked.length}</strong><span>blocked</span></div>
      </section>

      <section className="board">
        {visibleStatuses.map((status) => (
          <div className="lane" key={status}>
            <div className="lane-heading">
              <h2>{statusLabels[status]}</h2>
              <span>{grouped[status].length}</span>
            </div>
            <div className="task-list">
              {grouped[status].map((task) => (
                <TaskCard key={task.id} task={task} onChange={() => void refresh()} />
              ))}
              {grouped[status].length === 0 ? <p className="empty">Nothing here</p> : null}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
