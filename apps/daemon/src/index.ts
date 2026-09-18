import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

const stop = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Stopping daemon");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
console.log(`cc-assistant daemon listening at http://${config.host}:${config.port}`);
console.log(`Access token: ${config.accessTokenPath}`);
