/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { RuntimeLogDoc, RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

export const RUNTIME_LOG_PAGE_SIZE = 20;
const DAY_MS = 86_400_000;
const LOG_FILE = /^runtime-\d{4}-\d{2}-\d{2}\.jsonl$/;

// Shared across Next bundles and development reloads: never wrap streams twice.
const state = globalThis as typeof globalThis & {
  messengerRuntimeLogs?: {
    stdout: typeof process.stdout.write;
    stderr: typeof process.stderr.write;
    pending: Promise<void>;
    cleanupDay?: string;
  };
};

function logDirectory(): string {
  return resolve(process.env.RUNTIME_LOG_DIR || "logs");
}

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return String(item);
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack, cause: item.cause };
    }
    return item;
  });
}

function enqueue(doc: RuntimeLogDoc, line = serialize(doc) + "\n"): Promise<void> {
  const capture = state.messengerRuntimeLogs!;
  const directory = logDirectory();
  capture.pending = capture.pending.then(async () => {
    await mkdir(directory, { recursive: true });
    const day = new Date(doc.createdAt).toISOString().slice(0, 10);
    await appendFile(join(directory, `runtime-${day}.jsonl`), line, { mode: 0o600 });
    if (capture.cleanupDay !== day) {
      const cutoff = new Date(doc.createdAt - 30 * DAY_MS).toISOString().slice(0, 10);
      for (const file of await readdir(directory)) {
        if (LOG_FILE.test(file) && file.slice(8, 18) < cutoff) {
          await unlink(join(directory, file)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
      capture.cleanupDay = day;
    }
  }).catch((error) => {
    // Raw writer bypasses capture, including when the directory is unwritable.
    capture.stderr(`[runtime-logs] Unable to write log file: ${String(error)}\n`);
  });
  return capture.pending;
}

function document(input: RuntimeLogInput): RuntimeLogDoc {
  return {
    _id: randomUUID(),
    ...input,
    method: input.method ?? null,
    path: input.path ?? null,
    status: input.status ?? null,
    details: input.details ?? null,
    createdAt: Date.now(),
  };
}

/** Mirror Node stream writes (including direct writes) without changing callbacks/backpressure. */
export function installOutputCapture(): void {
  if (state.messengerRuntimeLogs) return;
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  state.messengerRuntimeLogs = { stdout, stderr, pending: Promise.resolve() };
  for (const [stream, original, level] of [
    [process.stdout, stdout, "info"],
    [process.stderr, stderr, "error"],
  ] as const) {
    const decoder = new StringDecoder("utf8");
    stream.write = function (...args: Parameters<typeof stream.write>) {
      const result = Reflect.apply(original, stream, args) as boolean;
      try {
        const chunk = args[0];
        const message = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
        if (message) void enqueue(document({ level, source: "api", message: message.trimEnd() }));
      } catch (error) {
        stderr(`[runtime-logs] Unable to capture output: ${String(error)}\n`);
      }
      return result;
    } as typeof stream.write;
  }
}

export interface RuntimeLogListOptions {
  /** 时间范围下界（毫秒）；`createdAt >= sinceTs` 用于文件内容过滤。 */
  sinceTs?: number;
  /** 时间范围上界（毫秒，开区间）：`createdAt < untilTs`。 */
  untilTs?: number;
  /** 按级别过滤（error/warn/info）；省略取全部。 */
  level?: RuntimeLogLevel;
  /** 按来源过滤（api/relay/storage/migration）；省略取全部。 */
  source?: RuntimeLogSource;
  /** 从 1 开始的页码。 */
  page?: number;
  /** 覆盖默认页大小；上限 200，下限 1。 */
  limit?: number;
}

export interface RuntimeLogListPage {
  logs: RuntimeLogDoc[];
  /** 所选范围内符合过滤的日志总数。 */
  total: number;
  /** 当前页码（从 1 开始）。 */
  page: number;
  /** 实际生效的页大小。 */
  pageSize: number;
}

export interface RuntimeLogInput {
  level: RuntimeLogLevel;
  source: RuntimeLogSource;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  message: string;
  details?: unknown;
}

/** Structured events go to stdout/stderr and the same file sink exactly once. */
export async function recordRuntimeLog(input: RuntimeLogInput): Promise<void> {
  installOutputCapture();
  const capture = state.messengerRuntimeLogs!;
  try {
    const doc = document(input);
    const line = serialize(doc) + "\n";
    (input.level === "info" ? capture.stdout : capture.stderr)(line);
    await enqueue(doc, line);
  } catch (error) {
    capture.stderr(`[runtime-logs] Unable to serialize log: ${String(error)}\n`);
  }
}

export function createLogger(source: RuntimeLogSource) {
  return {
    info: (message: string, details?: unknown) => void recordRuntimeLog({ level: "info", source, message, details }),
    warn: (message: string, details?: unknown) => void recordRuntimeLog({ level: "warn", source, message, details }),
    error: (message: string, details?: unknown) => void recordRuntimeLog({ level: "error", source, message, details }),
  };
}

/** Stream files; skip incomplete/corrupt records, but surface filesystem failures. */
async function* readLogs(files: { path: string; size: number }[], options: RuntimeLogListOptions) {
  for (const file of files) {
    if (!file.size) continue;
    const lines = createInterface({ input: createReadStream(file.path, { end: file.size - 1 }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let doc: RuntimeLogDoc;
        try { doc = JSON.parse(line) as RuntimeLogDoc; } catch { continue; }
        if (!doc || typeof doc._id !== "string" || typeof doc.message !== "string" ||
            !Number.isFinite(doc.createdAt) ||
            !["info", "warn", "error"].includes(doc.level)) continue;
        if (options.sinceTs !== undefined && doc.createdAt < options.sinceTs) continue;
        if (options.untilTs !== undefined && doc.createdAt >= options.untilTs) continue;
        if (options.level && doc.level !== options.level) continue;
        if (options.source && doc.source !== options.source) continue;
        yield doc;
      }
    } catch (error) {
      // Retention or external rotation may remove a file between listing/opening.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      lines.close();
    }
  }
}

export async function listRuntimeLogs(options: RuntimeLogListOptions = {}): Promise<RuntimeLogListPage> {
  await state.messengerRuntimeLogs?.pending;
  const pageSize = Number.isFinite(options.limit)
    ? Math.min(Math.max(Math.floor(options.limit!), 1), 200) : RUNTIME_LOG_PAGE_SIZE;
  const requestedPage = Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page!)) : 1;
  const directory = logDirectory();
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => {
      if (!LOG_FILE.test(file)) return false;
      const start = Date.parse(file.slice(8, 18));
      return (options.sinceTs === undefined || start + DAY_MS > options.sinceTs) &&
        (options.untilTs === undefined || start < options.untilTs);
    }).sort().reverse().map((file) => join(directory, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  // Freeze byte boundaries so appends between the count and page scans do not shift results.
  const snapshots = await Promise.all(files.map(async (path) => {
    try { return { path, size: (await stat(path)).size }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path, size: 0 };
    }
  }));
  let total = 0;
  for await (const _doc of readLogs(snapshots, options)) { void _doc; total++; }
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const offset = (page - 1) * pageSize;
  // Only keep the newest page*size matches, rather than loading all file contents.
  const selected: RuntimeLogDoc[] = [];
  const compare = (a: RuntimeLogDoc, b: RuntimeLogDoc) => b.createdAt - a.createdAt || b._id.localeCompare(a._id);
  for await (const doc of readLogs(snapshots, options)) {
    let lo = 0, hi = selected.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(selected[mid], doc) <= 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo < offset + pageSize) {
      selected.splice(lo, 0, doc);
      if (selected.length > offset + pageSize) selected.pop();
    }
  }
  return { logs: selected.slice(offset), total, page, pageSize };
}
