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

type RangeKind = "24h" | "7d" | "30d" | "custom";

const PRESET_ITEMS: { value: RangeKind; label: string }[] = [
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义" },
];

/**
 * 「调用记录」页时间范围选择器：一个下拉（24h / 7d / 30d / 自定义）。
 * - 选预设项立即 `?range=…` 导航并刷新数据；下拉受控值直接来自父页传入
 *   的 `activeRange`，父页在 RSC 导航完成后会传入新的 `activeRange`
 *   并配合 `key` 强制本组件重建，本地状态不再随同步失效。
 * - 选「自定义」时不导航，原地展开两个 `<input type="date">` + 查询按钮；
 *   提交时校验 `from ≤ to`，OK 则 `?from=&to=` 导航。
 * - 两个日期任一留空 → 回退到对应方向无界；两者皆空 → 回退默认 24h。
 *   from > to 客户端拦截并显示错误，不跳转；服务器侧另兜底回退（直访 URL）。
 *
 * 父页用 `key={activeRange + from + to}` 挂载，让 RSC 导航完成后本组件
 * 完全重置（取自最新 URL 的初始值），避免 set-state-in-effect 反模式。
 */
export function UsageRangePicker({
  activeRange,
  from,
  to,
  basePath = "/console/admin/usage",
}: {
  activeRange: RangeKind;
  from?: string;
  to?: string;
  /** 分页/查询参数附加的目标路径；用户概览页传 `/console`。 */
  basePath?: string;
}) {
  const router = useRouter();
  // 初始展开：URL 已是自定义。导航后父页 key 变化会重建本组件，因此
  // 仅需在初始化时看 `activeRange === "custom"`。
  const [customOpen, setCustomOpen] = useState(activeRange === "custom");
  // 本地「待提交的自定义选择」标记：用户点了「自定义」但还没提交；用于把
  // trigger 文案即时切到「自定义」。提交或选回预设项后由 `activeRange`
  // （URL 真值）+ 父页 `key` 重建接管，无需 effect 同步。
  const [pendingCustom, setPendingCustom] = useState(false);
  const [fromValue, setFromValue] = useState(from ?? "");
  const [toValue, setToValue] = useState(to ?? "");
  const [error, setError] = useState<string | null>(null);
  const selectValue = pendingCustom ? "custom" : activeRange;

  function onRangeChange(value: string) {
    if (value === "custom") {
      setError(null);
      setPendingCustom(true);
      setCustomOpen(true);
      return;
    }
    setPendingCustom(false);
    setCustomOpen(false);
    setError(null);
    router.push(`${basePath}?range=${value}`);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 两个都留空 → 清掉自定义参数，回到默认（preset=24h）。
    if (fromValue === "" && toValue === "") {
      setError(null);
      router.push(basePath);
      return;
    }
    // date input 的值恒为 YYYY-MM-DD，可直接字典序比较日期先后。
    if (fromValue !== "" && toValue !== "" && fromValue > toValue) {
      setError("开始日期不能晚于结束日期。");
      return;
    }
    setError(null);
    const params = new URLSearchParams();
    if (fromValue !== "") {
      params.set("from", fromValue);
    }
    if (toValue !== "") {
      params.set("to", toValue);
    }
    router.push(`${basePath}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <Label htmlFor="usage-range" className="text-xs text-muted-foreground">时间范围</Label>
        <Select value={selectValue} onValueChange={onRangeChange}>
          <SelectTrigger id="usage-range" size="sm" className="w-36">
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
            <Label htmlFor="usage-from" className="text-xs text-muted-foreground">开始</Label>
            <Input
              id="usage-from"
              type="date"
              value={fromValue}
              onChange={(e) => setFromValue(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="usage-to" className="text-xs text-muted-foreground">结束</Label>
            <Input
              id="usage-to"
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