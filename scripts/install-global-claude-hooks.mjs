import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const remove = process.argv.includes("--remove");
const projectRoot = resolve(import.meta.dirname, "..");
const settingsPath = join(homedir(), ".claude", "settings.json");
const hookScript = join(projectRoot, "scripts", "claude-hook.mjs");
const dataDir = join(projectRoot, ".data");
const marker = "cc-assistant/scripts/claude-hook.mjs";
const command = `CC_ASSISTANT_DATA_DIR=${JSON.stringify(dataDir)} node ${JSON.stringify(hookScript)}`;
const eventNames = [
  "SessionStart", "UserPromptSubmit", "PermissionRequest", "Notification",
  "SubagentStart", "SubagentStop", "Stop", "StopFailure", "SessionEnd",
];

let settings = {};
try { settings = JSON.parse(await readFile(settingsPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
settings.hooks ??= {};

for (const eventName of eventNames) {
  const entries = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  const filtered = entries.filter((entry) => !JSON.stringify(entry).includes(marker));
  if (!remove) filtered.push({ hooks: [{ type: "command", command, timeout: 3 }] });
  if (filtered.length) settings.hooks[eventName] = filtered;
  else delete settings.hooks[eventName];
}

await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
try { await copyFile(settingsPath, `${settingsPath}.cc-assistant-backup`); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const temporary = `${settingsPath}.cc-assistant-tmp`;
await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, settingsPath);
console.log(`${remove ? "Removed" : "Installed"} cc-assistant hooks in ${settingsPath}`);
