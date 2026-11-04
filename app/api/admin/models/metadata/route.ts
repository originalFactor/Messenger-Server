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

import { requireAdminUser } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getCatalogRates } from "@/lib/pi-catalog";

export const runtime = "nodejs";

/**
 * pi-catalog 模型倍率（实例内存缓存 24h）：modelId →
 * { inputRate?, cacheReadRate?, cacheWriteRate?, outputRate?, tiers?, timeBased? }。
 * 倍率以 deepseek/deepseek-flash 的输出价格 1.0 为基准折算；pi.dev 不可用时
 * 返回空映射。长上下文阶梯与峰谷是目录原样配置（阶梯同分母折算）。
 *
 * 上游 `/v1/models` 自报的报价不在这里 —— 它们按上游存在 `upstreams.modelPrices`，
 * 解析时优先于本目录（见 `lib/model-rates.ts`）。
 *
 * 传 ?refresh=1 时绕过缓存强制重新拉取（控制台「更新元数据」入口）。
 */
export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  const { rates, models, degraded } = await getCatalogRates(forceRefresh);
  const metadata: Record<
    string,
    {
      inputRate: number;
      cacheReadRate: number;
      cacheWriteRate: number;
      outputRate: number;
      tiers?: Array<{
        inputThreshold: number;
        inputThresholdInclusive?: boolean;
        inputRate: number;
        cacheReadRate: number;
        cacheWriteRate: number;
        outputRate: number;
      }>;
      timeBased?: { offPeakMultiplier: number; peakWindows: Array<{ weekdays: number[]; startMinute: number; endMinute: number }> };
    }
  > = {};
  for (const [modelId, rate] of Object.entries(rates)) {
    metadata[modelId] = {
      inputRate: rate.input,
      cacheReadRate: rate.cacheRead,
      cacheWriteRate: rate.cacheWrite,
      outputRate: rate.output,
      ...(rate.tiers
        ? {
            tiers: rate.tiers.map((tier) => ({
              inputThreshold: tier.inputThreshold,
              ...(tier.inputThresholdInclusive !== undefined
                ? { inputThresholdInclusive: tier.inputThresholdInclusive }
                : {}),
              inputRate: tier.input,
              cacheReadRate: tier.cacheRead,
              cacheWriteRate: tier.cacheWrite,
              outputRate: tier.output,
            })),
          }
        : {}),
      ...(rate.timeBased ? { timeBased: rate.timeBased } : {}),
    };
  }
  return jsonOk({ metadata, models, degraded });
}
