import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DOCKER_WORKSPACE_PATH,
  getDefaultTelePiConfigPath,
  resolvePathFromCwd,
} from "./paths.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";

export interface TelePiConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  workspace: string;
  piSessionPath?: string;
  piModel?: string;
  toolVerbosity: ToolVerbosity;
  promptInboxDir?: string;
  promptInboxIntervalMs: number;
}

export type TelePiConfigPathSource = "explicit" | "default" | "cwd" | "missing";

export interface TelePiConfigPathInfo {
  explicitPath?: string;
  defaultPath: string;
  localPath: string;
  resolvedPath?: string;
  source: TelePiConfigPathSource;
}

const DEFAULT_PROMPT_INBOX_INTERVAL_MS = 60_000;
const MIN_PROMPT_INBOX_INTERVAL_MS = 1_000;

export function loadConfig(): TelePiConfig {
  const envPath = getConfigEnvPathInfo().resolvedPath;
  if (envPath) {
    loadEnvFile(envPath);
  }

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const workspace = resolveWorkspace();
  const piSessionPath = optionalString(process.env.PI_SESSION_PATH);
  const piModel = optionalString(process.env.PI_MODEL);
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const promptInboxDir = resolveOptionalPath(process.env.TELEPI_PROMPT_INBOX_DIR);
  const promptInboxIntervalMs = parsePromptInboxIntervalMs(optionalString(process.env.TELEPI_PROMPT_INBOX_INTERVAL_MS));

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    workspace,
    piSessionPath,
    piModel,
    toolVerbosity,
    promptInboxDir,
    promptInboxIntervalMs,
  };
}

export function getConfigEnvPathInfo(): TelePiConfigPathInfo {
  const explicitPath = optionalString(process.env.TELEPI_CONFIG);
  const resolvedExplicitPath = explicitPath ? resolvePathFromCwd(explicitPath) : undefined;
  const defaultPath = getDefaultTelePiConfigPath();
  const localPath = path.resolve(process.cwd(), ".env");

  if (resolvedExplicitPath) {
    return {
      explicitPath: resolvedExplicitPath,
      defaultPath,
      localPath,
      resolvedPath: resolvedExplicitPath,
      source: "explicit",
    };
  }

  if (existsSync(localPath)) {
    return {
      defaultPath,
      localPath,
      resolvedPath: localPath,
      source: "cwd",
    };
  }

  if (existsSync(defaultPath)) {
    return {
      defaultPath,
      localPath,
      resolvedPath: defaultPath,
      source: "default",
    };
  }

  return {
    defaultPath,
    localPath,
    source: "missing",
  };
}

/**
 * Workspace is derived automatically:
 * - In Docker: /workspace (the mount point)
 * - TELEPI_WORKSPACE when set outside Docker
 * - Otherwise: process.cwd() (same as running Pi normally)
 */
function resolveWorkspace(): string {
  if (isRunningInDocker()) {
    return DOCKER_WORKSPACE_PATH;
  }

  const overriddenWorkspace = optionalString(process.env.TELEPI_WORKSPACE);
  if (overriddenWorkspace) {
    return resolvePathFromCwd(overriddenWorkspace);
  }

  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  const normalized = optionalString(value);
  return normalized ? resolvePathFromCwd(normalized) : undefined;
}

function parsePromptInboxIntervalMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_PROMPT_INBOX_INTERVAL_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Invalid TELEPI_PROMPT_INBOX_INTERVAL_MS value: "${raw}". Falling back to ${DEFAULT_PROMPT_INBOX_INTERVAL_MS}ms.`
    );
    return DEFAULT_PROMPT_INBOX_INTERVAL_MS;
  }

  if (parsed < MIN_PROMPT_INBOX_INTERVAL_MS) {
    console.warn(
      `TELEPI_PROMPT_INBOX_INTERVAL_MS is below ${MIN_PROMPT_INBOX_INTERVAL_MS}ms. Clamping to ${MIN_PROMPT_INBOX_INTERVAL_MS}ms.`
    );
    return MIN_PROMPT_INBOX_INTERVAL_MS;
  }

  return parsed;
}

export function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`
      );
      return "summary";
  }
}
