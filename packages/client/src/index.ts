import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "cc-assistant");
  }
  return join(homedir(), ".local", "share", "cc-assistant");
}

export interface DaemonClientOptions {
  baseUrl?: string;
  token?: string;
  dataDir?: string;
  source?: string;
}

function loadToken(dataDir: string): string {
  const tokenPath = join(dataDir, "access-token");
  try {
    return readFileSync(tokenPath, "utf8").trim();
  } catch {
    throw new Error(
      `Cannot read the assistant access token at ${tokenPath}. Start the daemon first or set CC_ASSISTANT_TOKEN.`,
    );
  }
}

export class DaemonClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #source: string;

  constructor(options: DaemonClientOptions = {}) {
    const dataDir = resolve(
      options.dataDir ?? process.env.CC_ASSISTANT_DATA_DIR ?? defaultDataDir(),
    );
    this.#baseUrl =
      options.baseUrl ?? process.env.CC_ASSISTANT_DAEMON_URL ?? "http://127.0.0.1:4317";
    this.#token = options.token ?? process.env.CC_ASSISTANT_TOKEN ?? loadToken(dataDir);
    this.#source = options.source ?? "client";
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          "X-CC-Assistant-Source": this.#source,
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(
        `The cc-assistant daemon is unavailable at ${this.#baseUrl}. Start it before using the client.`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { message?: string; details?: unknown }
        | undefined;
      const message = body?.message ?? `Daemon request failed with HTTP ${response.status}`;
      throw new Error(body?.details ? `${message}: ${JSON.stringify(body.details)}` : message);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
