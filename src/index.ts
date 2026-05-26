import { createBot, registerCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { isEntrypoint } from "./entrypoint.js";
import { PiSessionRegistry } from "./pi-session.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;

function loadSessionMapping(): Map<string, string> {
  const mappingPath = path.join(homedir(), ".local/state/telepi/session-mapping.json");
  if (!existsSync(mappingPath)) {
    return new Map();
  }
  try {
    const data = JSON.parse(readFileSync(mappingPath, "utf8"));
    return new Map(Object.entries(data));
  } catch (error) {
    console.error("Failed to parse session mapping:", error);
    return new Map();
  }
}

function saveSessionMapping(mapping: Map<string, string>): void {
  const stateDir = path.join(homedir(), ".local/state/telepi");
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const mappingPath = path.join(stateDir, "session-mapping.json");
  try {
    const data = Object.fromEntries(mapping);
    writeFileSync(mappingPath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save session mapping:", error);
  }
}

export async function startBot(): Promise<void> {
  let sessionRegistry: PiSessionRegistry | undefined;
  let bot: ReturnType<typeof createBot> | undefined;
  let shuttingDown = false;
  let restartAttempts = 0;

  try {
    const config = loadConfig();
    const savedSessionPaths = loadSessionMapping();
    sessionRegistry = await PiSessionRegistry.create(config, savedSessionPaths, (key, sessionPath) => {
      if (sessionPath) {
        savedSessionPaths.set(key, sessionPath);
        saveSessionMapping(savedSessionPaths);
      }
    });
    bot = createBot(config, sessionRegistry);
    await registerCommands(bot);

    console.log("TelePi running");
    console.log(`Default workspace: ${config.workspace}`);
    if (config.piSessionPath) {
      console.log(`Bootstrap session: ${config.piSessionPath}`);
    }
  } catch (error) {
    sessionRegistry?.dispose();
    throw error;
  }

  const disposeSessions = () => {
    sessionRegistry?.dispose();
    sessionRegistry = undefined;
  };

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(`Received ${signal}, shutting down TelePi...`);
    bot?.stop();

    setTimeout(() => {
      disposeSessions();
      console.log("TelePi stopped.");
    }, 500);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  async function startPolling(): Promise<void> {
    try {
      await bot!.start({
        drop_pending_updates: true,
        onStart: () => {
          restartAttempts = 0;
        },
      });
    } catch (error) {
      if (shuttingDown) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const is409 = message.includes("409") || message.includes("Conflict");

      if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts++;
        console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
        console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
        return startPolling();
      }

      disposeSessions();
      throw error;
    }
  }

  try {
    await startPolling();
  } finally {
    if (!shuttingDown) {
      disposeSessions();
    }
  }
}

async function runMain(): Promise<void> {
  try {
    await startBot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start TelePi: ${message}`);
    process.exit(1);
  }
}

if (isEntrypoint(import.meta.url)) {
  await runMain();
}
