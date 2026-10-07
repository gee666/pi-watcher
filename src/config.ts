import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "./runtime.ts";

export interface WatcherSettings {
  excludedExtensions: string[];
  sessionDir: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

/** A separate user settings file; never edits Pi's settings or model defaults. */
export function loadSettings(agentDir: string): WatcherSettings {
  const path = join(agentDir, "pi-watcher.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read ${path}: ${String(error)}`);
    }
    mkdirSync(agentDir, { recursive: true });
    raw = { excludedExtensions: [] };
    try {
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadSettings(agentDir);
      throw error;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected an object`);
  const excluded = raw.excludedExtensions ?? [];
  if (!Array.isArray(excluded) || excluded.some((x) => typeof x !== "string" || !x.trim())) {
    throw new Error(`${path}: excludedExtensions must be an array of nonempty strings`);
  }
  const model = raw.model as WatcherSettings["model"];
  if (model !== undefined && (!model || typeof model.provider !== "string" || !model.provider.trim() ||
    typeof model.modelId !== "string" || !model.modelId.trim())) {
    throw new Error(`${path}: model must contain provider and modelId`);
  }
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (raw.thinkingLevel !== undefined && !levels.includes(raw.thinkingLevel as string)) {
    throw new Error(`${path}: invalid thinkingLevel`);
  }
  if (raw.sessionDir !== undefined && (typeof raw.sessionDir !== "string" || !raw.sessionDir.trim())) {
    throw new Error(`${path}: sessionDir must be a nonempty path`);
  }
  const expandHome = (p: string) => p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  return {
    excludedExtensions: excluded.map((entry: string) => entry.startsWith(".") ? resolve(agentDir, entry) : entry),
    sessionDir: resolve(agentDir, expandHome(raw.sessionDir as string ?? "pi-watcher-sessions")),
    model,
    thinkingLevel: raw.thinkingLevel as ThinkingLevel | undefined,
  };
}
