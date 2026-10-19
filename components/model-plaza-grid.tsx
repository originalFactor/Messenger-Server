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

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PlazaModel } from "@/lib/model-plaza";

/**
 * 倍率展示：严格保留 2 位有效数字（`Intl.NumberFormat` 的
 * `minimumSignificantDigits`/`maximumSignificantDigits` 二者都设为 2，
 * 自带尾零且不走科学计数法：1.234 → 1.2、0.567 → 0.57、12.34 → 12、
 * 0.0123 → 0.012、1 → 1.0、0.3 → 0.30、100 → 100、99.99 → 100）。
 * 区间先按 2 位有效数字四舍五入再比较，避免 0.25 ~ 0.24 这类被舍入成
 * 不同精度后看起来像区间；0 = 不计费。
 */
const rateFormatter = new Intl.NumberFormat("en-US", {
  minimumSignificantDigits: 2,
  maximumSignificantDigits: 2,
});

function roundRate(rate: number): number {
  return Number(rate.toPrecision(2));
}

function formatRate(rate: number): string {
  const rounded = roundRate(rate);
  return rounded <= 0 ? "免费" : rateFormatter.format(rounded);
}

function formatRateRange(min: number, max: number): string {
  const lo = roundRate(min);
  const hi = roundRate(max);
  return lo === hi ? formatRate(lo) : `${formatRate(lo)} ~ ${formatRate(hi)}`;
}

/** 拆出 models.dev 风格的前缀供应商（deepseek/deepseek-v4.1-flash → deepseek），无前缀只显示裸 ID。 */
function splitModelId(modelId: string): { vendor?: string; name: string } {
  const separator = modelId.indexOf("/");
  return separator > 0
    ? { vendor: modelId.slice(0, separator), name: modelId.slice(separator + 1) }
    : { name: modelId };
}

export function ModelPlazaGrid({ models }: { models: PlazaModel[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return models;
    }
    return models.filter((model) => model.modelId.toLowerCase().includes(keyword));
  }, [models, query]);

  if (models.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">暂无可用模型，请稍后再来。</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型名称或 ID"
            aria-label="搜索模型"
            className="pl-8"
          />
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">共 {filtered.length} 个模型</p>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">没有匹配的模型，换个关键词试试。</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((model) => {
            const { vendor, name } = splitModelId(model.modelId);
            return (
              <Card key={model.modelId} size="sm" className="gap-3">
                <CardHeader>
                  <CardTitle className="font-mono text-sm leading-snug break-all" title={model.modelId}>
                    {name}
                  </CardTitle>
                  {vendor && (
                    <CardDescription className="font-mono text-xs">
                      <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                        {vendor}
                      </Badge>
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="grid grid-cols-3 gap-3 text-center">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium tabular-nums">
                      {formatRateRange(model.inputRateMin, model.inputRateMax)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">输入倍率</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium tabular-nums">
                      {formatRateRange(model.cacheReadRateMin, model.cacheReadRateMax)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">缓存读取倍率</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium tabular-nums">
                      {formatRateRange(model.outputRateMin, model.outputRateMax)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">输出倍率</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}