"use client";

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

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatTokens } from "@/lib/format";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** chart-1..5 是 globals.css 里定义的五个中性色 token（明暗主题各一套）。 */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** 折叠阈值之外的系列并入「其他」；保留色板前 4 个 + 其他 = 5 条线。 */
const VISIBLE_SERIES = SERIES_COLORS.length - 1;

export interface UsageTrendBucket {
  /** 桶起始时间（毫秒）。 */
  ts: number;
  /** 维度 id（模型 id 或上游 id），`null` 归到单独一条「未知」线。 */
  id: string | null;
  tokens: number;
}

export interface UsageTrendChartProps {
  /** 按时间桶 + 维度 id 分桶的 tokens。 */
  buckets: UsageTrendBucket[];
  /** 聚合窗口（毫秒）；决定补空桶的粒度与 X 轴刻度格式。 */
  windowMs: number;
  /** 「现在」的时间戳（毫秒）；曲线末端对齐当天，无数据的天补 0。 */
  now: number;
  /** 维度名称（如「模型」「上游」），用于标题与图例说明。 */
  dimensionLabel: string;
  /**
   * 覆盖标题里的窗口文案（默认按 `windowMs` 推导「近 24 小时/7 天/30 天」）。
   * 自定义起止日期场景下传入 `{from}~{to}` 这类显式区间，标题更准确。
   */
  rangeLabel?: string;
  /**
   * 序列起点下界（毫秒）。缺省时取首个数据桶；传入后从该时间补 0 桶，
   * 让无调用的前置天（如「近 7 天」里只有第 6/7 天有数据时）仍出现在 X 轴。
   */
  sinceTs?: number;
}

interface ChartRow {
  ts: number;
  [seriesId: string]: number;
}

/**
 * 把稀疏的聚合结果补齐成连续时间序列：每个桶一行，没有调用的维度留 0；
 * 只画总量最高的前 4 个维度（超出折叠进「其他」），`id` 为 `null` 的桶
 * 归到「未知」线并始终可见。
 */
export function UsageTrendChart({ buckets, windowMs, now, dimensionLabel, rangeLabel, sinceTs }: UsageTrendChartProps) {
  if (buckets.length === 0) {
    return null;
  }

  const bucketMs = windowMs > DAY_MS ? DAY_MS : HOUR_MS;
  const daily = bucketMs === DAY_MS;

  const totals = new Map<string | null, number>();
  for (const bucket of buckets) {
    totals.set(bucket.id, (totals.get(bucket.id) ?? 0) + bucket.tokens);
  }
  // 排序时把 null（未知上游）固定在可见列表末尾，保证它单独成线而不被折叠。
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const knownRanked = ranked.filter(([id]) => id !== null);
  const nullTotal = totals.get(null) ?? 0;
  const visibleKnown = knownRanked.slice(0, VISIBLE_SERIES - (nullTotal > 0 ? 1 : 0))
    .map(([id]) => id as string);
  const foldedKnown = new Set(knownRanked.slice(visibleKnown.length).map(([id]) => id as string));

  const hasNullSeries = nullTotal > 0;
  const otherLabel = "其他";
  const unknownLabel = "未知";
  const series = [
    ...visibleKnown,
    ...(foldedKnown.size > 0 ? [otherLabel] : []),
    ...(hasNullSeries ? [unknownLabel] : []),
  ];

  // 序列起点：优先用 caller 提供的 `sinceTs` 下界对齐到桶，让无调用的
  // 前置天（如「近 7 天」里只有后两天有数据时）也以 0 出现在 X 轴；
  // 缺省则从首个数据桶开始（兼容 overview 页面无界起点）。
  const startTs = sinceTs !== undefined
    ? Math.floor(sinceTs / bucketMs) * bucketMs
    : Math.min(...buckets.map((bucket) => bucket.ts));
  // 序列末端强制到今天：无调用的天补 0，X 轴最后一个刻度恒为当天。
  const endTs = Math.max(now, ...buckets.map((bucket) => bucket.ts));
  const rows: ChartRow[] = [];
  for (let ts = startTs; ts <= endTs; ts += bucketMs) {
    const row: ChartRow = { ts };
    for (const seriesId of series) {
      row[seriesId] = 0;
    }
    rows.push(row);
  }
  const rowByTs = new Map(rows.map((row) => [row.ts, row]));
  for (const bucket of buckets) {
    const row = rowByTs.get(bucket.ts);
    if (!row) continue;
    const target = bucket.id === null
      ? unknownLabel
      : foldedKnown.has(bucket.id) ? otherLabel : bucket.id;
    row[target] += bucket.tokens;
  }

  const defaultWindowLabel =
    windowMs >= 30 * DAY_MS ? "近 30 天"
      : windowMs >= 7 * DAY_MS ? "近 7 天"
        : "近 24 小时";
  const windowLabel = rangeLabel ?? defaultWindowLabel;
  const bucketLabel = daily ? "每天" : "每小时";
  // 自适应刻度密度：并排展示时半宽容易重叠，按「最多 ~8 个刻度」取步长，
  // 并保证末刻度恒为序列末端（从末端按步长倒推取刻度）。
  const maxTicks = 8;
  const tickStep = Math.max(1, Math.ceil(rows.length / maxTicks));
  const explicitTicks = rows
    .filter((_, index) => (rows.length - 1 - index) % tickStep === 0)
    .map((row) => row.ts);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{windowLabel}按{dimensionLabel}用量</CardTitle>
        <CardDescription>
          {bucketLabel} tokens，按{dimensionLabel}拆分（共 {totals.size} 个{dimensionLabel}）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                ticks={explicitTicks}
                tickFormatter={(ts) => {
                  const date = new Date(Number(ts));
                  return daily
                    ? `${date.getMonth() + 1}/${date.getDate()}`
                    : `${date.getHours().toString().padStart(2, "0")}:00`;
                }}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                stroke="var(--border)"
                interval={0}
              />
              <YAxis
                tickFormatter={(value) => formatTokens(Number(value))}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                stroke="var(--border)"
                width={48}
                allowDecimals={false}
              />
              <Tooltip
                labelFormatter={(label) => formatDateTime(Number(label))}
                formatter={(value, name) => [
                  `${formatTokens(Number(value))} tokens`,
                  String(name),
                ]}
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  color: "var(--popover-foreground)",
                  fontSize: 12,
                }}
              />
              <Legend
                verticalAlign="top"
                height={24}
                formatter={(value) => (
                  <span style={{ color: "var(--muted-foreground)", fontSize: 11 }}>{value}</span>
                )}
              />
              {series.map((seriesId, index) => (
                <Line
                  key={seriesId}
                  type="monotone"
                  dataKey={seriesId}
                  name={seriesId}
                  stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
