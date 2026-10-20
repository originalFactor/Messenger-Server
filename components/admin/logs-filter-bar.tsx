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

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

type RangeKind = "24h" | "7d" | "30d" | "custom";

const PRESET_ITEMS: { value: RangeKind; label: string }[] = [
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义" },
];

const LEVEL_ITEMS: { value: RuntimeLogLevel | "all"; label: string }[] = [
  { value: "all", label: "全部级别" },
  { value: "error", label: "错误" },
  { value: "warn", label: "警告" },
  { value: "info", label: "信息" },
];

const SOURCE_ITEMS: { value: RuntimeLogSource | "all"; label: string }[] = [
  { value: "all", label: "全部来源" },
  { value: "api", label: "API" },
  { value: "relay", label: "中继" },
  { value: "auth", label: "认证" },
  { value: "billing", label: "计费" },
  { value: "admin", label: "管理" },
  { value: "sync", label: "同步" },
  { value: "market", label: "市场" },
  { value: "avatar", label: "头像" },
  { value: "storage", label: "存储" },
  { value: "migration", label: "迁移" },
];

/**
 * 「日志页」筛选器：级别 + 来源 下拉，加时间范围选择器。任一变化立即
 * `?level=&source=&range=…` 导航刷新数据；自定义区间展开两个 `<input type=date>`
 * + 查询按钮。父页用 `key` 重建本组件以随 RSC 导航重置本地状态。
 */
export function LogsFilterBar({
  activeRange,
  activeLevel,
  activeSource,
  from,
  to,
}: {
  activeRange: RangeKind;
  activeLevel: RuntimeLogLevel | null;
  activeSource: RuntimeLogSource | null;
  from?: string;
  to?: string;
}) {
  const router = useRouter();
  const [customOpen, setCustomOpen] = useState(activeRange === "custom");
  const [fromValue, setFromValue] = useState(from ?? "");
  const [toValue, setToValue] = useState(to ?? "");
  const [error, setError] = useState<string | null>(null);

  function navigate(next: {
    range?: RangeKind;
    from?: string;
    to?: string;
    level?: RuntimeLogLevel | null;
    source?: RuntimeLogSource | null;
  }) {
    const params = new URLSearchParams();
    const nextRange = next.range ?? activeRange;
    const nextFrom = next.from ?? from;
    const nextTo = next.to ?? to;
    const nextLevel = next.level !== undefined ? next.level : activeLevel;
    const nextSource = next.source !== undefined ? next.source : activeSource;
    if (nextRange === "custom") {
      if (nextFrom !== undefined) {
        params.set("from", nextFrom);
      }
      if (nextTo !== undefined) {
        params.set("to", nextTo);
      }
    } else {
      params.set("range", nextRange);
    }
    if (nextLevel) {
      params.set("level", nextLevel);
    }
    if (nextSource) {
      params.set("source", nextSource);
    }
    router.push(`/console/admin/logs?${params.toString()}`);
  }

  function onRangeChange(value: string) {
    if (value === "custom") {
      setError(null);
      setCustomOpen(true);
      navigate({ range: "custom", from: fromValue, to: toValue });
      return;
    }
    setCustomOpen(false);
    setError(null);
    navigate({ range: value as RangeKind });
  }

  function onLevelChange(value: string) {
    navigate({ level: value === "all" ? null : (value as RuntimeLogLevel) });
  }

  function onSourceChange(value: string) {
    navigate({ source: value === "all" ? null : (value as RuntimeLogSource) });
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (fromValue === "" && toValue === "") {
      setError(null);
      navigate({ range: "24h", from: undefined, to: undefined });
      return;
    }
    if (fromValue !== "" && toValue !== "" && fromValue > toValue) {
      setError("开始日期不能晚于结束日期。");
      return;
    }
    setError(null);
    navigate({ range: "custom", from: fromValue, to: toValue });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <Label htmlFor="logs-level" className="text-xs text-muted-foreground">级别</Label>
        <Select value={activeLevel ?? "all"} onValueChange={onLevelChange}>
          <SelectTrigger id="logs-level" size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="logs-source" className="text-xs text-muted-foreground">来源</Label>
        <Select value={activeSource ?? "all"} onValueChange={onSourceChange}>
          <SelectTrigger id="logs-source" size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="logs-range" className="text-xs text-muted-foreground">时间范围</Label>
        <Select value={activeRange} onValueChange={onRangeChange}>
          <SelectTrigger id="logs-range" size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESET_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {customOpen ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="logs-from" className="text-xs text-muted-foreground">开始</Label>
            <Input
              id="logs-from"
              type="date"
              value={fromValue}
              onChange={(e) => setFromValue(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="logs-to" className="text-xs text-muted-foreground">结束</Label>
            <Input
              id="logs-to"
              type="date"
              value={toValue}
              onChange={(e) => setToValue(e.target.value)}
              className="w-40"
            />
          </div>
          <Button type="submit" size="sm" variant="outline">
            查询
          </Button>
          {error !== null ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
