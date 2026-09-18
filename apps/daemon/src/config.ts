import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export interface DaemonConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  accessToken: string;
  accessTokenPath: string;
  allowedRoots: string[];
}

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "cc-assistant");
  }

  return join(homedir(), ".local", "share", "cc-assistant");
}

function loadOrCreateToken(tokenPath: string): string {
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const dataDir = resolve(env.CC_ASSISTANT_DATA_DIR ?? defaultDataDir());
  const accessTokenPath = join(dataDir, "access-token");
  const port = Number.parseInt(env.CC_ASSISTANT_PORT ?? "4317", 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CC_ASSISTANT_PORT must be a valid TCP port");
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const allowedRoots = (env.CC_ASSISTANT_ALLOWED_ROOTS ?? env.INIT_CWD ?? process.cwd())
    .split(delimiter)
    .filter(Boolean)
    .map((root) => resolve(root));

  return {
    host: env.CC_ASSISTANT_HOST ?? "127.0.0.1",
    port,
    dataDir,
    databasePath: join(dataDir, "assistant.sqlite"),
    accessToken: env.CC_ASSISTANT_TOKEN ?? loadOrCreateToken(accessTokenPath),
    accessTokenPath,
    allowedRoots,
  };
}
