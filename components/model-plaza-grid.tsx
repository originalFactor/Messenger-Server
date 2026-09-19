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

/** 倍率展示：四舍五入到 0.1（区间先取整再比较，避免 0.2 ~ 0.2 这类退化）；0 = 不计费。 */
function roundRate(rate: number): number {
  return Math.round(rate * 10) / 10;
}

function formatRate(rate: number): string {
  const rounded = roundRate(rate);
  return rounded <= 0 ? "免费" : rounded.toFixed(1);
}

function formatRateRange(min: number, max: number): string {
  const lo = roundRate(min);
  const hi = roundRate(max);
  return lo === hi ? formatRate(lo) : `${formatRate(lo)} ~ ${formatRate(hi)}`;
}

/** 上下文展示：取能整除的最大单位（1000000 → 1M、1050000 → 1050K、500 → 500），0 = 不限。 */
function formatContext(tokens: number): string {
  if (tokens <= 0) {
    return "不限";
  }
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return String(tokens);
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
                      {formatContext(model.contextWindow)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">Context</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium tabular-nums">
                      {formatRateRange(model.inputRateMin, model.inputRateMax)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">输入倍率</div>
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