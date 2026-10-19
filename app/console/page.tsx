/*
 * Copyright 2026 ECSDevs
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
import { ApiKeyCard } from "@/components/console/api-key-card";
import { UsageTrendChart } from "@/components/console/usage-trend-chart";
import { UsageTable } from "@/components/admin/usage-table";
import { UsageRangePicker } from "@/components/admin/usage-range-picker";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireUserSession } from "@/lib/auth";
import { formatDateTime, formatTokens } from "@/lib/format";
import {
  getUserById,
  getUserQuotaState,
  getUserSyncSummary,
  listUserRecentUsage,
  resolveUsageRows,
  sumUsage,
  sumUsageByModelBuckets,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 时间范围选项：value 进 searchParam，windowMs 决定 sinceTs/bucketMs/曲线窗口。 */
const RANGE_OPTIONS = [
  { value: "24h", label: "近 24 小时", windowMs: DAY_MS, bucketMs: HOUR_MS },
  { value: "7d", label: "近 7 天", windowMs: 7 * DAY_MS, bucketMs: DAY_MS },
  { value: "30d", label: "近 30 天", windowMs: 30 * DAY_MS, bucketMs: DAY_MS },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]["value"];

/**
 * 把 `YYYY-MM-DD` 解释为服务器本地时区的当天 00:00 毫秒。用 `new Date(s)`
 * 会被当成 UTC 午夜导致跨时区偏移，所以显式取 y/m/d 构造本地 Date。
 * 非法格式返回 `null`，由调用方回退到默认范围。与 admin usage 页共享同一逻辑。
 */
function parseLocalMidnight(value: string | undefined): number | null {
  if (value === undefined || value === "" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null;
  }
  return date.getTime();
}

interface ResolvedRange {
  sinceTs?: number;
  untilTs?: number;
  windowMs: number;
  bucketMs: number;
  now: number;
  activeRange: RangeValue | "custom";
  rangeForTable: string;
  from?: string;
  to?: string;
  rangeLabel?: string;
}

/**
 * 解析 URL 参数为统一查询范围。优先级：`from`/`to` 任一存在即视为自定义区间
 * （缺失侧无界）；否则回落到 `range` 预设，`range` 非法再回落到默认 `24h`。
 * 自定义区间内若 from > to（按日期），视为非法整体回退到 `24h`，避免空结果。
 * 与 admin usage 页共享同一逻辑。
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
      const now = Date.now();
      return {
        sinceTs: now - option.windowMs,
        windowMs: option.windowMs,
        bucketMs: option.bucketMs,
        now,
        activeRange: option.value,
        rangeForTable: option.value,
        from,
        to,
      };
    }
    const untilTs = toMs === null ? undefined : toMs + DAY_MS;
    const windowMs = fromMs !== null && untilTs !== undefined
      ? Math.max(HOUR_MS, untilTs - fromMs)
      : 30 * DAY_MS;
    const bucketMs = windowMs > DAY_MS ? DAY_MS : HOUR_MS;
    const rangeLabel = from ?? to
      ? `${from ?? "—"} ~ ${to ?? "—"}`
      : undefined;
    return {
      sinceTs: fromMs ?? undefined,
      untilTs,
      windowMs,
      bucketMs,
      now: untilTs ?? Date.now(),
      activeRange: "custom",
      rangeForTable: "custom",
      from,
      to,
      rangeLabel,
    };
  }

  const match = RANGE_OPTIONS.find((option) => option.value === range);
  const option = match ?? RANGE_OPTIONS[0];
  const now = Date.now();
  return {
    sinceTs: now - option.windowMs,
    windowMs: option.windowMs,
    bucketMs: option.bucketMs,
    now,
    activeRange: option.value,
    rangeForTable: option.value,
  };
}

/** 概览页 KPI 卡数据（始终取近 24h，与所选时间范围解耦）+ 所选范围内明细/曲线。 */
async function loadOverviewData(
  userId: string,
  sinceTs: number | undefined,
  untilTs: number | undefined,
  bucketMs: number,
  page: number,
) {
  const now = Date.now();
  const [today, usagePage, quota, sync, modelBuckets] = await Promise.all([
    sumUsage(userId, now - 24 * 60 * 60 * 1000),
    listUserRecentUsage(userId, { sinceTs, untilTs, page }),
    getUserQuotaState(userId),
    getUserSyncSummary(userId),
    sumUsageByModelBuckets(userId, sinceTs ?? -Infinity, bucketMs, untilTs),
  ]);
  const rows = await resolveUsageRows(usagePage.logs);
  const modelTrend = modelBuckets.map((bucket) => ({ ts: bucket.ts, id: bucket.modelId, tokens: bucket.tokens }));
  return {
    today,
    rows,
    total: usagePage.total,
    page: usagePage.page,
    pageSize: usagePage.pageSize,
    quota,
    sync,
    modelTrend,
  };
}
export default async function ConsoleOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; page?: string }>;
}) {
  const session = await requireUserSession();
  if (!session) {
    redirect("/login");
  }
  const user = await getUserById(session.sub);
  if (!user) {
    redirect("/login");
  }

  const params = await searchParams;
  const {
    sinceTs,
    untilTs,
    windowMs,
    bucketMs,
    now,
    activeRange,
    rangeForTable,
    from,
    to,
    rangeLabel,
  } = resolveRange(params.range, params.from, params.to);
  const pageParam = Number(params.page ?? "1");
  const requestedPage = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;
  const {
    today,
    rows,
    total,
    page,
    pageSize,
    quota,
    sync,
    modelTrend,
  } = await loadOverviewData(user.id, sinceTs, untilTs, bucketMs, requestedPage);

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">概览</h1>
        <Badge variant="outline">{user.role === "admin" ? "管理员" : "用户"}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">剩余额度</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">
              {formatTokens(quota.balance)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {quota.available
              ? quota.expiresAt === null
                ? "有效期不限"
                : `有效期至 ${formatDateTime(quota.expiresAt)}`
              : quota.reason === "expired"
                ? "套餐已过期，请兑换新卡密"
                : "暂无可用额度，请兑换卡密"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">近 24 小时请求</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{today.requests}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            消耗 {formatTokens(today.cost)} 额度
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">近 24 小时 tokens</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{formatTokens(today.tokens)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">已按所选模型价格折算</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">云同步</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{formatTokens(sync.conversations)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            会话 · 智能体 {sync.agents} · 服务商 {sync.providers} · 消息 {formatTokens(sync.messages)}
            {sync.lastSyncAt ? ` · 最近同步 ${formatDateTime(sync.lastSyncAt)}` : ""}
          </CardContent>
        </Card>
      </div>

      <ApiKeyCard apiKey={user.aiApiKey} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">调用记录</h2>
        <UsageRangePicker
          key={`${activeRange}:${from ?? ""}:${to ?? ""}`}
          activeRange={activeRange}
          from={from}
          to={to}
          basePath="/console"
        />
      </div>

      <UsageTrendChart
        buckets={modelTrend}
        windowMs={windowMs}
        now={now}
        sinceTs={sinceTs}
        dimensionLabel="模型"
        rangeLabel={rangeLabel}
      />

      <UsageTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        range={rangeForTable}
        from={from}
        to={to}
        showCallerColumn={false}
        showUpstreamColumn={false}
        title="近期用量"
        description="每页 {pageSize} 条，按调用时间倒序；共 {total} 条 / {totalPages} 页。TPS 由输出 tokens ÷ 耗时换算。"
        basePath="/console"
      />
    </div>
  );
}
