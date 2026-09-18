import { spawn } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, ["apps/mcp/dist/index.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CC_ASSISTANT_DATA_DIR: resolve(projectRoot, ".data"),
    CC_ASSISTANT_DAEMON_URL: "http://127.0.0.1:4317",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let buffer = "";
let stderr = "";
const pending = new Map();

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. MCP stderr: ${stderr}`));
    }, 5_000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolvePromise(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cc-assistant-smoke", version: "0.1.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await request("tools/list");
  const listed = await request("tools/call", { name: "task_list", arguments: {} });
  console.log(
    JSON.stringify({
      tools: tools.tools.map((tool) => tool.name),
      taskCount: listed.structuredContent.tasks.length,
    }),
  );
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}
