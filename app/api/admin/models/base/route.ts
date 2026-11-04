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
import { currentStoredCard } from "@/lib/model-rates";
import { createLogger } from "@/lib/runtime-logs";
import { getModelRateSettings, listUpstreams, setBaseModel } from "@/lib/storage";
import { baseModelInputSchema } from "@/lib/validation";

export const runtime = "nodejs";

const adminLog = createLogger("admin");

/**
 * 1x 基准模型设置：GET 返回当前基准与可候选模型（启用上游可服务模型的并集，
 * 附带各自当前生效的输入/缓存/输出倍率）；PUT 只写 `model_rate_settings`。
 *
 * 基准是解析期的分母（见 `resolveModelRates`），不是写回上游的数据：
 * 切换基准不改任何上游存量倍率，因此模型间相对价格恒定、随时可逆。
 */
export async function GET() {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const [settings, upstreams, defaults] = await Promise.all([
    getModelRateSettings(),
    listUpstreams(),
    getCatalogRates(),
  ]);
  const enabled = upstreams.filter((upstream) => upstream.enabled);
  const modelIds = [...new Set(enabled.flatMap((upstream) => upstream.models))].sort((a, b) =>
    a.localeCompare(b),
  );
  const rates: Record<
    string,
    {
      inputRate: number;
      cacheReadRate: number;
      cacheWriteRate: number;
      outputRate: number;
      longContextThreshold: number | null;
      timeMultiplier: number;
    }
  > = {};
  for (const modelId of modelIds) {
    // 报价可能按上游不同（上游 `/v1/models` 自报时），展示取最优惠的一条；
    // 实际计费时基准分母按该次请求命中的上游各自计算，基准模型自身恒为 1x。
    const candidates = enabled.filter((candidate) => candidate.models.includes(modelId));
    const resolved = candidates.map((upstream) =>
      currentStoredCard(modelId, undefined, defaults.rates, upstream.modelPrices?.[modelId]),
    );
    rates[modelId] = {
      inputRate: Math.min(...resolved.map((rate) => rate.input)),
      cacheReadRate: Math.min(...resolved.map((rate) => rate.cacheRead)),
      cacheWriteRate: Math.min(...resolved.map((rate) => rate.cacheWrite)),
      outputRate: Math.min(...resolved.map((rate) => rate.output)),
      // 阶梯阈值与峰谷系数不参与「取最优惠」，按第一条上游展示即可 ——
      // 它们是结构配置，不是价格。
      longContextThreshold: resolved[0]?.tiers?.[0]?.inputThreshold ?? null,
      timeMultiplier: resolved[0]?.timeBased ? resolved[0].timeBased.offPeakMultiplier : 1,
    };
  }
  return jsonOk({
    baseModelId: settings.baseModelId,
    models: modelIds,
    rates,
  });
}

export async function PUT(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = baseModelInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid base model payload.", 400);
  }

  const settings = await setBaseModel({ baseModelId: parsed.data.baseModelId });
  adminLog.info("Base model set.", { adminId: admin.claims.sub, entity: "model-base", operation: "set-base", baseModelId: settings.baseModelId });
  return jsonOk({ baseModelId: settings.baseModelId });
}
