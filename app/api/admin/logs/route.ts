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

import { requireAdminUser } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { listRuntimeLogs } from "@/lib/runtime-logs";
import type { RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

export const runtime = "nodejs";

const LEVELS: RuntimeLogLevel[] = ["error", "warn", "info"];
const SOURCES: RuntimeLogSource[] = [
  "api",
  "relay",
  "auth",
  "billing",
  "admin",
  "sync",
  "market",
  "avatar",
  "storage",
  "migration",
];

/** 管理后台「日志页」列表：按级别/来源/时间范围筛选 + 偏移分页。 */
export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const params = new URL(request.url).searchParams;
  const levelParam = params.get("level");
  const sourceParam = params.get("source");
  const level = levelParam ? LEVELS.find((value) => value === levelParam) : undefined;
  if (levelParam && !level) {
    return jsonError("Invalid log level filter.", 400);
  }
  const source = sourceParam ? SOURCES.find((value) => value === sourceParam) : undefined;
  if (sourceParam && !source) {
    return jsonError("Invalid log source filter.", 400);
  }

  const page = await listRuntimeLogs({
    level,
    source,
    page: Number(params.get("page")) || undefined,
    limit: Number(params.get("limit")) || undefined,
    sinceTs: parseEpochMs(params.get("since")),
    untilTs: parseEpochMs(params.get("until")),
  });
  return jsonOk(page);
}

/** 把查询串里的 epoch 毫秒解析为 number；非法/缺失返回 undefined。 */
function parseEpochMs(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
