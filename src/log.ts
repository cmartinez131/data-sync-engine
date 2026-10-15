// Plain-text logs under logs/, one JSON object per line, one file per concern:
//   sync.log   - every poll of every feed: counts, or the error
//   updates.log - every report that was stored: which feed, which fight, and the numbers
//   api.log    - every HTTP request to our API
//   world.log  - what happened in the pretend fight: starts, round ends, finishes
//   errors.log - a copy of every line above that has level "error"
// Nothing is written until initLogs() runs, so tests stay silent.
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";

export type LogFile = "sync" | "updates" | "api" | "world";
const ALL_FILES = ["sync", "updates", "api", "world", "errors"];

let dir: string | null = null;

// Create the folder, remove any old .log files, and start every file empty. Call once at startup.
export function initLogs(path: string): void {
  mkdirSync(path, { recursive: true });
  for (const old of readdirSync(path)) if (old.endsWith(".log")) unlinkSync(join(path, old));
  for (const name of ALL_FILES) writeFileSync(join(path, `${name}.log`), "");
  dir = path;
}

// Append one line. Fields with level "error" are also copied into errors.log.
export function logEvent(file: LogFile, fields: Record<string, unknown>): void {
  if (dir === null) return;
  const ts = new Date().toISOString();
  appendFileSync(join(dir, `${file}.log`), JSON.stringify({ ts, ...fields }) + "\n");
  if (fields.level === "error") {
    appendFileSync(join(dir, "errors.log"), JSON.stringify({ ts, log: file, ...fields }) + "\n");
  }
}

// Express middleware: one api.log line per request, written when the response finishes.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on("finish", () => {
    logEvent("api", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - started,
      level: res.statusCode >= 500 ? "error" : undefined,
    });
  });
  next();
}
