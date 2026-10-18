"use client";

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
import type { UsageModelBucket } from "@/lib/storage";

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

export interface UsageModelChartProps {
  /** 按时间桶分桶的 per-model tokens。 */
  buckets: UsageModelBucket[];
  /** 聚合窗口（毫秒）；决定补空桶的粒度与 X 轴刻度格式。 */
  windowMs: number;
  /** 「现在」的时间戳（毫秒）；曲线末端对齐当天，无数据的天补 0。 */
  now: number;
}

interface ChartRow {
  ts: number;
  [modelId: string]: number;
}

/**
 * 把稀疏的聚合结果补齐成连续时间序列：每个桶一行，没有调用的
 * 模型留 0；只画总量最高的前 4 个模型（超出折叠进「其他」）。
 */
export function UsageModelChart({ buckets, windowMs, now }: UsageModelChartProps) {
  if (buckets.length === 0) {
    return null;
  }

  const bucketMs = windowMs > DAY_MS ? DAY_MS : HOUR_MS;
  const daily = bucketMs === DAY_MS;

  const modelTotals = new Map<string, number>();
  for (const bucket of buckets) {
    modelTotals.set(bucket.modelId, (modelTotals.get(bucket.modelId) ?? 0) + bucket.tokens);
  }
  const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]);
  const visible = ranked.slice(0, SERIES_COLORS.length - 1).map(([modelId]) => modelId);
  const folded = new Set(ranked.slice(SERIES_COLORS.length - 1).map(([modelId]) => modelId));

  const startTs = Math.min(...buckets.map((bucket) => bucket.ts));
  // 序列末端强制到今天：无调用的天补 0，X 轴最后一个刻度恒为当天。
  const endTs = Math.max(now, ...buckets.map((bucket) => bucket.ts));
  const rows: ChartRow[] = [];
  for (let ts = startTs; ts <= endTs; ts += bucketMs) {
    const row: ChartRow = { ts };
    for (const modelId of [...visible, "其他"]) {
      row[modelId] = 0;
    }
    rows.push(row);
  }
  const rowByTs = new Map(rows.map((row) => [row.ts, row]));
  for (const bucket of buckets) {
    const row = rowByTs.get(bucket.ts);
    if (!row) continue;
    if (folded.has(bucket.modelId)) {
      row["其他"] += bucket.tokens;
    } else {
      row[bucket.modelId] += bucket.tokens;
    }
  }

  const series = folded.size > 0 ? [...visible, "其他"] : visible;
  const windowLabel = daily ? "近 30 天" : "近 24 小时";
  const bucketLabel = daily ? "每天" : "每小时";
  // 强制每小时/每天都有刻度：小时窗口每 2 小时一刻度（24 个标签会重叠），
  // 日窗口每天一刻度；末刻度恒为序列末端。
  const tickStep = daily ? 1 : 2;
  const explicitTicks = rows
    .filter((_, index) => (rows.length - 1 - index) % tickStep === 0)
    .map((row) => row.ts);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{windowLabel}按模型用量</CardTitle>
        <CardDescription>
          {bucketLabel} tokens，按模型拆分（共 {ranked.length} 个模型）。
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
              {series.map((modelId, index) => (
                <Line
                  key={modelId}
                  type="monotone"
                  dataKey={modelId}
                  name={modelId}
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
