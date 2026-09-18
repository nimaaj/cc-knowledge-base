import { ProposeCommandSchema, StartAgentRunSchema, type Schedule } from "@cc-assistant/shared";
import { AssistantRepository } from "./assistant-repository.js";
import type { DaemonConfig } from "./config.js";
import { ExecutionService } from "./execution-service.js";
import { NativeService } from "./native-service.js";

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function interpolate(value: string, input: Record<string, unknown>): string {
  return value.replaceAll(/\$\{input\.([a-zA-Z0-9_-]+)\}/g, (_match, key: string) => {
    const replacement = input[key];
    if (replacement === undefined) throw new Error(`Missing ability input: ${key}`);
    return typeof replacement === "string" ? replacement : JSON.stringify(replacement);
  });
}

function validateAbilityInput(schema: Record<string, unknown>, input: Record<string, unknown>): void {
  if (schema.type !== undefined && schema.type !== "object") throw new Error("Ability inputSchema root type must be object");
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const name of required) if (!(name in input)) throw new Error(`Missing required ability input: ${name}`);
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
  if (schema.additionalProperties === false) {
    const extra = Object.keys(input).filter((name) => !(name in properties));
    if (extra.length) throw new Error(`Unknown ability input: ${extra.join(", ")}`);
  }
  for (const [name, value] of Object.entries(input)) {
    const expected = properties[name]?.type;
    if (!expected) continue;
    const valid = expected === "integer" ? Number.isInteger(value) :
      expected === "array" ? Array.isArray(value) :
      expected === "object" ? typeof value === "object" && value !== null && !Array.isArray(value) :
      typeof value === expected;
    if (!valid) throw new Error(`Ability input ${name} must be ${String(expected)}`);
  }
}

export class AutomationService {
  readonly #repository: AssistantRepository;
  readonly #execution: ExecutionService;
  readonly #native: NativeService;
  readonly #config: DaemonConfig;
  #timer?: NodeJS.Timeout;
  readonly #firing = new Set<string>();

  constructor(repository: AssistantRepository, execution: ExecutionService, native: NativeService, config: DaemonConfig) {
    this.#repository = repository;
    this.#execution = execution;
    this.#native = native;
    this.#config = config;
  }

  start(): void {
    this.#timer = setInterval(() => void this.tick(), 1_000);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); }

  async tick(): Promise<void> {
    for (const schedule of this.#repository.dueSchedules()) await this.#fire(schedule);
  }

  async ingestSystemNotification(input: { app?: string | undefined; title?: string | undefined; body?: string | undefined }): Promise<Schedule[]> {
    const matches = this.#repository.matchingNotificationSchedules(input);
    for (const schedule of matches) await this.#fire(schedule);
    return matches;
  }

  invokeAbility(id: string, input: Record<string, unknown>, taskId?: string | null) {
    const manifest = this.#repository.getAbility(id);
    if (!manifest) throw new Error(`Ability ${id} was not found`);
    validateAbilityInput(manifest.inputSchema, input);
    const execution = manifest.execution;
    return this.#execution.proposeCommand(ProposeCommandSchema.parse({
      taskId, title: manifest.name, executable: interpolate(execution.executable, input),
      args: execution.args.map((arg) => interpolate(arg, input)),
      cwd: execution.cwd ? interpolate(execution.cwd, input) : (this.#config.allowedRoots[0] ?? process.cwd()),
      timeoutMs: execution.timeoutMs,
    }));
  }

  async #fire(schedule: Schedule): Promise<void> {
    if (this.#firing.has(schedule.id)) return;
    this.#firing.add(schedule.id);
    const ranAt = new Date().toISOString();
    try {
      if (schedule.actionKind === "reminder") {
        const title = stringField(schedule.action.title, "action.title");
        const body = typeof schedule.action.body === "string" ? schedule.action.body : "";
        this.#repository.createNotification(title, body, `schedule:${schedule.id}`);
        try { await this.#native.notify(title, body); } catch { /* The web inbox remains authoritative. */ }
      } else if (schedule.actionKind === "agent") {
        this.#execution.startAgent(StartAgentRunSchema.parse(schedule.action));
      } else if (schedule.actionKind === "command") {
        this.#execution.proposeCommand(ProposeCommandSchema.parse(schedule.action));
      } else if (schedule.actionKind === "ability") {
        this.invokeAbility(stringField(schedule.action.abilityId, "action.abilityId"),
          (schedule.action.input ?? {}) as Record<string, unknown>,
          typeof schedule.action.taskId === "string" ? schedule.action.taskId : undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#repository.createNotification(`Automation failed: ${schedule.name}`, message, `schedule:${schedule.id}`);
    } finally {
      this.#repository.markScheduleRun(schedule.id, ranAt);
      this.#firing.delete(schedule.id);
    }
  }
}
