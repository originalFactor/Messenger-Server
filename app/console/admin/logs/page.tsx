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

import { redirect } from "next/navigation";
import { LogsTable } from "@/components/admin/logs-table";
import { LogsFilterBar } from "@/components/admin/logs-filter-bar";
import { requireAdminUser } from "@/lib/auth";
import { listRuntimeLogs } from "@/lib/runtime-logs";
import type { RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

export const dynamic = "force-dynamic";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const RANGE_OPTIONS = [
  { value: "24h", label: "近 24 小时", windowMs: DAY_MS },
  { value: "7d", label: "近 7 天", windowMs: 7 * DAY_MS },
  { value: "30d", label: "近 30 天", windowMs: 30 * DAY_MS },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]["value"];

/**
 * 把 `YYYY-MM-DD` 解释为服务器本地时区的当天 00:00 毫秒。用 `new Date(s)`
 * 会被当成 UTC 午夜导致跨时区偏移，所以显式取 y/m/d 构造本地 Date。
 * 非法格式返回 `null`，由调用方回退到默认范围。
 */
function parseLocalMidnight(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

interface ResolvedRange {
  sinceTs?: number;
  untilTs?: number;
  activeRange: RangeValue | "custom";
  from?: string;
  to?: string;
}

/**
 * 解析 URL 时间范围参数。`from`/`to` 任一存在即自定义区间（缺失侧无界）；
 * 否则回落到 `range` 预设，非法再回落 `24h`。from > to 视为非法整体回退。
 */
function resolveRange(
  range: string | undefined,
  from: string | undefined,
  to: string | undefined,
): ResolvedRange {
  const fromMs = parseLocalMidnight(from);
  const toMs = parseLocalMidnight(to);

  if (fromMs !== null || toMs !== null) {
    if (fromMs !== null && toMs !== null && fromMs > toMs) {
      const option = RANGE_OPTIONS[0];
      return { sinceTs: Date.now() - option.windowMs, activeRange: option.value, from, to };
    }
    const untilTs = toMs === null ? undefined : toMs + DAY_MS;
    return { sinceTs: fromMs ?? undefined, untilTs, activeRange: "custom", from, to };
  }

  const match = RANGE_OPTIONS.find((option) => option.value === range);
  const option = match ?? RANGE_OPTIONS[0];
  return { sinceTs: Date.now() - option.windowMs, activeRange: option.value };
}

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

export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    level?: string;
    source?: string;
    page?: string;
  }>;
}) {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/console");
  }

  const params = await searchParams;
  const { sinceTs, untilTs, activeRange, from, to } = resolveRange(params.range, params.from, params.to);

  const levelParam = params.level;
  const level = levelParam ? LEVELS.find((value) => value === levelParam) : undefined;
  const sourceParam = params.source;
  const source = sourceParam ? SOURCES.find((value) => value === sourceParam) : undefined;

  const pageParam = Number(params.page ?? "1");
  const requestedPage = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;
  const { logs, total, page, pageSize } = await listRuntimeLogs({
    sinceTs,
    untilTs,
    level,
    source,
    page: requestedPage,
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">系统日志</h1>
        <LogsFilterBar
          key={`${activeRange}:${from ?? ""}:${to ?? ""}:${level ?? ""}:${source ?? ""}`}
          activeRange={activeRange}
          activeLevel={level ?? null}
          activeSource={source ?? null}
          from={from}
          to={to}
        />
      </div>

      <LogsTable
        rows={logs}
        total={total}
        page={page}
        pageSize={pageSize}
        level={level}
        source={source}
        from={from}
        to={to}
      />
    </div>
  );
}
