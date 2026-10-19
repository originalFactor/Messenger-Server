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

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BaseModelView {
  baseModelId: string | null;
  models: string[];
  /** 各模型当前生效的输入/缓存/输出倍率（models.dev 归一化口径）。 */
  rates: Record<string, { inputRate: number; cacheReadRate: number; outputRate: number }>;
}

const NO_BASE_MODEL = "__none__";

export function BaseModelPicker() {
  const router = useRouter();
  const [view, setView] = useState<BaseModelView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/models/base");
        if (!response.ok) {
          if (!cancelled) setError("基准模型配置加载失败。");
          return;
        }
        const payload = (await response.json()) as BaseModelView;
        if (!cancelled) {
          setView(payload);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("网络错误，请稍后重试。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function setBaseModel(baseModelId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/models/base", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseModelId: baseModelId === NO_BASE_MODEL ? null : baseModelId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "保存失败，请稍后重试。");
        return;
      }
      const payload = (await response.json()) as { baseModelId: string | null };
      setView((current) => (current ? { ...current, baseModelId: payload.baseModelId } : current));
      toast.success(
        payload.baseModelId
          ? `基准模型已切换为 ${payload.baseModelId}，全部模型价格已按新基准重算`
          : "已清除基准模型，价格恢复 models.dev 口径",
      );
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const models = view?.models ?? [];
  const current = view?.baseModelId ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">1x 基准模型</CardTitle>
        <CardDescription>
          选定一个模型作为基准（其价格记为 1.0）。切换基准时，全部已保存的模型价格
          （含覆盖自定义值）会按新基准整体重算，模型和来源的整体倍率不受影响。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Select
          value={current ?? NO_BASE_MODEL}
          onValueChange={(value) => void setBaseModel(value)}
          disabled={busy || models.length === 0}
        >
          <SelectTrigger className="sm:w-96">
            <SelectValue placeholder={models.length === 0 ? "暂无可选模型" : "选择基准模型"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_BASE_MODEL}>不设基准（按 models.dev 价格）</SelectItem>
            {models.map((modelId) => {
              const rate = view?.rates[modelId];
              return (
                <SelectItem key={modelId} value={modelId}>
                  {modelId}
                  {rate ? `（${rate.inputRate} / ${rate.cacheReadRate} / ${rate.outputRate}）` : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {current ? (
          <p className="text-xs text-muted-foreground">
            当前基准：<span className="font-mono">{current}</span>，其价格即 1.0。
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            未设基准：全部价格按 models.dev 口径（deepseek-v4.1-flash 输出 = 1.0）。
          </p>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
