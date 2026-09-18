import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const projectRoot = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const dataDir = process.env.CC_ASSISTANT_DATA_DIR
    ? resolve(projectRoot, process.env.CC_ASSISTANT_DATA_DIR)
    : resolve(projectRoot, ".data");
  const token = (await readFile(resolve(dataDir, "access-token"), "utf8")).trim();
  const input = await readStdin();

  await fetch("http://127.0.0.1:4317/api/hooks/claude", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-CC-Assistant-Source": "claude-hook",
    },
    body: input,
    signal: AbortSignal.timeout(1_500),
  });
} catch {
  // Session observation is best effort and must never interrupt Claude Code.
}
