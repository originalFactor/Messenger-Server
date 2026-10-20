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
import { UsageTrendChart } from "@/components/console/usage-trend-chart";
import { UsageTable } from "@/components/admin/usage-table";
import { UsageRangePicker } from "@/components/admin/usage-range-picker";
import { requireAdminUser } from "@/lib/auth";
import {
  listSiteRecentUsage,
  listUpstreamNames,
  resolveUsageRows,
  sumUsageByModelBuckets,
  sumUsageByUpstreamBuckets,
} from "@/lib/storage";

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
 * 非法格式返回 `null`，由调用方回退到默认范围。
 */
function parseLocalMidnight(value: string | undefined): number | null {
  if (value === undefined || value === "" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  // 防 2 月 31 日这类回卷：构造后日期各字段需与输入一致。
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null;
  }
  return date.getTime();
}

interface ResolvedRange {
  /** `sinceTs`/`untilTs` 直接传给 storage 与聚合；任一缺失代表该侧无界。 */
  sinceTs?: number;
  untilTs?: number;
  /** 曲线窗口（毫秒），驱动图表补空桶粒度与 X 轴刻度；自定义区间为 untilTs − sinceTs。 */
  windowMs: number;
  /** 聚合桶粒度，与图表内部推导保持一致（>1 天按天，否则按小时）。 */
  bucketMs: number;
  /** 图表末端对齐时间戳：预设模式为 `Date.now()`，自定义结束日期为对应的 `untilTs`。 */
  now: number;
  /** 当前生效的预设值；自定义区间为 `"custom"`，用于按钮高亮判断。 */
  activeRange: RangeValue | "custom";
  /** preset 模式下回填到 `UsageTable.range`；自定义模式传 `"custom"`。 */
  rangeForTable: string;
  /** 自定义日期原始字符串（YYYY-MM-DD），回填到选择器输入框；preset 模式为 undefined。 */
  from?: string;
  to?: string;
  /** 图表标题窗口文案；自定义模式用 `from~to`，预设模式为 undefined 走默认推导。 */
  rangeLabel?: string;
}

/**
 * 解析 URL 参数为统一查询范围。优先级：`from`/`to` 任一存在即视为自定义区间
 * （缺失侧无界）；否则回落到 `range` 预设，`range` 非法再回落到默认 `24h`。
 * 自定义区间内若 from > to（按日期），视为非法整体回退到 `24h`，避免空结果。
 */
function resolveRange(
  range: string | undefined,
  from: string | undefined,
  to: string | undefined,
): ResolvedRange {
  const fromMs = parseLocalMidnight(from);
  const toMs = parseLocalMidnight(to);

  if (fromMs !== null || toMs !== null) {
    // 两侧都有值且 from > to：整体非法，回退默认。
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
        // 把非法的 from/to 透传给选择器，让操作员看到自己输入的值并修正，
        // 而不是输入框悄悄变空、数据却回退默认，造成困惑。
        from,
        to,
      };
    }
    // 结束日期对应的 `untilTs` 取次日 00:00 作为开区间上界，整日 inclusive。
    const untilTs = toMs === null ? undefined : toMs + DAY_MS;
    // 自定义窗口用于驱动图表分桶（>1 天 → 天桶，否则小时桶）：
    // 两端齐全用差值；单侧开口用一个保守的大窗口强制选天桶，避免在
    // 跨月开口区间上生成海量小时桶导致图表卡顿。
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

/** 数据装配放在组件外的普通函数里，避免在渲染期间直接调用 Date.now()。 */
async function loadSiteUsageData(
  sinceTs: number | undefined,
  untilTs: number | undefined,
  bucketMs: number,
  page: number,
) {
  // 当前页明细（20 条）+ 总数 + 曲线聚合（整个所选范围）并行拉取；
  // 上游列表用于把曲线/明细里的 upstreamId 解析成可读名称。
  const [usagePage, upstreamNames, modelBuckets, upstreamBuckets] = await Promise.all([
    listSiteRecentUsage({ sinceTs, untilTs, page }),
    // 只要 _id → name：完整上游文档会带上 apiKey 与全部 modelMeta。
    listUpstreamNames(),
    sumUsageByModelBuckets(null, sinceTs ?? -Infinity, bucketMs, untilTs),
    sumUsageByUpstreamBuckets(null, sinceTs ?? -Infinity, bucketMs, untilTs),
  ]);
  const rows = await resolveUsageRows(usagePage.logs);

  const modelTrend = modelBuckets.map((bucket) => ({ ts: bucket.ts, id: bucket.modelId, tokens: bucket.tokens }));
  // 曲线图例 id：上游名称缺失（被删）时统一回退「已删除」，与明细表「上游」列
  // 口径一致，避免图例出现裸 UUID；`upstreamId` 为 null 的老记录仍归到「未知」线。
  const upstreamTrend = upstreamBuckets.map((bucket) => ({
    ts: bucket.ts,
    id: bucket.upstreamId === null
      ? null
      : (upstreamNames.get(bucket.upstreamId) ?? "已删除"),
    tokens: bucket.tokens,
  }));

  return {
    rows,
    total: usagePage.total,
    page: usagePage.page,
    pageSize: usagePage.pageSize,
    modelTrend,
    upstreamTrend,
  };
}

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; page?: string }>;
}) {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/console");
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
  const { rows, total, page, pageSize, modelTrend, upstreamTrend } = await loadSiteUsageData(
    sinceTs,
    untilTs,
    bucketMs,
    requestedPage,
  );

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">调用记录</h1>
        <UsageRangePicker
          key={`${activeRange}:${from ?? ""}:${to ?? ""}`}
          activeRange={activeRange}
          from={from}
          to={to}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageTrendChart
          buckets={modelTrend}
          windowMs={windowMs}
          now={now}
          sinceTs={sinceTs}
          dimensionLabel="模型"
          rangeLabel={rangeLabel}
        />
        <UsageTrendChart
          buckets={upstreamTrend}
          windowMs={windowMs}
          now={now}
          sinceTs={sinceTs}
          dimensionLabel="上游"
          rangeLabel={rangeLabel}
        />
      </div>

      <UsageTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        range={rangeForTable}
        from={from}
        to={to}
      />
    </div>
  );
}
