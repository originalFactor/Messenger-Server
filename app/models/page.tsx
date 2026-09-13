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

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getModelPlaza, type PlazaModel } from "@/lib/model-plaza";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "模型广场 - Messenger Cloud",
};

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

/** 数据装配放在组件外的普通函数里，避免在渲染期间直接调用 Date.now()。 */
async function loadPlaza(): Promise<{ models: PlazaModel[]; failed: boolean }> {
  try {
    return { models: await getModelPlaza(), failed: false };
  } catch (error) {
    console.error("Unable to load the model plaza.", error);
    return { models: [], failed: true };
  }
}

export default async function ModelPlazaPage() {
  const { models, failed } = await loadPlaza();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b bg-background/70 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link className="flex items-center gap-2.5 text-sm font-semibold tracking-tight" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" className="size-5 rounded-md" />
            Messenger Cloud
          </Link>
          <Button asChild variant="outline" size="sm">
            <Link href="/">
              <ArrowLeft />
              返回首页
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">模型广场</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            当前可用的全部模型及其计费倍率（以 deepseek-v4.1-flash 为基准 1.0）。
            单次调用费用 = 输入 tokens × 输入倍率 + 输出 tokens × 输出倍率（向上取整，至少 1）；
            多个上游提供同一模型且倍率不同时显示区间，实际按为你服务的上游计费。
          </p>
        </div>

        {failed ? (
          <p className="py-12 text-center text-sm text-muted-foreground">模型数据加载失败，请稍后刷新重试。</p>
        ) : models.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">暂无可用模型，请稍后再来。</p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead className="w-32">Context Window</TableHead>
                  <TableHead className="w-40">输入倍率</TableHead>
                  <TableHead className="w-40">输出倍率</TableHead>
                  <TableHead className="w-24 text-right">上游</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => (
                  <TableRow key={model.modelId}>
                    <TableCell className="font-mono text-xs">{model.modelId}</TableCell>
                    <TableCell className="tabular-nums">{formatContext(model.contextWindow)}</TableCell>
                    <TableCell className="tabular-nums">{formatRateRange(model.inputRateMin, model.inputRateMax)}</TableCell>
                    <TableCell className="tabular-nums">{formatRateRange(model.outputRateMin, model.outputRateMax)}</TableCell>
                    <TableCell className="text-right tabular-nums">{model.upstreamCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </main>
    </div>
  );
}
