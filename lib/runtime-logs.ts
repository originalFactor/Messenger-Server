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
import { type Filter } from "mongodb";
import { getDb } from "@/lib/mongo";
import type { RuntimeLogDoc, RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

/**
 * 未被包装的原始 `console.error` 引用：instrumentation 在 install 时回填，
 * 供 `recordRuntimeLog` 失败兜底用。绕开包装器本身，避免采集层故障再次
 * 触发捕获形成递归。回填前为 null，此时退回当前 `console.error`（启动
 * 早期、包装器尚未安装时）。
 */
let rawStderr: typeof console.error | null = null;

/** 供 instrumentation 回填未被包装的原始 `console.error`。 */
export function bindRawConsole(stderr: typeof console.error): void {
  rawStderr = stderr;
}

/** 运行时日志页每页条数（管理后台「日志页」明细表分页大小）。 */
export const RUNTIME_LOG_PAGE_SIZE = 20;

export interface RuntimeLogListOptions {
  /** 时间范围下界（毫秒）；`createdAt >= sinceTs` 复用前缀索引。 */
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

/**
 * 写入一条运行时日志。fire-and-forget 失败不影响调用方：日志采集不应
 * 阻断业务路径或抛二次异常。失败时退回未被包装的原始 `console.error`，
 * 保证至少有 stderr 且不触发捕获递归（`capturing` 由包装器在写前置位）。
 */
export async function recordRuntimeLog(input: RuntimeLogInput): Promise<void> {
  const doc: RuntimeLogDoc = {
    _id: randomUUID(),
    level: input.level,
    source: input.source,
    method: input.method ?? null,
    path: input.path ?? null,
    status: input.status ?? null,
    message: input.message,
    details: input.details,
    createdAt: Date.now(),
  };
  try {
    const db = await getDb();
    await db.collection<RuntimeLogDoc>("runtime_logs").insertOne(doc);
  } catch (error) {
    // 采集层故障不得影响业务路径；退回原始 stderr 兜底，绕开包装器递归。
    const report = rawStderr ?? console.error.bind(console);
    report("[runtime-logs] Unable to persist runtime log.", { input, error });
  }
}

/**
 * 业务事件日志快捷构造器：固定 source，简化各业务域调用点的样板。
 * 返回 fire-and-forget 的 Promise，调用方 `void` 即可，不阻断业务路径。
 * `message` 为人读摘要；`details` 携带结构化上下文（userId/entityId/等），
 * 入库后供「日志页」查阅与按域筛选。每域一个实例，避免重复传 source。
 */
export function createLogger(source: RuntimeLogSource) {
  return {
    info: (message: string, details?: unknown) => void recordRuntimeLog({ level: "info", source, message, details }),
    warn: (message: string, details?: unknown) => void recordRuntimeLog({ level: "warn", source, message, details }),
    error: (message: string, details?: unknown) => void recordRuntimeLog({ level: "error", source, message, details }),
  };
}

/**
 * 管理后台「日志页」数据源。按 `(createdAt, _id)` 倒序做偏移分页，
 * 复用 `runtime_logs` 的 `{ createdAt: -1, _id: -1 }` 前缀索引：前缀
 * `createdAt` 同时服务范围过滤、级别/来源等值匹配、计数与倒序扫描。
 */
export async function listRuntimeLogs(
  options: RuntimeLogListOptions = {},
): Promise<RuntimeLogListPage> {
  const db = await getDb();
  const pageSize = Math.min(Math.max(options.limit ?? RUNTIME_LOG_PAGE_SIZE, 1), 200);
  const createdAt: Record<string, number> = {};
  if (typeof options.sinceTs === "number") {
    createdAt.$gte = options.sinceTs;
  }
  if (typeof options.untilTs === "number") {
    createdAt.$lt = options.untilTs;
  }
  const filter: Filter<RuntimeLogDoc> = {};
  if (Object.keys(createdAt).length > 0) {
    filter.createdAt = createdAt;
  }
  if (options.level) {
    filter.level = options.level;
  }
  if (options.source) {
    filter.source = options.source;
  }
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));

  const [total, logs] = await Promise.all([
    db.collection<RuntimeLogDoc>("runtime_logs").countDocuments(filter),
    db.collection<RuntimeLogDoc>("runtime_logs")
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((requestedPage - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
  ]);

  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const page = Math.min(requestedPage, totalPages);
  return { logs, total, page, pageSize };
}
